import { readText } from '@tauri-apps/plugin-clipboard-manager';

/**
 * Простий polling-watcher буферу обміну. Tauri clipboard plugin не дає
 * file-paths напряму (тільки text). Тому слідкуємо за text — якщо там
 * щось схоже на абсолютний Windows path до файлу (C:\..., D:\...) —
 * пропонуємо завантажити.
 */
const POLL_MS = 1500;
const PATH_RX = /^[A-Z]:\\[^\n\r]+\.(zip|rar|7z|isz|jpg|jpeg|png|webp|heic|pdf)$/i;

type Handler = (path: string) => void;

let lastSeen = '';
let timer: ReturnType<typeof setInterval> | null = null;
let handler: Handler | null = null;

async function tick() {
  if (!handler) return;
  try {
    const txt = (await readText()) || '';
    if (!txt || txt === lastSeen) return;
    lastSeen = txt;
    // Може бути кілька рядків з path-ами
    const lines = txt.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (PATH_RX.test(line)) {
        handler(line);
        return; // показуємо лише перший
      }
    }
  } catch { /* ignore */ }
}

export function startClipboardWatch(onPath: Handler): () => void {
  handler = onPath;
  if (!timer) {
    timer = setInterval(() => { void tick(); }, POLL_MS);
  }
  return () => {
    if (handler === onPath) handler = null;
    if (timer && !handler) { clearInterval(timer); timer = null; }
  };
}
