import { useEffect, useRef, useState } from 'react';
import { hostname } from '@tauri-apps/plugin-os';
import { QRCodeSVG } from 'qrcode.react';
import { auth } from '../lib/api';
import { probeAllStatus } from '../lib/node-picker';
import type { AuthUser, LoginNode } from '../lib/types';

// Той самий бот, що й у web-фотопацієнті. Код для входу приходить у цей
// Telegram-бот — співробітник має спершу його запустити й прив'язати номер.
const BOT_LINK = 'https://t.me/Clinical_Photo_bot?start=link';

interface Props {
  // Нода, через яку відбудеться вхід (авто-вибір: домашня → найшвидша).
  node: LoginNode | null;
  // Ручний вибір іншої ноди зі списку (перед введенням коду).
  onPickNode: (n: LoginNode) => void;
  onLogin: (token: string, user: AuthUser, sessionExpiresAt?: string) => void;
}

export function LoginScreen({ node, onPickNode, onLogin }: Props) {
  // QR — основний вхід (як у UNIQO): скануєш, у боті «Увійти», і все. Номер + код — запасний.
  const [mode, setMode] = useState<'qr' | 'phone'>('qr');
  const [phone, setPhone] = useState('+380');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [nodes, setNodes] = useState<LoginNode[]>([]);
  const [loadingNodes, setLoadingNodes] = useState(false);

  const togglePicker = async () => {
    const next = !pickerOpen;
    setPickerOpen(next);
    if (next && nodes.length === 0) {
      setLoadingNodes(true);
      try {
        const list = await probeAllStatus();
        setNodes(list.map(n => ({ id: n.id, label: n.label, url: n.url, ms: n.ms })));
      } catch (e: any) {
        setError(`Ноди: ${e?.message || e}`);
      } finally {
        setLoadingNodes(false);
      }
    }
  };

  const requestCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!node) { setError('Нема доступної ноди — перевірте мережу'); return; }
    setLoading(true);
    try {
      const r = await auth.requestCode(phone);
      if (r.status === 'code_sent') setStep('code');
      else setError(r.detail || 'Помилка');
    } catch (e: any) {
      setError(e?.message || 'Помилка');
    } finally {
      setLoading(false);
    }
  };

  const verifyCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const r = await auth.verifyCode(phone, code);
      onLogin(r.token, r.user, r.session_expires_at);
    } catch (e: any) {
      setError(e?.message || 'Помилка');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="brand-mark login-mark" aria-hidden="true">FP</div>
        <h1>FotoPacients · агент</h1>

        <NodeBanner
          node={node}
          open={pickerOpen}
          nodes={nodes}
          loading={loadingNodes}
          onToggle={togglePicker}
          onPick={(n) => { onPickNode(n); setPickerOpen(false); }}
        />

        {mode === 'qr' ? (
          <QrLogin key={node?.id ?? 'none'} node={node} onLogin={onLogin} onUnsupported={() => setMode('phone')} />
        ) : step === 'phone' ? (
          <form onSubmit={requestCode}>
            <label>Телефон</label>
            <input
              type="tel"
              value={phone}
              onChange={e => setPhone(e.target.value)}
              placeholder="+380XXXXXXXXX"
              autoFocus
            />
            <button type="submit" disabled={loading || phone.length < 10 || !node}>
              {loading ? 'Надсилаємо…' : 'Отримати код у Telegram'}
            </button>
            {error && <div className="login-err">{error}</div>}
            <div className="login-hint">
              Немає бота? Відкрийте <a href={BOT_LINK} target="_blank" rel="noreferrer" className="link">@Clinical_Photo_bot</a>,
              натисніть «Старт» і поділіться номером.
            </div>
          </form>
        ) : (
          <form onSubmit={verifyCode}>
            <label>Код з Telegram</label>
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={code}
              onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
              placeholder="123456"
              autoFocus
            />
            <button type="submit" disabled={loading || code.length !== 6}>
              {loading ? 'Перевіряємо…' : 'Увійти'}
            </button>
            <button type="button" className="link" onClick={() => { setStep('phone'); setCode(''); setError(''); }}>
              ← Інший номер
            </button>
            {error && <div className="login-err">{error}</div>}
          </form>
        )}

        <button type="button" className="link login-switch" onClick={() => setMode(m => (m === 'qr' ? 'phone' : 'qr'))}>
          {mode === 'qr' ? 'Увійти за номером телефону' : 'Увійти за QR-кодом'}
        </button>
      </div>
    </div>
  );
}

type QrState = { kind: 'loading' } | { kind: 'show'; url: string; token: string; until: number }
  | { kind: 'scanned'; token: string } | { kind: 'denied' } | { kind: 'error'; text: string };

