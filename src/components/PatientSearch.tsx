import { useEffect, useState } from 'react';
import { patients } from '../lib/api';
import type { Patient } from '../lib/types';

type SearchMode = 'card' | 'name' | 'phone';

const MODES: { id: SearchMode; label: string; placeholder: string; inputMode?: 'numeric' | 'tel' | 'text' }[] = [
  { id: 'card',  label: '№ картки',  placeholder: '000094894', inputMode: 'numeric' },
  { id: 'name',  label: 'ПІБ',       placeholder: 'Кузьменко Олександр', inputMode: 'text' },
  { id: 'phone', label: 'Телефон',   placeholder: '+380971886225 або 0971886225', inputMode: 'tel' },
];

export function PatientSearch({ onPick }: { onPick: (p: Patient) => void }) {
  const [mode, setMode] = useState<SearchMode>('card');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Patient[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const q = query.trim();
    // Очищення коли надто коротко
    const minLen = mode === 'card' ? 3 : 2;
    if (q.length < minLen) {
      setResults([]);
      setError('');
      return;
    }

    const t = setTimeout(async () => {
      setLoading(true);
      setError('');
      try {
        const resp = mode === 'card'
          ? await patients.byCardNumber(q)
          : await patients.search(q);
        if (resp.results.length === 0) {
          setResults([]);
          setError(mode === 'card'
            ? 'Пацієнта з такою карткою не знайдено'
            : 'Не знайдено — спробуйте інший запит');
        } else {
          setResults(resp.results);
        }
      } catch (e: any) {
        setError(e?.message || 'Помилка');
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [query, mode]);

  // Auto-pick якщо рівно 1 результат + точний матч картки
  const onlyOne = results.length === 1;

  const switchMode = (m: SearchMode) => {
    setMode(m);
    setQuery('');
    setResults([]);
    setError('');
  };

  const currentMode = MODES.find(m => m.id === mode)!;

  return (
    <div className="patient-search">
      <div className="search-tabs">
        {MODES.map(m => (
          <button
            key={m.id}
            onClick={() => switchMode(m.id)}
            className={mode === m.id ? 'active' : ''}
          >
            {m.label}
          </button>
        ))}
      </div>

      <label>Пошук за {currentMode.label.toLowerCase()}</label>
      <input
        type={currentMode.inputMode === 'numeric' ? 'text' : currentMode.inputMode}
        inputMode={currentMode.inputMode}
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder={currentMode.placeholder}
        autoFocus
      />

      {loading && <div className="ps-loading">Пошук…</div>}
      {error && <div className="ps-err">{error}</div>}

      {results.length > 0 && (
        <div className="ps-results">
          {onlyOne && <div className="ps-results-head">Знайдено 1 пацієнта</div>}
          {!onlyOne && <div className="ps-results-head">Знайдено {results.length} — оберіть:</div>}
          {results.map(p => (
            <div key={p.id} className="ps-card">
              <div>
                <div className="ps-fio">{p.full_name}</div>
                <div className="ps-meta">
                  картка {p.card_number}{p.birth_date ? ` · ${p.birth_date}` : ''}
                </div>
              </div>
              <button onClick={() => onPick(p)} className="ps-confirm">
                {onlyOne ? 'Це той пацієнт →' : 'Обрати →'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
