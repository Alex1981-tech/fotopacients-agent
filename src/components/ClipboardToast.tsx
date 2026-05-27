import { useEffect, useState } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { startClipboardWatch } from '../lib/clipboard-watch';

interface Props {
  onOpen: (path: string) => void;
}

export function ClipboardToast({ onOpen }: Props) {
  const [path, setPath] = useState<string | null>(null);

  useEffect(() => {
    return startClipboardWatch(p => setPath(p));
  }, []);

  useEffect(() => {
    if (!path) return;
    const t = setTimeout(() => setPath(null), 12_000); // auto-hide 12с
    return () => clearTimeout(t);
  }, [path]);

  if (!path) return null;

  const fileName = path.split(/[\\/]/).pop() || path;
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  const isCT = ['zip', 'rar', '7z', 'isz'].includes(ext);

  const handleOpen = async () => {
    setPath(null);
    onOpen(path);
    try {
      const wv = getCurrentWebview();
      await wv.show();
      await wv.setFocus();
    } catch { /* ignore */ }
  };

  return (
    <div className="clip-toast" onClick={handleOpen}>
      <div className="clip-toast-icon">{isCT ? '📦' : '📋'}</div>
      <div className="clip-toast-body">
        <div className="clip-toast-title">У буфері файл</div>
        <div className="clip-toast-name">{fileName}</div>
      </div>
      <button className="clip-toast-cta">Завантажити →</button>
      <button
        className="clip-toast-close"
        onClick={e => { e.stopPropagation(); setPath(null); }}
        aria-label="Закрити"
      >✕</button>
    </div>
  );
}
