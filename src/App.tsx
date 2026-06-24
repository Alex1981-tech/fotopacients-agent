import { useEffect, useState } from 'react';
import { ClipboardToast } from './components/ClipboardToast';
import { LoginScreen } from './components/LoginScreen';
import { Settings } from './components/Settings';
import { UploadQueue } from './components/UploadQueue';
import { UnifiedMode } from './modes/UnifiedMode';
import { setApi } from './lib/api';
import { pickFastest, type NodeProbe } from './lib/node-picker';
import { getSettings, setSetting } from './lib/store';
import { startAutoUpdate, type UpdateStatus } from './lib/updater';
import { queue } from './lib/upload';
import type { AuthUser } from './lib/types';
import pkg from '../package.json';

const APP_VERSION = (pkg as { version?: string }).version || '0.0.0';

export function App() {
  const [ready, setReady] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [node, setNode] = useState<NodeProbe | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ kind: 'idle' });

  useEffect(() => {
    (async () => {
      const s = await getSettings();
      setUser(s.user);
      setToken(s.token);
      // Hydrate історії завантажень з диску — щоб після перезапуску
      // користувач бачив, що було відправлено / провалилось.
      await queue.hydrate();
      const fastest = await pickFastest();
      if (fastest) {
        setNode(fastest);
        setApi({ baseUrl: fastest.url, token: s.token });
      } else {
        setApi({ baseUrl: '', token: s.token });
      }
      setReady(true);
    })();
  }, []);

  useEffect(() => {
    const t = setInterval(async () => {
      const f = await pickFastest();
      if (f && f.node.id !== node?.node.id) {
        setNode(f);
        setApi({ baseUrl: f.url, token });
      }
    }, 30_000);
    return () => clearInterval(t);
  }, [node, token]);

  useEffect(() => {
    const stop = startAutoUpdate(setUpdateStatus);
    return stop;
  }, []);

  const handleLogin = async (tok: string, u: AuthUser) => {
    setToken(tok); setUser(u);
    await setSetting('token', tok);
    await setSetting('user', u);
    setApi({ baseUrl: node?.url || '', token: tok });
  };

  const handleLogout = () => {
    setToken(null); setUser(null);
    setApi({ token: null });
    setSettingsOpen(false);
  };

  if (!ready) return <div className="loading">Завантаження…</div>;
  if (!token || !user) return <LoginScreen onLogin={handleLogin} />;

  const fullName = `${user.first_name} ${user.last_name}`.trim() || user.username;
  const initials = (
    (user.first_name?.[0] || '') + (user.last_name?.[0] || '')
  ).toUpperCase() || user.username.slice(0, 2).toUpperCase();
  const dotClass = !node ? 'offline' : node.ms < 50 ? 'fast' : node.ms < 200 ? 'mid' : 'slow';

  return (
    <div className="app">
      <header className="topbar">
        <div className="user-chip" title={user.username}>
          <span className="avatar">{initials}</span>
          <div className="user-meta">
            <div className="user-name">{fullName}</div>
            <div className="user-role">{user.role}</div>
          </div>
        </div>

        <div className="conn-badge" title={node ? `${node.node.label} · ${node.url}` : 'Без зв\'язку'}>
          <span className={`dot ${dotClass}`} />
          {node ? (
            <>
              <span>Підключено до <strong>{node.node.label}</strong></span>
              <span className="conn-ms">{node.ms.toFixed(0)} мс</span>
            </>
          ) : <span>Без зв'язку</span>}
        </div>

        <div className="topbar-right">
          <UpdatePill status={updateStatus} />
          <span className="version-pill" title="Версія додатку">v{APP_VERSION}</span>
          <button
            className="icon-btn"
            onClick={() => setSettingsOpen(true)}
            title="Налаштування"
            aria-label="Налаштування"
          >
            <SettingsIcon />
          </button>
        </div>
      </header>

      <main className="workspace">
        <section className="upload-pane">
          <UnifiedMode nodeId={node?.node.id || 'unknown'} />
        </section>
        <aside className="queue-pane">
          <h3>Задачі</h3>
          <UploadQueue />
        </aside>
      </main>

      <ClipboardToast onOpen={() => { /* path лишається в clipboard, юзер ще раз drop-не */ }} />

      {settingsOpen && (
        <div className="modal-overlay" onClick={() => setSettingsOpen(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Налаштування</h2>
              <button className="icon-btn" onClick={() => setSettingsOpen(false)} aria-label="Закрити">✕</button>
            </div>
            <div className="modal-body">
              <Settings
                user={user}
                currentNode={node}
                onNodesRefresh={async () => {
                  const f = await pickFastest();
                  if (f) { setNode(f); setApi({ baseUrl: f.url, token }); }
                }}
                onLogout={handleLogout}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function UpdatePill({ status }: { status: UpdateStatus }) {
  // idle / uptodate — нічого не показуємо (без шуму).
  if (status.kind === 'idle' || status.kind === 'uptodate') return null;
  let text = '';
  let cls = 'update-pill';
  let title = '';
  switch (status.kind) {
    case 'checking': text = 'Перевірка оновлень…'; break;
    case 'available': text = `Оновлення ${status.version}`; break;
    case 'downloading': text = `Завантаження ${status.version}…`; break;
    case 'pending-relaunch':
      text = `Оновлення ${status.version} — перезапуск після черги`;
      cls += ' ready';
      break;
    case 'error':
      text = 'Помилка оновлення';
      cls += ' error';
      title = status.error;  // повний текст у tooltip — для діагностики
      break;
  }
  return <span className={cls} title={title || text}>{text}</span>;
}

function SettingsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </svg>
  );
}
