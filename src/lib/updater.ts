import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { queue } from './upload';

const CHECK_INTERVAL_MS = 60 * 60 * 1000;     // 1 година
const IDLE_POLL_MS = 5_000;                   // як часто перевіряти що черга порожня
const IDLE_MAX_WAIT_MS = 30 * 60 * 1000;      // максимум 30 хв чекаємо черги

/** Стан авто-оновлення — для видимого індикатора в UI (раніше помилки тихо
 *  йшли в console.error, тому «не оновлюється» було неможливо діагностувати). */
export type UpdateStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'uptodate' }
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; version: string }
  | { kind: 'pending-relaunch'; version: string }   // завантажено, чекаємо порожню чергу
  | { kind: 'error'; error: string };

type StatusCb = (s: UpdateStatus) => void;

let pendingRelaunch = false;
let pendingVersion = '';

function activeTasksCount(): number {
  return queue.list().filter(t => t.status === 'uploading' || t.status === 'queued').length;
}

async function waitForIdle(maxMs: number): Promise<boolean> {
  if (activeTasksCount() === 0) return true;
  return new Promise<boolean>(resolve => {
    const deadline = Date.now() + maxMs;
    const tick = () => {
      if (activeTasksCount() === 0) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tick, IDLE_POLL_MS);
    };
    setTimeout(tick, IDLE_POLL_MS);
  });
}

/**
 * Тихий чек і автоінсталь — але зі статусом у `onStatus` для UI.
 * Перезапуск ТІЛЬКИ коли upload-черга порожня (не уриваємо активні
 * завантаження). Помилки тепер видно в індикаторі, а не лише в console.
 */
export async function checkForUpdates(onStatus: StatusCb = () => {}): Promise<void> {
  try {
    if (pendingRelaunch) {
      onStatus({ kind: 'pending-relaunch', version: pendingVersion });
      if (await waitForIdle(IDLE_MAX_WAIT_MS)) await relaunch();
      return;
    }
    onStatus({ kind: 'checking' });
    const update = await check();
    if (!update) {
      onStatus({ kind: 'uptodate' });
      return;
    }
    console.info(`[updater] new version: ${update.version}`);
    onStatus({ kind: 'available', version: update.version });
    onStatus({ kind: 'downloading', version: update.version });
    await update.downloadAndInstall();
    pendingRelaunch = true;
    pendingVersion = update.version;
    onStatus({ kind: 'pending-relaunch', version: update.version });
    if (await waitForIdle(IDLE_MAX_WAIT_MS)) {
      await relaunch();
    } else {
      console.info('[updater] queue busy; relaunch postponed to next idle window');
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[updater] check failed:', e);
    onStatus({ kind: 'error', error: msg });
  }
}

/**
 * Перший виклик одразу при mount + кожну годину. `onStatus` оновлює UI-індикатор.
 * Cleanup при unmount.
 */
export function startAutoUpdate(onStatus: StatusCb = () => {}): () => void {
  const initial = setTimeout(() => { void checkForUpdates(onStatus); }, 5_000);
  const periodic = setInterval(() => { void checkForUpdates(onStatus); }, CHECK_INTERVAL_MS);
  return () => { clearTimeout(initial); clearInterval(periodic); };
}
