import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { startClipboardWatch } from '../lib/clipboard-watch';
import { classifyPaths, fileName, looksLikeXray } from '../lib/imaging';

interface Props {
  onOpen: (paths: string[]) => void;
}

interface Found {
  paths: string[];
  ct: number;
  xray: number;
}

/** Скопіювали КТ чи рентген → агент сам виринає з трею з пропозицією завантажити. */
export function ClipboardToast({ onOpen }: Props) {
  const [found, setFound] = useState<Found | null>(null);

  useEffect(() => {
    return startClipboardWatch(async (paths) => {
      const c = await classifyPaths(paths);
      const xrays: string[] = [];
      for (const p of c.images) {
        if (await looksLikeXray(p)) xrays.push(p);
      }
      if (c.ct.length === 0 && xrays.length === 0) return;
      setFound({ paths: [...c.ct, ...xrays], ct: c.ct.length, xray: xrays.length });
      try { await invoke('show_window'); } catch { /* ignore */ }
    });
  }, []);

  useEffect(() => {
    if (!found) return;
    const t = setTimeout(() => setFound(null), 30_000);
    return () => clearTimeout(t);
  }, [found]);

  if (!found) return null;

  const title = [
    found.ct ? `КТ: ${found.ct}` : '',
    found.xray ? `рентген: ${found.xray}` : '',
  ].filter(Boolean).join(' · ');
  const names = found.paths.map(fileName);

  const handleOpen = () => {
    setFound(null);
    onOpen(found.paths);
  };

  return (
    <div className="clip-toast" onClick={handleOpen}>
      <div className="clip-toast-icon">{found.ct ? '📦' : '🦷'}</div>
      <div className="clip-toast-body">
        <div className="clip-toast-title">У буфері {title}</div>
        <div className="clip-toast-name">
          {names[0]}{names.length > 1 && ` +${names.length - 1}`}
        </div>
      </div>
      <button className="clip-toast-cta">Завантажити →</button>
      <button
        className="clip-toast-close"
        onClick={e => { e.stopPropagation(); setFound(null); }}
        aria-label="Закрити"
      >✕</button>
    </div>
  );
}
