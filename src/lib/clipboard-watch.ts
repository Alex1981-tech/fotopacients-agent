import { readText } from '@tauri-apps/plugin-clipboard-manager';
import { invoke } from '@tauri-apps/api/core';

/**
 * Polling-watcher буферу обміну. Два джерела:
 *   1. HDROP (Windows CF_HDROP) — коли користувач робить Ctrl+C на файлах
 *      чи папках у Провіднику. Читаємо через Rust-команду `get_clipboard_files`
 *      (tauri clipboard plugin це не вміє).
 *   2. Plain text path — коли користувач робить «Copy as path»
 *      (Shift+правий клік або Ctrl+Shift+C у Windows 11).
 * Віддає всі шляхи (і папки — КТ часто копіюють папкою); що з них КТ чи
 * рентген, вирішує викликач (lib/imaging).
 */
const POLL_MS = 1200;
const PATH_RX = /^[A-Z]:\\[^\n\r]+$/i;

type Handler = (paths: string[]) => void;

// null — ще не читали: те, що лежало в буфері до старту агента, не показуємо.
let lastSeen: string | null = null;
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

async function readTextPaths(): Promise<string[]> {
  const txt = (await readText()) || '';
  return txt
    .split(/\r?\n/)
    .map(l => l.trim().replace(/^"|"$/g, ''))
    .filter(l => PATH_RX.test(l));
}

async function tick() {
  if (!handler) return;
  try {
    let paths = await readHdrop();
    if (paths.length === 0) paths = await readTextPaths();
    const key = paths.join('\n');
    const primed = lastSeen !== null;
    if (key === lastSeen) return;
    lastSeen = key;
    if (primed && key) handler(paths);
  } catch { /* ignore */ }
}

export function startClipboardWatch(onPaths: Handler): () => void {
  handler = onPaths;
  if (!timer) {
    timer = setInterval(() => { void tick(); }, POLL_MS);
  }
  return () => {
    if (handler === onPaths) handler = null;
    if (timer && !handler) { clearInterval(timer); timer = null; }
  };
}
