import { useEffect, useState } from 'react';
import { fetch } from '@tauri-apps/plugin-http';
import { getApi } from '../lib/api';

// Фото пацієнта з альбому картки CC (нода FP бере його з Call Center і кешує). Немає фото — ініціали.
// Кеш на сесію: пошук перемальовує список на кожну літеру, а фото не міняється.
const cache = new Map<string, Promise<string | null>>();

function load(id: string): Promise<string | null> {
  let p = cache.get(id);
  if (!p) {
    const { baseUrl, token } = getApi();
    p = fetch(`${baseUrl}/api/patients/${id}/avatar/`, { headers: token ? { Authorization: `Token ${token}` } : {} })
      .then(async r => (r.ok ? URL.createObjectURL(await r.blob()) : null))
      .catch(() => null);
    cache.set(id, p);
  }
  return p;
}

const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';

export function PatientAvatar({ id, name, className }: { id: string; name: string; className: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setSrc(null);
    void load(id).then(url => { if (alive) setSrc(url); });
    return () => { alive = false; };
  }, [id]);
  return (
    <span className={className}>
      {src ? <img className="avatar-img" src={src} alt="" draggable={false} /> : initials(name)}
    </span>
  );
}
