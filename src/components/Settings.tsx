import { useEffect, useState } from 'react';
import { enable, disable, isEnabled } from '@tauri-apps/plugin-autostart';
import { pingAll, type NodeProbe } from '../lib/node-picker';
import { clearAuth, setMode } from '../lib/store';
import type { AuthUser, Mode } from '../lib/types';

interface Props {
  mode: Mode;
  user: AuthUser | null;
  currentNode: NodeProbe | null;
  onModeChange: (m: Mode) => void;
  onNodesRefresh: () => void;
  onLogout: () => void;
}

export function Settings({ mode, user, currentNode, onModeChange, onNodesRefresh, onLogout }: Props) {
  const [autostart, setAutostart] = useState(false);
  const [nodes, setNodes] = useState<NodeProbe[]>([]);

  useEffect(() => {
    isEnabled().then(setAutostart).catch(() => setAutostart(false));
    pingAll().then(setNodes).catch(() => setNodes([]));
  }, []);

  const toggleAutostart = async () => {
    if (autostart) await disable();
    else await enable();
    setAutostart(!autostart);
  };

  const changeMode = async (m: Mode) => {
    await setMode(m);
    onModeChange(m);
  };

  const refreshNodes = async () => {
    const n = await pingAll();
    setNodes(n);
    onNodesRefresh();
  };

  const logout = async () => {
    await clearAuth();
    onLogout();
  };

  return (
    <div className="settings">
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
        <h3>Режим</h3>
        <div className="seg">
          <button className={mode === 'ct' ? 'active' : ''} onClick={() => changeMode('ct')}>КТ</button>
          <button className={mode === 'analysis' ? 'active' : ''} onClick={() => changeMode('analysis')}>Аналізи</button>
        </div>
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
    </div>
  );
}
