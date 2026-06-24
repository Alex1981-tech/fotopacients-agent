import { useEffect, useState } from 'react';
import { enable, disable, isEnabled } from '@tauri-apps/plugin-autostart';
import { probeAllStatus, type NodeProbe, type NodeStatus } from '../lib/node-picker';
import { checkForUpdates, type UpdateStatus } from '../lib/updater';
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
  const [nodes, setNodes] = useState<NodeStatus[]>([]);
  const [loadingNodes, setLoadingNodes] = useState(true);
  const [version, setVersion] = useState('');
  const [upd, setUpd] = useState<UpdateStatus>({ kind: 'idle' });
  const [err, setErr] = useState('');

  useEffect(() => {
    isEnabled().then(setAutostart).catch((e) => { console.error('[autostart isEnabled]', e); setAutostart(false); });
    refreshNodes();
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
    setLoadingNodes(true);
    try { const n = await probeAllStatus(); setNodes(n); onNodesRefresh(); }
    catch (e: any) { setErr(`Nodes: ${e?.message || e}`); setNodes([]); }
    finally { setLoadingNodes(false); }
  };

  const checkUpdates = async () => {
    setUpd({ kind: 'checking' });
    await checkForUpdates(setUpd);
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
        <div className="row">
          <h3>Ноди</h3>
          <button className="btn-secondary" onClick={refreshNodes} disabled={loadingNodes}>
            {loadingNodes ? 'Перевірка…' : 'Оновити'}
          </button>
        </div>
        <div className="muted small" style={{ marginBottom: 6 }}>
          Агент чіпляється до «своєї» ноди (🏠 — та сама мережа, найшвидше); якщо
          недоступна — до найшвидшої з решти.
        </div>
        <div className="nodes-list">
          {!loadingNodes && nodes.length === 0 && <div className="muted">Ноди недоступні</div>}
          {nodes.map(n => {
            const isActive = currentNode?.node.id === n.id;
            const status = !n.reachable ? 'down' : isActive ? 'active' : 'up';
            return (
              <div key={n.id} className={`node-row ${status}`}>
                <span className={`dot ${status}`} />
                <strong>{n.label}</strong>
                {n.isHome && <span className="badge home" title="Своя нода (ваша мережа)">🏠</span>}
                {isActive && <span className="badge conn" title="Активне підключення">● підключено</span>}
                <span className="muted small node-url"> {n.url}</span>
                <span className="ms">{n.reachable ? `${(n.ms ?? 0).toFixed(0)} мс` : 'недоступна'}</span>
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <h3>Запуск</h3>
        <label className="toggle">
          <input type="checkbox" checked={autostart} onChange={toggleAutostart} />
          <span>Запускати при вході в Windows (фоновий режим)</span>
        </label>
      </section>

      <section>
        <div className="row">
          <h3>Версія</h3>
          <button className="btn-secondary" onClick={checkUpdates} disabled={upd.kind === 'checking' || upd.kind === 'downloading'}>
            Перевірити оновлення
          </button>
        </div>
        <div className="muted">FotoPacients Agent v{version}</div>
        <UpdateLine status={upd} />
      </section>
    </div>
  );
}

function UpdateLine({ status }: { status: UpdateStatus }) {
  let text = 'Оновлення встановлюються автоматично — програма перезапуститься коли черга задач звільниться.';
  let cls = 'muted small';
  switch (status.kind) {
    case 'checking': text = 'Перевірка оновлень…'; break;
    case 'uptodate': text = '✓ Встановлена остання версія.'; break;
    case 'available': text = `Знайдено оновлення ${status.version}…`; break;
    case 'downloading': text = `Завантаження ${status.version}…`; break;
    case 'pending-relaunch': text = `Оновлення ${status.version} завантажено — перезапуск коли черга звільниться.`; break;
    case 'error': text = `⚠ Помилка оновлення: ${status.error}`; cls = 'settings-err'; break;
  }
  return <div className={cls} style={{ marginTop: 4 }}>{text}</div>;
}
