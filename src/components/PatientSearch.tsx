import { useEffect, useRef, useState } from 'react';
import { patients } from '../lib/api';
import type { Patient } from '../lib/types';

export function PatientSearch({ onPick }: { onPick: (p: Patient) => void }) {
  const [card, setCard] = useState('');
  const [fio, setFio] = useState('');
  const [results, setResults] = useState<Patient[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const reqId = useRef(0);

  // Активний інпут: якщо хтось пише в card — пошук по картці (exact),
  // якщо в fio — повнотекстовий ?q= (ФІО / телефон / т.і.)
  useEffect(() => {
    const cardQ = card.trim();
    const fioQ = fio.trim();
    const hasCard = cardQ.length >= 3;
    const hasFio = fioQ.length >= 2;
    if (!hasCard && !hasFio) {
      setResults([]); setError('');
      return;
    }
    const my = ++reqId.current;
    const t = setTimeout(async () => {
      setLoading(true);
      setError('');
      try {
        const resp = hasCard
          ? await patients.byCardNumber(cardQ)
          : await patients.search(fioQ);
        if (my !== reqId.current) return; // застарілий запит
        if (resp.results.length === 0) {
          setResults([]);
          setError(hasCard ? 'Картку не знайдено' : 'Нічого не знайдено');
        } else {
          setResults(resp.results);
        }
      } catch (e: any) {
        if (my !== reqId.current) return;
        setError(e?.message || 'Помилка');
        setResults([]);
      } finally {
        if (my === reqId.current) setLoading(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [card, fio]);

  // Якщо юзер починає писати в одне поле — друге очищаємо
  const onCard = (v: string) => { setCard(v); if (v) setFio(''); };
  const onFio = (v: string) => { setFio(v); if (v) setCard(''); };

  return (
    <div className="patient-search">
      <div className="search-row">
        <div className="search-field">
          <label>Номер БАФ</label>
          <input
            type="text"
            inputMode="numeric"
            value={card}
            onChange={e => onCard(e.target.value)}
            placeholder="000094894"
            autoFocus
          />
        </div>
        <div className="search-field">
          <label>ФІО / Телефон</label>
          <input
            type="text"
            value={fio}
            onChange={e => onFio(e.target.value)}
            placeholder="Кузьменко або +380…"
          />
        </div>
      </div>

      {loading && <div className="ps-loading">Пошук…</div>}
      {error && <div className="ps-err">{error}</div>}

      {results.length > 0 && (
        <div className="ps-results">
          <div className="ps-results-head">
            {results.length === 1 ? 'Знайдено 1 пацієнта' : `Знайдено ${results.length} — оберіть:`}
          </div>
          {results.map(p => (
            <div key={p.id} className="ps-card">
              <div>
                <div className="ps-fio">{p.full_name}</div>
                <div className="ps-meta">
                  картка {p.card_number}{p.birth_date ? ` · ${p.birth_date}` : ''}
                </div>
              </div>
              <button onClick={() => onPick(p)} className="ps-confirm">
                {results.length === 1 ? 'Той пацієнт →' : 'Обрати →'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
