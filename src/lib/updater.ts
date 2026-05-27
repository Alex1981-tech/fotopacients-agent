import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { queue } from './upload';

const CHECK_INTERVAL_MS = 60 * 60 * 1000;     // 1 година
const IDLE_POLL_MS = 5_000;                   // як часто перевіряти що черга порожня
const IDLE_MAX_WAIT_MS = 30 * 60 * 1000;      // максимум 30 хв чекаємо черги; якщо не дочекались — лишаємо до наступного check

let pendingRelaunch = false;

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
 * Тихий чек і автоінсталь. Без жодних notification / popup-ів.
 * Якщо новинки нема — мовчки повертається.
 * Якщо є — завантажує і інсталює.
 * Перезапуск ТІЛЬКИ коли upload-черга порожня (не уриваємо активні
 * завантаження). Якщо за 30 хв черга не звільнилась — лишаємо
 * pendingRelaunch=true і при наступному idle-check перезапускаємось.
 */
export async function checkForUpdates(): Promise<void> {
  try {
    // Якщо вже є downloaded update що чекає relaunch — просто try relaunch
    if (pendingRelaunch) {
      if (await waitForIdle(IDLE_MAX_WAIT_MS)) {
        await relaunch();
      }
      return;
    }
    const update = await check();
    if (!update) return;
    console.info(`[updater] new version: ${update.version}`);
    await update.downloadAndInstall();
    pendingRelaunch = true;
    if (await waitForIdle(IDLE_MAX_WAIT_MS)) {
      await relaunch();
    } else {
      console.info('[updater] queue busy; relaunch postponed to next idle window');
    }
  } catch (e) {
    console.error('[updater] check failed:', e);
  }
}

/**
 * Перший виклик одразу при mount + кожну годину.
 * Cleanup при unmount.
 */
export function startAutoUpdate(): () => void {
  // Невеличка затримка щоб не блокувати UI startup ping/login
  const initial = setTimeout(() => { void checkForUpdates(); }, 5_000);
  const periodic = setInterval(() => { void checkForUpdates(); }, CHECK_INTERVAL_MS);
  return () => { clearTimeout(initial); clearInterval(periodic); };
}
