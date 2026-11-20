import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { PatientSearch } from '../components/PatientSearch';
import { onDragHover, onTauriDrop } from '../lib/drop';
import { ARCHIVE_EXT, IMAGE_EXT, classifyPaths, fileName, zipCtFolders } from '../lib/imaging';
import { queue } from '../lib/upload';
import type { ImagingKind, Patient } from '../lib/types';

// Агент вантажить лише КТ і рентгени пацієнта — їх потім бачить пацієнт у міні-аппі.
// КТ — папка/архів з DICOM (папку пакуємо в .zip), рентген — зображення, тип (панорама / прицільний)
// обирає людина. Інші файли відхиляються ще тут.
//
// Екран — два кроки зверху вниз (20.11.2026): «Пацієнт» (один рядок пошуку) → «Файли» (зона).
// Файли можна кинути й до вибору пацієнта — вони чекають.

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
  const [pendingXrays, setPendingXrays] = useState<string[]>([]);
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
        if (!c.rejected.length) say({ tone: 'ok', text: `КТ у черзі: ${prepared.length}` }, 2500);
      }
      if (c.images.length) setPendingXrays(prev => [...prev, ...c.images]);
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

  const chooseKind = async (kind: ImagingKind) => {
    if (!patient) return;
    const paths = pendingXrays;
    setPendingXrays([]);
    for (const path of paths) {
      await queue.addFile(path, { kind, patient_id: patient.id, patient_name: patient.full_name, node_id: nodeId });
    }
    say({ tone: 'ok', text: `Рентген у черзі: ${paths.length}` }, 2500);
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

  const onPickFiles = async () => {
    const selected = await open({
      multiple: true,
      filters: [
        { name: 'Рентген / КТ-архів', extensions: [...IMAGE_EXT, ...ARCHIVE_EXT] },
        { name: 'Рентген (зображення)', extensions: IMAGE_EXT },
        { name: 'КТ-архів', extensions: ARCHIVE_EXT },
      ],
    });
    if (selected) await handleFiles(Array.isArray(selected) ? selected : [selected]);
  };

  const onPickFolder = async () => {
    const selected = await open({ directory: true, multiple: true });
    if (selected) await handleFiles(Array.isArray(selected) ? selected : [selected]);
  };

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
            <div className="kind-title">Що це за знімок?</div>
            <div className="kind-files">{pendingXrays.map(fileName).join(', ')}</div>
            <div className="kind-actions">
              <button type="button" className="kind-btn" onClick={() => chooseKind('panoramic')}>
                <PanoIcon /><span>Панорама</span>
              </button>
              <button type="button" className="kind-btn" onClick={() => chooseKind('periapical')}>
                <ToothIcon /><span>Прицільний</span>
              </button>
            </div>
            <button type="button" className="btn-link" onClick={() => setPendingXrays([])}>Скасувати</button>
          </div>
        ) : (
          <div className={`drop ${dragOver ? 'is-over' : ''} ${!patient ? 'is-idle' : ''} ${busy ? 'is-busy' : ''}`}>
            <UploadIcon />
            <div className="drop-title">
              {dragOver ? 'Відпустіть, щоб додати' : 'Перетягніть сюди КТ або рентген'}
            </div>
            <div className="drop-hint">
              КТ — папка або архів (zip, rar, 7z, isz) · рентген — зображення
              {!patient && <><br />Пацієнта можна обрати й після</>}
            </div>
            <div className="drop-actions">
              <button type="button" className="btn" onClick={onPickFiles}>Обрати файли</button>
              <button type="button" className="btn btn-soft" onClick={onPickFolder}>Папка КТ</button>
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
    <svg className="drop-icon" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
