import { useCallback, useEffect, useRef, useState } from 'react';
import { ClipboardToast } from './components/ClipboardToast';
import { LoginScreen } from './components/LoginScreen';
import { Settings } from './components/Settings';
import { UploadQueue } from './components/UploadQueue';
import { UnifiedMode } from './modes/UnifiedMode';
import { setApi } from './lib/api';
import { pickFastest, probePinned, type NodeProbe } from './lib/node-picker';
import { clearAuth, getSettings, setSetting } from './lib/store';
import { startAutoUpdate, type UpdateStatus } from './lib/updater';
import { queue } from './lib/upload';
import type { AuthUser, LoginNode, PinnedNode } from './lib/types';
import pkg from '../package.json';

const APP_VERSION = (pkg as { version?: string }).version || '0.0.0';

// Чому агент має перелогінитись: нода прибитої сесії зникла з мережі, або
// робоча сесія завершилась (вікно 08–20 / новий день / токен відкликаний).
type Gate = 'node-down' | 'session-expired';

// Кінець сьогоднішнього робочого вікна локально (fallback, якщо бекенд не
// прислав session_expires_at).
function endOfTodayMs(hour: number): number {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

function toPinned(p: NodeProbe): PinnedNode {
  return { id: p.node.id, label: p.node.label, url: p.url };
}

function toLoginNode(p: NodeProbe): LoginNode {
  return { id: p.node.id, label: p.node.label, url: p.url, ms: p.ms };
}

export function App() {
  const [ready, setReady] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  // Прибита нода поточної сесії (після логіну) + її поточний ping.
  const [pinned, setPinned] = useState<PinnedNode | null>(null);
  const [nodeMs, setNodeMs] = useState<number | null>(null);
  // Нода, обрана для екрану входу (коли ще не залогінені).
  const [loginNode, setLoginNode] = useState<LoginNode | null>(null);
  const [sessionExpiresAt, setSessionExpiresAt] = useState<number | null>(null);
  const [gate, setGate] = useState<Gate | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ kind: 'idle' });

  // setGate зі стабільною ідентичністю — використовуємо в api.onUnauthorized.
  const setGateRef = useRef(setGate);
  setGateRef.current = setGate;

  // 401 з бекенду = протермінована/відкликана сесія або поза вікном 08–20.
  // НЕ перемикаємо ноду — показуємо перелогін.
  const handleUnauthorized = useCallback((body: { code?: string }) => {
    // node-down має пріоритет лише поки нода реально мертва; тут сесія/доступ,
    // тож завжди session-expired (агент і так піде на повторний логін).
    void body;
    setGateRef.current('session-expired');
  }, []);

  // Перейти на екран входу: чистимо сесію й перевибираємо ноду для логіну
  // (стара прибита могла зникнути — даємо обрати живу).
  const goToLogin = useCallback(async () => {
    await clearAuth();
    setToken(null);
    setUser(null);
    setPinned(null);
    setSessionExpiresAt(null);
    setNodeMs(null);
    setGate(null);
    setSettingsOpen(false);
    setApi({ token: null });
    const fastest = await pickFastest();
    const ln = fastest ? toLoginNode(fastest) : null;
    setLoginNode(ln);
    setApi({ baseUrl: ln?.url || '', token: null });
  }, []);

  // ── Bootstrap ────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      setApi({ onUnauthorized: handleUnauthorized });
      const s = await getSettings();
      await queue.hydrate();

      const sessionAlive =
        s.token && s.user && s.pinned_node &&
        (!s.session_expires_at || Date.now() < s.session_expires_at);

      if (sessionAlive && s.pinned_node) {
        setToken(s.token);
        setUser(s.user);
        setPinned(s.pinned_node);
        setSessionExpiresAt(s.session_expires_at);
        setApi({ baseUrl: s.pinned_node.url, token: s.token });
        const ms = await probePinned(s.pinned_node.url);
        setNodeMs(ms);
        if (ms === null) setGate('node-down');
        setReady(true);
        return;
      }

      // Сесії нема або вона протермінована за ніч — на екран входу.
      if (s.token) await clearAuth();
      const fastest = await pickFastest();
      const ln = fastest ? toLoginNode(fastest) : null;
      setLoginNode(ln);
      setApi({ baseUrl: ln?.url || '', token: null });
      setReady(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Health-check ПРИБИТОЇ ноди (без перемикання) ─────────────────
  useEffect(() => {
    if (!token || !pinned) return;
    const t = setInterval(async () => {
      const ms = await probePinned(pinned.url);
      setNodeMs(ms);
      setGate((g) => {
        if (g === 'session-expired') return g; // сесія важливіша за зв'язок
        if (ms === null) return 'node-down';
        return g === 'node-down' ? null : g;   // нода повернулась — знімаємо ґейт
      });
    }, 30_000);
    return () => clearInterval(t);
  }, [token, pinned]);

  // ── Таймер робочого вікна (клієнтський дубль серверного enforcement) ──
  useEffect(() => {
    if (!token || !sessionExpiresAt) return;
    const check = () => {
      if (Date.now() >= sessionExpiresAt) setGate('session-expired');
    };
    check();
    const t = setInterval(check, 30_000);
    return () => clearInterval(t);
  }, [token, sessionExpiresAt]);

  useEffect(() => {
    const stop = startAutoUpdate(setUpdateStatus);
    return stop;
  }, []);

  const handleLogin = async (tok: string, u: AuthUser, expiresAtIso?: string) => {
    const pin = loginNode
      ? { id: loginNode.id, label: loginNode.label, url: loginNode.url }
      : null;
    const expMs = expiresAtIso ? Date.parse(expiresAtIso) : endOfTodayMs(20);
    setToken(tok);
    setUser(u);
    setPinned(pin);
    setSessionExpiresAt(expMs);
    setGate(null);
    await setSetting('token', tok);
    await setSetting('user', u);
    await setSetting('pinned_node', pin);
    await setSetting('preferred_node_id', pin?.id ?? null);
    await setSetting('session_expires_at', expMs);
    setApi({ baseUrl: pin?.url || '', token: tok });
    const ms = await probePinned(pin?.url || '');
    setNodeMs(ms);
  };

  // Зміна ноди на екрані входу (ручний вибір зі списку).
  const handlePickLoginNode = (n: LoginNode) => {
    setLoginNode(n);
    setApi({ baseUrl: n.url, token: null });
  };

  if (!ready) return <div className="loading">Завантаження…</div>;
  if (!token || !user) {
    return (
      <LoginScreen
        node={loginNode}
        onPickNode={handlePickLoginNode}
        onLogin={handleLogin}
      />
    );
  }

  const fullName = `${user.first_name} ${user.last_name}`.trim() || user.username;
  const initials = (
    (user.first_name?.[0] || '') + (user.last_name?.[0] || '')
  ).toUpperCase() || user.username.slice(0, 2).toUpperCase();
  const offline = !pinned || nodeMs === null;
  const dotClass = offline ? 'offline' : nodeMs < 50 ? 'fast' : nodeMs < 200 ? 'mid' : 'slow';
  // NodeProbe-сумісний об'єкт для Settings (читає лише currentNode.node.id).
  const settingsNode: NodeProbe | null = pinned
    ? { node: { ...pinned }, url: pinned.url, ms: nodeMs ?? 0 }
    : null;

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

        <div className="conn-badge" title={pinned ? `${pinned.label} · ${pinned.url}` : 'Без зв\'язку'}>
          <span className={`dot ${dotClass}`} />
          {pinned ? (
            <>
              <span>Підключено до <strong>{pinned.label}</strong></span>
              {nodeMs !== null
                ? <span className="conn-ms">{nodeMs.toFixed(0)} мс</span>
                : <span className="conn-ms">недоступна</span>}
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
          <UnifiedMode nodeId={pinned?.id || 'unknown'} />
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
                currentNode={settingsNode}
                onNodesRefresh={async () => {
                  // Лише оновлюємо ping прибитої ноди — НЕ перемикаємось.
                  if (pinned) setNodeMs(await probePinned(pinned.url));
                }}
                onLogout={goToLogin}
              />
            </div>
          </div>
        </div>
      )}

      {gate && <ReloginGate gate={gate} onRelogin={goToLogin} />}
    </div>
  );
}

// Блокувальна модалка: нода зникла або сесія завершилась → треба перелогін.
function ReloginGate({ gate, onRelogin }: { gate: Gate; onRelogin: () => void }) {
  const isDown = gate === 'node-down';
  return (
    <div className="modal-overlay relogin-overlay">
      <div className="modal relogin-modal" onClick={e => e.stopPropagation()}>
        <div className="relogin-icon">{isDown ? '🔌' : '🕓'}</div>
        <h2>{isDown ? 'Нода недоступна' : 'Сесію завершено'}</h2>
        <p className="relogin-text">
          {isDown
            ? 'Зв\'язок із вашою нодою втрачено. Увійдіть знову, щоб обрати доступну ноду.'
            : 'Робоча сесія агента завершилась (робочий день 08:00–20:00). Увійдіть знову, щоб продовжити.'}
        </p>
        <button onClick={onRelogin}>Увійти знову</button>
      </div>
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
