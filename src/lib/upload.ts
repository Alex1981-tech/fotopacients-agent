import { readFile, stat } from '@tauri-apps/plugin-fs';
import { fetch } from '@tauri-apps/plugin-http';
import type { Mode, TaskStatus, UploadTask } from './types';
import { getApi } from './api';

const MAX_PARALLEL = 3;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 30_000;

type Listener = (tasks: UploadTask[]) => void;

class UploadQueue {
  private tasks = new Map<string, UploadTask>();
  private running = new Set<string>();
  private listeners = new Set<Listener>();

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
      const form = new FormData();
      for (const f of task.files) {
        const bytes = await readFile(f.path);
        // Гарантуємо ArrayBuffer (Blob не приймає Uint8Array на ArrayBufferLike напряму)
        const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        form.append('photos', new Blob([buf]), f.name);
      }
      const path = task.mode === 'ct'
        ? `/api/appointments/${task.appointment_id}/ct-upload/`
        : `/api/agent/patients/${task.patient_id}/upload-analysis/`;

      task.progress = 10;
      this.notify();

      const resp = await fetch(`${api.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Authorization': `Token ${api.token}` },
        body: form,
      });

      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 200)}`);
      }

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
