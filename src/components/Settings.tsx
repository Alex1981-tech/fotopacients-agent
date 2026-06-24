import { useEffect, useState } from 'react';
import { enable, disable, isEnabled } from '@tauri-apps/plugin-autostart';
import { pingAll, type NodeProbe } from '../lib/node-picker';
import { clearAuth } from '../lib/store';
import { getVersion } from '@tauri-apps/api/app';
import type { AuthUser } from '../lib/types';

interface Props {
  user: AuthUser | null;
  currentNode: NodeProbe | null;
  onNodesRefresh: () => void;
  onLogout: () => void;
}

export function Settings({ user, currentNode, onNodesRefresh, onLogout }: Props) {
  const [autostart, setAutostart] = useState(false);
  const [nodes, setNodes] = useState<NodeProbe[]>([]);
  const [version, setVersion] = useState('');

  const [err, setErr] = useState('');

  useEffect(() => {
    isEnabled().then(setAutostart).catch((e) => { console.error('[autostart isEnabled]', e); setAutostart(false); });
    pingAll().then(setNodes).catch((e) => { console.error('[pingAll]', e); setNodes([]); });
    getVersion().then(setVersion).catch(() => setVersion(''));
  }, []);

  const toggleAutostart = async () => {
    setErr('');
    try {
      if (autostart) await disable(); else await enable();
      setAutostart(!autostart);
    } catch (e: any) { setErr(`Autostart: ${e?.message || e}`); }
  };

  const refreshNodes = async () => {
    setErr('');
    try { const n = await pingAll(); setNodes(n); onNodesRefresh(); }
    catch (e: any) { setErr(`Nodes: ${e?.message || e}`); }
  };

  const logout = async () => {
    setErr('');
    try { await clearAuth(); onLogout(); }
    catch (e: any) { setErr(`Logout: ${e?.message || e}`); }
  };

  return (
    <div className="settings">
      {err && <div className="settings-err">⚠ {err}</div>}
      <section>
        <h3>Користувач</h3>
        {user ? (
          <div className="row">
            <div>{user.first_name} {user.last_name} · <span className="muted">{user.role}</span></div>
            <button className="btn-secondary" onClick={logout}>Вийти</button>
          </div>
        ) : <div className="muted">не авторизовано</div>}
      </section>

      <section>
        <h3>Ноди (швидкість зʼєднання)</h3>
        <div className="nodes-list">
          {nodes.length === 0 && <div className="muted">Ноди недоступні</div>}
          {nodes.map(n => (
            <div key={n.node.id + n.url} className={`node-row ${currentNode?.node.id === n.node.id ? 'active' : ''}`}>
              <span className="dot" />
              <strong>{n.node.label}</strong>
              <span className="muted small"> · {n.url}</span>
              <span className="ms">{n.ms.toFixed(0)} мс</span>
            </div>
          ))}
        </div>
        <button className="btn-secondary" onClick={refreshNodes}>Оновити</button>
      </section>

      <section>
        <h3>Запуск</h3>
        <label className="toggle">
          <input type="checkbox" checked={autostart} onChange={toggleAutostart} />
          <span>Запускати при вході в Windows (фоновий режим)</span>
        </label>
      </section>

      <section>
        <h3>Версія</h3>
        <div className="muted">FotoPacients Agent v{version}</div>
        <div className="muted small">
          Оновлення встановлюються автоматично при наявності — програма
          перезавантажиться коли черга задач звільниться.
        </div>
      </section>
    </div>
  );
}
