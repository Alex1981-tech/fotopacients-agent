import { useEffect, useState } from 'react';
import { LoginScreen } from './components/LoginScreen';
import { Settings } from './components/Settings';
import { UploadQueue } from './components/UploadQueue';
import { CTMode } from './modes/CTMode';
import { AnalysisMode } from './modes/AnalysisMode';
import { setApi } from './lib/api';
import { pickFastest, type NodeProbe } from './lib/node-picker';
import { getSettings, setSetting } from './lib/store';
import type { AuthUser, Mode } from './lib/types';

type Tab = 'main' | 'queue' | 'settings';

export function App() {
  const [ready, setReady] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [mode, setMode] = useState<Mode>('ct');
  const [node, setNode] = useState<NodeProbe | null>(null);
  const [tab, setTab] = useState<Tab>('main');

  // 1) load settings → set API base + token
  useEffect(() => {
    (async () => {
      const s = await getSettings();
      setMode(s.mode);
      setUser(s.user);
      setToken(s.token);
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

  // 2) фоновий health-check кожні 30 с
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

  const handleLogin = async (tok: string, u: AuthUser) => {
    setToken(tok); setUser(u);
    await setSetting('token', tok);
    await setSetting('user', u);
    setApi({ baseUrl: node?.url || '', token: tok });
  };

  const handleLogout = () => {
    setToken(null); setUser(null);
    setApi({ token: null });
    setTab('main');
  };

  if (!ready) return <div className="loading">Завантаження…</div>;
  if (!token || !user) return <LoginScreen onLogin={handleLogin} />;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">📷</span>
          <span>FotoPacients</span>
          <span className="pill">{mode === 'ct' ? 'КТ' : 'Аналізи'}</span>
        </div>
        <div className="node-status">
          {node ? (
            <>
              <span className={`status-dot ${node.ms < 50 ? 'fast' : node.ms < 200 ? 'mid' : 'slow'}`} />
              <span>{node.node.label}</span>
              <span className="muted small">{node.ms.toFixed(0)} мс</span>
            </>
          ) : <span className="muted">Без зв'язку</span>}
        </div>
      </header>

      <nav className="tabs">
        <button onClick={() => setTab('main')} className={tab === 'main' ? 'active' : ''}>Завантажити</button>
        <button onClick={() => setTab('queue')} className={tab === 'queue' ? 'active' : ''}>Задачі</button>
        <button onClick={() => setTab('settings')} className={tab === 'settings' ? 'active' : ''}>Налаштування</button>
      </nav>

      <main className="content">
        {tab === 'main' && (mode === 'ct' ? <CTMode nodeId={node?.node.id || 'unknown'} /> : <AnalysisMode nodeId={node?.node.id || 'unknown'} />)}
        {tab === 'queue' && <UploadQueue />}
        {tab === 'settings' && (
          <Settings
            mode={mode}
            user={user}
            currentNode={node}
            onModeChange={setMode}
            onNodesRefresh={async () => { const f = await pickFastest(); if (f) { setNode(f); setApi({ baseUrl: f.url, token }); } }}
            onLogout={handleLogout}
          />
        )}
      </main>
    </div>
  );
}