/** QR на бота: код живе 3 хв і оновлюється сам; після скану — «підтвердіть у Telegram». */
function QrLogin({ node, onLogin, onUnsupported }: {
  node: LoginNode | null;
  onLogin: Props['onLogin'];
  onUnsupported: () => void;
}) {
  const [st, setSt] = useState<QrState>({ kind: 'loading' });
  const [now, setNow] = useState(Date.now());
  const alive = useRef(true);

  const fresh = async () => {
    if (!node) { setSt({ kind: 'error', text: 'Нема доступної ноди — перевірте мережу' }); return; }
    setSt({ kind: 'loading' });
    let device = 'Windows ПК';
    try { device = (await hostname()) || device; } catch { /* немає — лишаємо загальне */ }
    try {
      const r = await auth.qrStart(device);
      if (alive.current) setSt({ kind: 'show', url: r.url, token: r.token, until: Date.now() + r.expires_in * 1000 });
    } catch (e: any) {
      // нода ще без входу за QR (старіша версія) — номер і код
      if (String(e?.message || '').includes('404') || /not found/i.test(String(e?.message))) onUnsupported();
      else if (alive.current) setSt({ kind: 'error', text: e?.message || 'Не вдалося отримати QR' });
    }
  };

  useEffect(() => {
    alive.current = true;
    void fresh();
    return () => { alive.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node?.url]);

  const token = st.kind === 'show' || st.kind === 'scanned' ? st.token : '';
  useEffect(() => {
    if (!token) return;
    const t = setInterval(async () => {
      setNow(Date.now());
      try {
        const r = await auth.qrStatus(token);
        if (!alive.current) return;
        if (r.token && r.user) { clearInterval(t); onLogin(r.token, r.user, r.session_expires_at); return; }
        if (r.status === 'scanned') setSt(s => (s.kind === 'show' ? { kind: 'scanned', token } : s));
        else if (r.status === 'denied') { clearInterval(t); setSt({ kind: 'denied' }); }
        else if (r.status === 'expired') { clearInterval(t); void fresh(); }
      } catch (e: any) {
        // поза робочим вікном / немає доступу — показуємо причину
        if (alive.current && e?.message) { clearInterval(t); setSt({ kind: 'error', text: e.message }); }
      }
    }, 2000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (st.kind === 'loading') return <div className="qr-box"><div className="qr-skeleton" /></div>;
  if (st.kind === 'error' || st.kind === 'denied') {
    return (
      <div className="qr-box">
        <div className="login-err">{st.kind === 'denied' ? 'Вхід скасовано в Telegram' : st.text}</div>
        <button type="button" onClick={() => void fresh()}>Новий QR-код</button>
      </div>
    );
  }
  if (st.kind === 'scanned') {
    return (
      <div className="qr-box qr-scanned">
        <div className="qr-check">✓</div>
        <div className="qr-title">Підтвердіть вхід у Telegram</div>
        <div className="qr-sub">У боті натисніть «Увійти»</div>
      </div>
    );
  }
  const left = Math.max(0, Math.round((st.until - now) / 1000));
  return (
    <div className="qr-box">
      <div className="qr-code"><QRCodeSVG value={st.url} size={188} level="M" /></div>
      <ol className="qr-steps">
        <li>Наведіть камеру телефона на код</li>
        <li>У Telegram-боті натисніть «Увійти»</li>
      </ol>
      <div className="qr-sub">Код оновиться через {left} с · <a href={st.url} target="_blank" rel="noreferrer" className="link">відкрити бота</a></div>
    </div>
  );
}

// Банер активної ноди входу + згортний список для ручного вибору.
function NodeBanner({
  node, open, nodes, loading, onToggle, onPick,
}: {
  node: LoginNode | null;
  open: boolean;
  nodes: LoginNode[];
  loading: boolean;
  onToggle: () => void;
  onPick: (n: LoginNode) => void;
}) {
  return (
    <div className="login-node">
      <div className="login-node-row">
        <span className={`dot ${node ? (node.ms === null ? 'offline' : 'fast') : 'offline'}`} />
        <span className="login-node-label">
          {node ? <>Вхід через <strong>{node.label}</strong></> : 'Пошук доступної ноди…'}
          {node?.ms != null && <span className="muted small"> · {node.ms.toFixed(0)} мс</span>}
        </span>
        <button type="button" className="link" onClick={onToggle}>
          {open ? 'сховати' : 'змінити ноду'}
        </button>
      </div>
      {open && (
        <div className="login-node-list">
          {loading && <div className="muted small">Перевірка нод…</div>}
          {!loading && nodes.length === 0 && <div className="muted small">Ноди недоступні</div>}
          {nodes.map(n => {
            const reachable = n.ms !== null;
            const active = node?.id === n.id;
            return (
              <button
                key={n.id}
                type="button"
                className={`login-node-item ${active ? 'active' : ''}`}
                disabled={!reachable}
                onClick={() => reachable && onPick(n)}
              >
                <span className={`dot ${reachable ? (active ? 'active' : 'up') : 'down'}`} />
                <strong>{n.label}</strong>
                <span className="muted small node-url"> {n.url}</span>
                <span className="ms">{reachable ? `${(n.ms ?? 0).toFixed(0)} мс` : 'недоступна'}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
