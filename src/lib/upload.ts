import { readFile, stat } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { load, Store } from '@tauri-apps/plugin-store';
import type { ImagingKind, TaskStatus, UploadTask } from './types';
import { getApi } from './api';

// Використовуємо НАТИВНИЙ window.fetch — tauri-plugin-http fetch не вміє
// FormData з великими файлами (multipart body не стрімиться). CSP у нашій
// конфігурації дозволяє http(s) connect-src для всіх адрес.

const MAX_PARALLEL = 3;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 30_000;

const HISTORY_FILE = 'upload-history.json';
const HISTORY_KEY = 'tasks';
const HISTORY_LIMIT = 500;

type Listener = (tasks: UploadTask[]) => void;

class UploadQueue {
  private tasks = new Map<string, UploadTask>();
  private running = new Set<string>();
  private listeners = new Set<Listener>();
  private store: Store | null = null;
  private hydrating = false;

  /** Завантаження історії з диску при старті — викликається з App.tsx
      одразу після того як user залогінився. Безпечно викликати кілька разів. */
  async hydrate(): Promise<void> {
    if (this.hydrating || this.store) return;
    this.hydrating = true;
    try {
      this.store = await load(HISTORY_FILE, { autoSave: false, defaults: {} });
      const saved = await this.store.get<UploadTask[]>(HISTORY_KEY);
      if (Array.isArray(saved)) {
        for (const t of saved) {
          // 'queued' / 'uploading' під час старту — недосяжні файли (path
          // міг бути видалений / агент закрився посередині). Позначаємо як
          // failed, користувач сам вирішить retry / прибрати.
          if (t.status === 'queued' || t.status === 'uploading') {
            if (t.kind === 'ct') {
              // КТ докачується з того місця, де зупинилось (див. resumePending)
              t.status = 'queued';
              t.stage = undefined;
              t.retry_count = 0;
            } else {
              t.status = 'failed';
              t.error = 'Перерване попереднім запуском — перетягніть файл знову, якщо потрібно';
              t.progress = 0;
            }
          }
          this.tasks.set(t.id, t);
        }
        this.notify();
      }
    } catch (e) {
      console.warn('upload history hydrate failed', e);
    } finally {
      this.hydrating = false;
    }
  }

  private async persist(): Promise<void> {
    if (!this.store) return;
    try {
      // Зберігаємо до HISTORY_LIMIT найновіших — щоб файл не ріс безмежно.
      const sorted = this.list().slice(0, HISTORY_LIMIT);
      await this.store.set(HISTORY_KEY, sorted);
      await this.store.save();
    } catch (e) {
      console.warn('upload history persist failed', e);
    }
  }

  async clearHistory(filter?: (t: UploadTask) => boolean): Promise<void> {
    if (filter) {
      for (const t of [...this.tasks.values()]) {
        if (this.running.has(t.id)) continue;
        if (filter(t)) this.tasks.delete(t.id);
      }
    } else {
      // Прибираємо лише завершені (done/failed) — активні не чіпаємо.
      for (const t of [...this.tasks.values()]) {
        if (t.status === 'done' || t.status === 'failed') {
          this.tasks.delete(t.id);
        }
      }
    }
    this.notify();
    void this.persist();
  }

