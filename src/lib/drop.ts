import { getCurrentWebview } from '@tauri-apps/api/webview';

type DropHandler = (paths: string[]) => void;

let activeHandler: DropHandler | null = null;
let unlistenFn: (() => void) | null = null;

async function ensureListener() {
  if (unlistenFn) return;
  const wv = getCurrentWebview();
  unlistenFn = await wv.onDragDropEvent((event) => {
    if (event.payload.type !== 'drop') return;
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
