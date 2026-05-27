import { readText } from '@tauri-apps/plugin-clipboard-manager';
import { invoke } from '@tauri-apps/api/core';

/**
 * Polling-watcher буферу обміну. Два джерела:
 *   1. HDROP (Windows CF_HDROP) — коли користувач робить Ctrl+C на файлі
 *      у Провіднику. Читаємо через Rust-команду `get_clipboard_files`
 *      (tauri clipboard plugin це не вміє).
 *   2. Plain text path — коли користувач робить «Copy as path»
 *      (Shift+правий клік або Ctrl+Shift+C у Windows 11). Тут перевіряємо
 *      regex.
 */
const POLL_MS = 1200;
const PATH_RX = /^[A-Z]:\\[^\n\r]+\.(zip|rar|7z|isz|jpg|jpeg|png|webp|heic|heif|pdf|doc|docx|xls|xlsx|tif|tiff|mov|mp4|m4v)$/i;
const EXT_RX = /\.(zip|rar|7z|isz|jpg|jpeg|png|webp|heic|heif|pdf|doc|docx|xls|xlsx|tif|tiff|mov|mp4|m4v)$/i;

type Handler = (path: string) => void;

let lastSeen = '';
let timer: ReturnType<typeof setInterval> | null = null;
let handler: Handler | null = null;

async function readHdrop(): Promise<string[]> {
  try {
    const files = await invoke<string[]>('get_clipboard_files');
    return Array.isArray(files) ? files : [];
  } catch {
    return [];
  }
}

async function tick() {
  if (!handler) return;
  try {
    // 1) HDROP — копіювання файлу у Провіднику Windows (Ctrl+C на файлі).
    const files = await readHdrop();
    if (files.length > 0) {
      const first = files.find(f => EXT_RX.test(f));
      if (first && first !== lastSeen) {
        lastSeen = first;
        handler(first);
        return;
      }
    }
    // 2) Plain text — «Copy as path» (Shift+ПКМ).
    const txt = (await readText()) || '';
    if (!txt || txt === lastSeen) return;
    lastSeen = txt;
    const lines = txt.split(/\r?\n/).map(l => l.trim().replace(/^"|"$/g, '')).filter(Boolean);
    for (const line of lines) {
      if (PATH_RX.test(line)) {
        handler(line);
        return;
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
