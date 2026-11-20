import { getCurrentWebview } from '@tauri-apps/api/webview';

type DropHandler = (paths: string[]) => void;

let activeHandler: DropHandler | null = null;
let unlistenFn: (() => void) | null = null;
// Файл тримають над вікном — підсвічуємо зону (Tauri не дає HTML5 dragover у webview)
const hoverListeners = new Set<(over: boolean) => void>();
const setHover = (over: boolean) => hoverListeners.forEach(fn => fn(over));

async function ensureListener() {
  if (unlistenFn) return;
  const wv = getCurrentWebview();
  unlistenFn = await wv.onDragDropEvent((event) => {
    const type = event.payload.type;
    if (type === 'enter' || type === 'over') { setHover(true); return; }
    setHover(false);
    if (type !== 'drop') return;
    const paths = event.payload.paths || [];
    if (paths.length === 0 || !activeHandler) return;
    try { activeHandler(paths); } catch (e) { console.error('[drop]', e); }
  });
}

/**
 * Реєструє єдиний активний обробник drag-drop файлів. Tauri v2 не
 * пропускає HTML5 drop у webview — payload приходить через event API.
 * useEffect кожного mode-компонента викликає це при mount + cleanup
 * при unmount; активним лишається лише змонтований компонент.
 */
export function onTauriDrop(handler: DropHandler): () => void {
  void ensureListener();
  activeHandler = handler;
  return () => {
    if (activeHandler === handler) activeHandler = null;
  };
}

/** Підписка на «файл над вікном» (для підсвічування зони). */
export function onDragHover(fn: (over: boolean) => void): () => void {
  void ensureListener();
  hoverListeners.add(fn);
  return () => { hoverListeners.delete(fn); };
}
