import { useEffect, useState } from 'react';
import { PatientSearch } from '../components/PatientSearch';
import { onDragHover, onTauriDrop } from '../lib/drop';
import { classifyPaths, fileName, guessXrayKind, zipCtFolders } from '../lib/imaging';
import { queue } from '../lib/upload';
import type { Patient } from '../lib/types';

type XrayKind = 'panoramic' | 'periapical';

// Агент вантажить лише КТ і рентгени пацієнта — їх потім бачить пацієнт у міні-аппі.
// КТ — папка/архів з DICOM (папку пакуємо в .zip), рентген — зображення, тип (панорама / прицільний)
// обирає людина. Інші файли відхиляються ще тут.
//
// Екран — два кроки зверху вниз (20.11.2026): «Пацієнт» (один рядок пошуку) → «Файли» (зона).
// Файли можна кинути й до вибору пацієнта — вони чекають. Файли лише перетягуванням (кнопки прибрано 20.11.2026);
// кілька прицільних разом — одна група. Щойно знімки в черзі, пацієнт скидається — наступний не піде не тому.

export interface Incoming {
  seq: number;
  paths: string[];
}

type Notice = { tone: 'info' | 'warn' | 'ok'; text: string; progress?: number } | null;

const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';

export function UnifiedMode({ nodeId, incoming }: { nodeId: string; incoming: Incoming | null }) {
  const [patient, setPatient] = useState<Patient | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [waiting, setWaiting] = useState<string[]>([]);
  // Рентгени, що чекають підтвердження типу; можна кинути разом з архівом КТ (архів іде в чергу одразу)
  const [pendingXrays, setPendingXrays] = useState<{ path: string; kind: XrayKind }[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);

  const say = (n: Notice, ms = 3500) => {
    setNotice(n);
    if (n && ms) setTimeout(() => setNotice(cur => (cur === n ? null : cur)), ms);
  };

  const process = async (p: Patient, paths: string[]) => {
    setBusy(true);
    try {
      const c = await classifyPaths(paths);
      if (c.rejected.length) {
        say({ tone: 'warn', text: `Пропущено — не КТ і не рентген: ${c.rejected.map(fileName).join(', ')}` }, 7000);
      }
      if (c.ct.length) {
        let prepared;
        try {
          prepared = await zipCtFolders(c.ct, (name, done, total) =>
            setNotice({ tone: 'info', text: total ? `Пакуємо «${name}» — ${done} з ${total} файлів` : `Пакуємо «${name}»…`,
                        progress: total ? done / total : undefined }));
        } catch (e: any) {
          say({ tone: 'warn', text: `Не вдалося запакувати папку: ${e?.message || e}` }, 7000);
          return;
        }
        for (const f of prepared) {
          await queue.addFile(f.path, { kind: 'ct', patient_id: p.id, patient_name: p.full_name, node_id: nodeId,
                                        display_name: f.name, temp_zip: f.temp });
        }
        if (!c.rejected.length) say({ tone: 'ok', text: `КТ у черзі: ${prepared.length} · ${p.full_name}` }, 3500);
        if (!c.images.length) setPatient(null);
      }
      if (c.images.length) {
        const guessed = await Promise.all(c.images.map(async path => ({ path, kind: await guessXrayKind(path) })));
        setPendingXrays(prev => [...prev, ...guessed]);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleFiles = async (paths: string[]) => {
    if (!patient) {
      setWaiting(prev => [...prev, ...paths]);
      return;
    }
    await process(patient, paths);
  };

  const pickPatient = (p: Patient) => {
    setPatient(p);
    if (waiting.length) {
      const paths = waiting;
      setWaiting([]);
      void process(p, paths);
    }
  };

  const setKind = (path: string, kind: XrayKind) =>
    setPendingXrays(prev => prev.map(x => (x.path === path ? { ...x, kind } : x)));

  // Панорами й прицільні — по одному завданню на тип (прицільні йдуть групою)
  const uploadXrays = async () => {
    if (!patient) return;
    const items = pendingXrays;
    setPendingXrays([]);
    for (const kind of ['panoramic', 'periapical'] as const) {
      const paths = items.filter(x => x.kind === kind).map(x => x.path);
      if (paths.length) {
        await queue.addFiles(paths, { kind, patient_id: patient.id, patient_name: patient.full_name, node_id: nodeId });
      }
    }
    say({ tone: 'ok', text: `Рентген у черзі: ${items.length} · ${patient.full_name}` }, 3500);
    setPatient(null);
  };

  useEffect(() => onTauriDrop(handleFiles), [patient, nodeId]);
  useEffect(() => onDragHover(setDragOver), []);

  useEffect(() => {
    if (incoming) void handleFiles(incoming.paths);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming?.seq]);

  // Esc — інший пацієнт (якщо не обираємо тип знімка)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && patient && !pendingXrays.length) setPatient(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [patient, pendingXrays.length]);

  return (
    <div className="uploader">
      <section className="step">
        <div className="step-head"><span className="step-num">1</span>Пацієнт</div>
        {patient ? (
          <div className="patient-card" key={patient.id}>
            <span className="patient-avatar">{initials(patient.full_name)}</span>
            <span className="patient-main">
              <span className="patient-name">{patient.full_name}</span>
              <span className="patient-meta">
                <span className="pill">№ {patient.card_number}</span>
                {patient.birth_date && <span>{patient.birth_date.split('-').reverse().join('.')}</span>}
              </span>
            </span>
            <button type="button" className="btn-ghost" onClick={() => setPatient(null)} title="Esc">Змінити</button>
          </div>
        ) : (
          <PatientSearch onPick={pickPatient} />
        )}
        {!patient && waiting.length > 0 && (
          <div className="notice notice-info">
            Чекає на вибір пацієнта: {waiting.length} {waiting.length === 1 ? 'файл' : 'файли'}
            <button type="button" className="btn-link" onClick={() => setWaiting([])}>Скасувати</button>
          </div>
        )}
      </section>

      <section className="step step-files">
        <div className="step-head"><span className="step-num">2</span>Знімки</div>

        {pendingXrays.length > 0 ? (
          <div className="kind-card">
            <div className="kind-title">{pendingXrays.length > 1 ? `Знімки: ${pendingXrays.length}` : 'Що це за знімок?'}</div>
            <ul className="kind-list">
              {pendingXrays.map(x => (
                <li key={x.path} className="kind-row">
                  <span className="kind-file" title={x.path}>{fileName(x.path)}</span>
                  <span className="kind-seg" role="radiogroup">
                    <button type="button" role="radio" aria-checked={x.kind === 'panoramic'}
                      className={x.kind === 'panoramic' ? 'is-on' : ''} onClick={() => setKind(x.path, 'panoramic')}>
                      <PanoIcon />Панорама
                    </button>
                    <button type="button" role="radio" aria-checked={x.kind === 'periapical'}
                      className={x.kind === 'periapical' ? 'is-on' : ''} onClick={() => setKind(x.path, 'periapical')}>
                      <ToothIcon />Прицільний
                    </button>
                  </span>
                </li>
              ))}
            </ul>
            <button type="button" className="btn kind-go" disabled={!patient} onClick={() => void uploadXrays()}>
              {patient ? 'Завантажити' : 'Спершу оберіть пацієнта'}
            </button>
            <button type="button" className="btn-link" onClick={() => setPendingXrays([])}>Скасувати</button>
          </div>
        ) : (
          <div className={`drop ${dragOver ? 'is-over' : ''} ${!patient ? 'is-idle' : ''} ${busy ? 'is-busy' : ''}`}>
            <UploadIcon />
            <div className="drop-title">
              {dragOver ? 'Відпустіть, щоб додати' : 'Перетягніть сюди КТ або рентген'}
            </div>
            <div className="drop-hint">
              Архів КТ, панорама або прицільні — можна кілька одразу
              {!patient && <><br />Пацієнта можна обрати й після</>}
            </div>
          </div>
        )}

        {notice && (
          <div className={`notice notice-${notice.tone}`} role="status">
            <span>{notice.text}</span>
            {notice.progress !== undefined && (
              <span className="notice-bar"><span style={{ transform: `scaleX(${notice.progress})` }} /></span>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function UploadIcon() {
  return (
    <svg className="drop-icon" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /><polyline points="7 9 12 4 17 9" /><line x1="12" y1="4" x2="12" y2="16" />
    </svg>
  );
}
function PanoIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <rect x="2" y="6" width="20" height="12" rx="3" /><path d="M6 12c2-2 4-2 6 0s4 2 6 0" />
    </svg>
  );
}
function ToothIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 3c-2.5 0-4 2-4 4.5 0 2 1 3.5 1.5 5.5.6 2.5 1 8 3 8 1.6 0 1.5-5 4.5-5s2.9 5 4.5 5c2 0 2.4-5.5 3-8 .5-2 1.5-3.5 1.5-5.5C21 5 19.5 3 17 3c-2 0-3 1-5 1S9 3 7 3z" />
    </svg>
  );
}
