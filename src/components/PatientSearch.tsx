import { useEffect, useRef, useState } from 'react';
import { patients } from '../lib/api';
import type { Patient } from '../lib/types';

/**
 * Один рядок пошуку (20.11.2026): ПІБ, телефон або номер БАФ — агент сам розуміє, що введено.
 * Лише цифри до 9 знаків — номер картки (нулі спереду можна не вводити) і заразом частина телефону;
 * довше або з літерами — загальний пошук. Стрілки ↑↓ і Enter — вибір без миші.
 */

const onlyDigits = (s: string) => s.replace(/[\s()+-]/g, '');

async function find(q: string): Promise<Patient[]> {
  const digits = onlyDigits(q);
  const isNumber = /^\d+$/.test(digits);
  if (isNumber && digits.length <= 9) {
    const [byCard, byAny] = await Promise.all([
      patients.byCardNumber(digits).catch(() => ({ results: [] as Patient[] })),
      digits.length >= 5 ? patients.search(digits).catch(() => ({ results: [] as Patient[] })) : { results: [] as Patient[] },
    ]);
    const seen = new Set<string>();
    return [...byCard.results, ...byAny.results].filter(p => !seen.has(p.id) && (seen.add(p.id), true));
  }
  return (await patients.search(isNumber ? digits : q.trim())).results;
}

const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';

export function PatientSearch({ onPick }: { onPick: (p: Patient) => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Patient[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [active, setActive] = useState(0);
  const reqId = useRef(0);

  useEffect(() => {
    const query = q.trim();
    const digits = onlyDigits(query);
    const enough = /^\d+$/.test(digits) ? digits.length >= 3 : query.length >= 2;
    if (!enough) {
      setResults([]);
      setError('');
      setLoading(false);
      return;
    }
    const my = ++reqId.current;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const found = await find(query);
        if (my !== reqId.current) return;
        setResults(found);
        setActive(0);
        setError(found.length ? '' : 'Нікого не знайдено — перевірте ПІБ, телефон чи номер картки');
      } catch (e: any) {
        if (my !== reqId.current) return;
        setResults([]);
        setError(e?.message || 'Помилка пошуку');
      } finally {
        if (my === reqId.current) setLoading(false);
      }
    }, 280);
    return () => clearTimeout(t);
  }, [q]);

  const onKey = (e: React.KeyboardEvent) => {
    if (!results.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => Math.min(i + 1, results.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(i - 1, 0)); }
    if (e.key === 'Enter') { e.preventDefault(); onPick(results[active]); }
  };

  return (
    <div className="omni">
      <label className={`omni-field ${loading ? 'is-loading' : ''}`}>
        <SearchIcon />
        <input
          type="text"
          value={q}
          onChange={e => setQ(e.target.value)}
          onKeyDown={onKey}
          placeholder="ПІБ, телефон або номер БАФ"
          aria-label="Пошук пацієнта: ПІБ, телефон або номер БАФ"
          autoFocus
          spellCheck={false}
        />
        {q && (
          <button type="button" className="omni-clear" onClick={() => setQ('')} aria-label="Очистити">✕</button>
        )}
      </label>

      {error && !loading && <div className="omni-empty">{error}</div>}

      {results.length > 0 && (
        <ul className="omni-results" role="listbox">
          {results.map((p, i) => (
            <li key={p.id} role="option" aria-selected={i === active}
              className={`omni-item ${i === active ? 'is-active' : ''}`}
              style={{ animationDelay: `${Math.min(i, 6) * 30}ms` }}
              onMouseEnter={() => setActive(i)}
              onClick={() => onPick(p)}>
              <span className="omni-avatar">{initials(p.full_name)}</span>
              <span className="omni-main">
                <span className="omni-name">{p.full_name}</span>
                <span className="omni-meta">
                  <span className="pill">№ {p.card_number}</span>
                  {p.birth_date && <span>{fmtDate(p.birth_date)}</span>}
                </span>
              </span>
              <span className="omni-go">Обрати</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function fmtDate(iso: string) {
  const [y, m, d] = iso.split('-');
  return d && m && y ? `${d}.${m}.${y}` : iso;
}

function SearchIcon() {
  return (
    <svg className="omni-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}