  /** Після входу: продовжити незавершені КТ попереднього запуску. */
  resumePending() {
    this.tick();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.list());
    return () => this.listeners.delete(fn);
  }

  list(): UploadTask[] {
    return [...this.tasks.values()].sort((a, b) => b.created_at - a.created_at);
  }

  private notify() {
    const snap = this.list();
    for (const l of this.listeners) l(snap);
    // Зберігаємо у persistent store. void щоб не блокувати notify.
    void this.persist();
  }

  enqueue(opts: {
    kind: ImagingKind;
    patient_id: string;
    patient_name: string;
    files: { path: string; name: string; size: number }[];
    node_id: string;
    temp_zip?: string;
  }): UploadTask {
    const id = crypto.randomUUID();
    const task: UploadTask = {
      id,
      kind: opts.kind,
      patient_id: opts.patient_id,
      patient_name: opts.patient_name,
      files: opts.files,
      status: 'queued',
      progress: 0,
      node_id: opts.node_id,
      retry_count: 0,
      created_at: Date.now(),
      temp_zip: opts.temp_zip,
    };
    this.tasks.set(id, task);
    this.notify();
    this.tick();
    return task;
  }

  retry(taskId: string) {
    const t = this.tasks.get(taskId);
    if (!t) return;
    t.status = 'queued';
    t.error = undefined;
    t.progress = 0;
    this.notify();
    this.tick();
  }

  /** «Все одно завантажити» — повторити з force=true попри дубль. */
  forceUpload(taskId: string) {
    const t = this.tasks.get(taskId);
    if (!t) return;
    t.force = true;
    t.status = 'queued';
    t.duplicates = undefined;
    t.error = undefined;
    t.progress = 0;
    t.finished_at = undefined;
    this.notify();
    this.tick();
  }

  remove(taskId: string) {
    if (this.running.has(taskId)) return;
    const t = this.tasks.get(taskId);
    if (t?.temp_zip) void invoke('remove_temp_zip', { path: t.temp_zip }).catch(() => {});
    if (t?.server_upload_id && t.status !== 'done') {
      // незавершене на ноді — скасовуємо, щоб частини не лежали 48 год
      const api = getApi();
      if (api.baseUrl && api.token) {
        void window.fetch(`${api.baseUrl}/api/agent/uploads/${t.server_upload_id}/`, {
          method: 'DELETE', headers: { Authorization: `Token ${api.token}` } }).catch(() => {});
      }
    }
    this.tasks.delete(taskId);
    this.notify();
  }

  private tick() {
    if (this.running.size >= MAX_PARALLEL) return;
    const next = [...this.tasks.values()]
      .filter(t => t.status === 'queued')
      .sort((a, b) => a.created_at - b.created_at)[0];
    if (!next) return;
    this.running.add(next.id);
    next.status = 'uploading';
    this.notify();
    this.run(next).finally(() => {
      this.running.delete(next.id);
      this.tick();
    });
    // Запускаємо ще одну якщо можемо
    this.tick();
  }

  private async run(task: UploadTask): Promise<void> {
    if (task.kind === 'ct') return this.runChunked(task);
    return this.runSingle(task);
  }

  /** Одним запитом (рентгени; КТ — лише якщо нода ще без частинного завантаження) */
  private async runSingle(task: UploadTask): Promise<void> {
    try {
      const api = getApi();
      if (!api.baseUrl || !api.token) throw new Error('Не авторизовано');
      if (!task.kind) {
        // Задача з версії до 0.2.0 (аналізи) — такий потік прибрано.
        task.status = 'failed';
        task.error = 'Аналізи більше не завантажуються агентом';
        task.finished_at = Date.now();
        this.notify();
        return;
      }
      const form = new FormData();
      form.append('kind', task.kind);
      for (const f of task.files) {
        const bytes = await readFile(f.path);
        const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        form.append('photos', new Blob([buf]), f.name);
      }
      // force=true → backend збереже навіть якщо це дубль (user підтвердив).
      if (task.force) form.append('force', 'true');
      const path = `/api/agent/patients/${task.patient_id}/upload-imaging/`;

      task.progress = 0;
      this.notify();

      // XMLHttpRequest замість fetch — щоб отримувати real upload progress
      // (window.fetch не дає upload progress events).
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${api.baseUrl}${path}`);
        xhr.setRequestHeader('Authorization', `Token ${api.token}`);
        xhr.responseType = 'text';

        const start = performance.now();
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 100);
            const elapsedS = (performance.now() - start) / 1000;
            const mbps = elapsedS > 0 ? (e.loaded / 1024 / 1024) / elapsedS : 0;
            task.progress = pct;
            task.speed_mbps = mbps;
            this.notify();
          }
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            task.progress = 100;
            this.notify();
            resolve();
          } else if (xhr.status === 409) {
            // Backend знайшов дубль(і) — не помилка, чекаємо рішення user'а.
            try {
              const data = JSON.parse(xhr.responseText);
              task.duplicates = Array.isArray(data.duplicates) ? data.duplicates : [];
            } catch { task.duplicates = []; }
            task.status = 'duplicate';
            task.finished_at = Date.now();
            this.notify();
            resolve();
          } else if (xhr.status === 400) {
            // Сервер відхилив файл (не КТ / не зображення) — повтор не допоможе.
            let msg = xhr.responseText;
            try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* текст як є */ }
            task.status = 'failed';
            task.error = String(msg).slice(0, 200);
            task.finished_at = Date.now();
            this.notify();
            resolve();
          } else {
            reject(new Error(`HTTP ${xhr.status}: ${String(xhr.responseText).slice(0, 200)}`));
          }
        };
        xhr.onerror = () => reject(new Error('Network error'));
        xhr.ontimeout = () => reject(new Error('Timeout'));
        // Timeout 30 хв для великих КТ через VPN
        xhr.timeout = 30 * 60 * 1000;
        xhr.send(form);
      });

      // Дубль чекає forceUpload; відхилений сервером файл — уже failed.
      if (task.status === 'duplicate' || task.status === 'failed') return;

      task.status = 'done';
      task.progress = 100;
      task.finished_at = Date.now();
      if (task.temp_zip) {
        await invoke('remove_temp_zip', { path: task.temp_zip }).catch(() => {});
        task.temp_zip = undefined;
      }
      this.notify();
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      task.error = err;
      task.retry_count += 1;
      if (task.retry_count < MAX_RETRIES) {
        task.status = 'queued';
        this.notify();
        setTimeout(() => this.tick(), RETRY_BACKOFF_MS);
      } else {
        task.status = 'failed';
        task.finished_at = Date.now();
        this.notify();
      }
    }
  }

  /**
   * КТ частинами по 8 МБ з докачуванням (20.11.2026). Файл не читається в пам'ять цілком:
   * SHA-256 і частини — нативно (Rust). Обрив зв'язку — частину повторюємо з паузою, скільки треба;
   * перезапуск агента — нода віддає, скільки вже прийнято, і йдемо далі.
   */
  private async runChunked(task: UploadTask): Promise<void> {
    const api = getApi();
    if (!api.baseUrl || !api.token) {
      task.status = 'queued';
      task.stage = undefined;
      this.notify();
      return;  // повернемось після входу (resumePending)
    }
    const file = task.files[0];
    const headers = { Authorization: `Token ${api.token}` };
    const url = (p: string) => `${api.baseUrl}/api/agent/uploads/${p}`;
    const fail = (msg: string) => {
      task.status = 'failed';
      task.stage = undefined;
      task.error = msg.slice(0, 300);
      task.finished_at = Date.now();
      this.notify();
    };
    const json = async (r: Response) => { try { return await r.json(); } catch { return {}; } };
    try {
      if (!task.sha256) {
        task.stage = 'hashing';
        this.notify();
        task.sha256 = await invoke<string>('file_sha256', { path: file.path });
      }
      task.stage = 'uploading';
      this.notify();
      const start = await this.retrying(task, () => window.fetch(url(''), {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ patient_id: task.patient_id, kind: 'ct', filename: file.name, size: file.size,
                               sha256: task.sha256, force: !!task.force }),
      }));
      if (start.status === 404) {
        // Нода ще не оновлена (частинне завантаження з'явилось у FP разом з агентом 0.3) — як раніше
        task.stage = undefined;
        this.notify();
        return this.runSingle(task);
      }
      const st = await json(start);
      if (start.status === 409) {
        task.duplicates = Array.isArray(st.duplicates) ? st.duplicates : [];
        task.status = 'duplicate';
        task.stage = undefined;
        task.finished_at = Date.now();
        this.notify();
        return;
      }
      if (!start.ok) return fail(st.error || st.detail || `HTTP ${start.status}`);
      task.server_upload_id = st.id;
      const chunk: number = st.chunk_size;
      const total = Math.ceil(file.size / chunk);
      let n: number = st.parts + 1;
      const t0 = performance.now();
      let sent = 0;
      while (n <= total) {
        const offset = (n - 1) * chunk;
        const len = Math.min(chunk, file.size - offset);
        const bytes = await invoke<ArrayBuffer>('read_chunk', { path: file.path, offset, len });
        const r = await this.retrying(task, () => window.fetch(url(`${st.id}/parts/${n}/`), {
          method: 'PUT', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: bytes,
        }));
        const body = await json(r);
        if (r.status === 409 && typeof body.parts === 'number') { n = body.parts + 1; continue; }  // зсув — беремо стан ноди
        if (!r.ok) return fail(body.error || body.detail || `HTTP ${r.status}`);
        sent += len;
        task.uploaded_bytes = body.received;
        task.progress = Math.min(99, Math.round((body.received / file.size) * 100));
        const s = (performance.now() - t0) / 1000;
        task.speed_mbps = s > 0 ? sent / 1024 / 1024 / s : 0;
        this.notify();
        n += 1;
      }
      task.stage = 'finishing';
      this.notify();
      const done = await this.retrying(task, () => window.fetch(url(`${st.id}/complete/`), { method: 'POST', headers }));
      const res = await json(done);
      if (!done.ok) return fail(res.error || res.detail || `HTTP ${done.status}`);
      task.status = 'done';
      task.stage = undefined;
      task.progress = 100;
      task.finished_at = Date.now();
      if (task.temp_zip) {
        await invoke('remove_temp_zip', { path: task.temp_zip }).catch(() => {});
        task.temp_zip = undefined;
      }
      this.notify();
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  }

  /** Запит із повторами при обриві зв'язку / 5xx: пауза росте до 60 с, ~15 хв спроб на одну дію. */
  private async retrying(task: UploadTask, send: () => Promise<Response>): Promise<Response> {
    let wait = 2000;
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await send();
        if (r.status < 500) {
          if (task.stage === 'waiting_net') { task.stage = 'uploading'; this.notify(); }
          return r;
        }
      } catch { /* мережа */ }
      if (attempt >= 20) throw new Error('Немає зв\'язку з сервером — натисніть «Повторити», завантаження продовжиться з місця зупинки');
      task.stage = 'waiting_net';
      this.notify();
      await new Promise(res => setTimeout(res, wait));
      wait = Math.min(wait * 2, 60_000);
    }
  }

  async addFile(path: string, opts: {
    kind: ImagingKind;
    patient_id: string;
    patient_name: string;
    node_id: string;
    /** Назва для показу й на сервері (папка КТ → «<папка>.zip», а не тимчасове ім'я) */
    display_name?: string;
    temp_zip?: boolean;
  }): Promise<UploadTask> {
    const fileName = opts.display_name || path.split(/[\\/]/).pop() || 'file';
    const st = await stat(path);
    const { display_name: _d, temp_zip, ...rest } = opts;
    return this.enqueue({
      ...rest,
      files: [{ path, name: fileName, size: st.size }],
      temp_zip: temp_zip ? path : undefined,
    });
  }
}

export const queue = new UploadQueue();
export type { TaskStatus };
