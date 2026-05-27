import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { sendNotification, isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 годин

async function notify(title: string, body: string) {
  try {
    let perm = await isPermissionGranted();
    if (!perm) perm = (await requestPermission()) === 'granted';
    if (perm) sendNotification({ title, body });
  } catch { /* ignore — нотифікації не критичні */ }
}

/**
 * Перевіряє наявність оновлення. Якщо є — тихо завантажує + інсталює +
 * перезапускає програму. Користувач бачить нотифікацію перед рестартом.
 */
export async function checkForUpdates(silent = false): Promise<void> {
  try {
    const update = await check();
    if (!update) {
      if (!silent) await notify('FotoPacients Agent', 'Встановлена остання версія');
      return;
    }
    await notify(
      `Оновлення ${update.version}`,
      'Завантажуємо нову версію FotoPacients Agent…',
    );
    let downloaded = 0;
    let contentLength = 0;
    await update.downloadAndInstall(event => {
      if (event.event === 'Started') {
        contentLength = event.data.contentLength ?? 0;
      } else if (event.event === 'Progress') {
        downloaded += event.data.chunkLength;
      } else if (event.event === 'Finished') {
        // ready to relaunch
      }
      void downloaded; void contentLength;
    });
    await notify('Готово', 'Перезапуск для застосування оновлення…');
    // Коротка пауза щоб юзер встиг побачити нотифікацію
    setTimeout(() => { void relaunch(); }, 1500);
  } catch (e) {
    console.error('[updater] check failed:', e);
    if (!silent) await notify('FotoPacients Agent', 'Перевірити оновлення не вдалося');
  }
}

/**
 * Запускає періодичну перевірку оновлень кожні 6 годин у фоні.
 * Перший виклик — через 30 с після старту (щоб не блокувати UI на стартовому
 * пінгу нод/login). Повертає cleanup-функцію.
 */
export function startAutoUpdate(): () => void {
  const firstCheck = setTimeout(() => { void checkForUpdates(true); }, 30_000);
  const periodic = setInterval(() => { void checkForUpdates(true); }, CHECK_INTERVAL_MS);
  return () => { clearTimeout(firstCheck); clearInterval(periodic); };
}
