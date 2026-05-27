import { useState } from 'react';
import { auth } from '../lib/api';

export function LoginScreen({ onLogin }: { onLogin: (token: string, user: any) => void }) {
  const [phone, setPhone] = useState('+380');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const requestCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
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
      onLogin(r.token, r.user);
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
            <button type="submit" disabled={loading || phone.length < 10}>
              {loading ? 'Надсилаємо…' : 'Отримати код у Telegram'}
            </button>
            {error && <div className="login-err">{error}</div>}
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
