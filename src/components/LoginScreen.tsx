import { useState } from 'react';
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
        <div className="login-icon">📷</div>
        <h1>FotoPacients Agent</h1>
        <p className="login-sub">Авторизація за номером телефону</p>

        <NodeBanner
          node={node}
          open={pickerOpen}
          nodes={nodes}
          loading={loadingNodes}
          onToggle={togglePicker}
          onPick={(n) => { onPickNode(n); setPickerOpen(false); }}
        />

        {step === 'phone' && (
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

            <div className="login-bot">
              <div className="login-bot-qr">
                <QRCodeSVG value={BOT_LINK} size={116} level="M" />
              </div>
              <div className="login-bot-text">
                <strong>Немає бота?</strong>
                <span>Скануйте QR телефоном або відкрийте бота, натисніть «Старт» і поділіться номером — туди прийде код для входу.</span>
                <a href={BOT_LINK} target="_blank" rel="noreferrer" className="link">Відкрити бота</a>
              </div>
            </div>
          </form>
        )}

        {step === 'code' && (
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
      </div>
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
