import { readFile, stat } from '@tauri-apps/plugin-fs';
import { load, Store } from '@tauri-apps/plugin-store';
import type { Mode, TaskStatus, UploadTask } from './types';
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
            t.status = 'failed';
            t.error = 'Перерване попереднім запуском — перетягніть файл знову, якщо потрібно';
            t.progress = 0;
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
    mode: Mode;
    patient_id: string;
    patient_name: string;
    appointment_id?: string;
    files: { path: string; name: string; size: number }[];
    node_id: string;
  }): UploadTask {
    const id = crypto.randomUUID();
    const task: UploadTask = {
      id,
      mode: opts.mode,
      patient_id: opts.patient_id,
      patient_name: opts.patient_name,
      appointment_id: opts.appointment_id,
      files: opts.files,
      status: 'queued',
      progress: 0,
      node_id: opts.node_id,
      retry_count: 0,
      created_at: Date.now(),
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
    try {
      const api = getApi();
      if (!api.baseUrl || !api.token) throw new Error('Не авторизовано');
      const fieldName = task.mode === 'ct' ? 'file' : 'photos';
      const form = new FormData();
      for (const f of task.files) {
        const bytes = await readFile(f.path);
        const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        form.append(fieldName, new Blob([buf]), f.name);
      }
      // force=true → backend збереже навіть якщо це дубль (user підтвердив).
      if (task.force) form.append('force', 'true');
      const path = task.mode === 'ct'
        ? `/api/agent/appointments/${task.appointment_id}/ct-upload/`
        : `/api/agent/patients/${task.patient_id}/upload-analysis/`;

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

      // Дубль — лишаємо статус 'duplicate', не позначаємо done (чекаємо forceUpload).
      if (task.status === 'duplicate') return;

      task.status = 'done';
      task.progress = 100;
      task.finished_at = Date.now();
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

  async addFile(path: string, opts: {
    mode: Mode;
    patient_id: string;
    patient_name: string;
    appointment_id?: string;
    node_id: string;
  }): Promise<UploadTask> {
    const fileName = path.split(/[\\/]/).pop() || 'file';
    const st = await stat(path);
    return this.enqueue({
      ...opts,
      files: [{ path, name: fileName, size: st.size }],
    });
  }
}

export const queue = new UploadQueue();
export type { TaskStatus };
