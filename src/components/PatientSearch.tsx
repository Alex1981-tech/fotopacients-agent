import { useEffect, useState } from 'react';
import { patients } from '../lib/api';
import type { Patient } from '../lib/types';

export function PatientSearch({ onPick }: { onPick: (p: Patient) => void }) {
  const [card, setCard] = useState('');
  const [result, setResult] = useState<Patient | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!card.trim() || card.length < 3) {
      setResult(null);
      setError('');
      return;
    }
    const t = setTimeout(async () => {
      setLoading(true);
      setError('');
      try {
        const r = await patients.byCardNumber(card.trim());
        if (r.results.length === 0) {
          setResult(null);
          setError('Пацієнта з такою карткою не знайдено');
        } else {
          setResult(r.results[0]);
        }
      } catch (e: any) {
        setError(e?.message || 'Помилка');
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [card]);

  return (
    <div className="patient-search">
      <label>Номер картки</label>
      <input
        type="text"
        value={card}
        onChange={e => setCard(e.target.value)}
        placeholder="000094894"
        autoFocus
      />
      {loading && <div className="ps-loading">Пошук…</div>}
      {error && <div className="ps-err">{error}</div>}
      {result && (
        <div className="ps-card">
          <div className="ps-fio">{result.full_name}</div>
          <div className="ps-meta">картка {result.card_number}{result.birth_date ? ` · ${result.birth_date}` : ''}</div>
          <button onClick={() => onPick(result)} className="ps-confirm">Це той пацієнт →</button>
        </div>
      )}
    </div>
  );
}
