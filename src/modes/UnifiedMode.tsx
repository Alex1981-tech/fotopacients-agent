import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { PatientSearch } from '../components/PatientSearch';
import { onTauriDrop } from '../lib/drop';
import { ARCHIVE_EXT, IMAGE_EXT, classifyPaths, fileName, zipCtFolders } from '../lib/imaging';
import { queue } from '../lib/upload';
import type { ImagingKind, Patient } from '../lib/types';

// Агент вантажить лише КТ і рентгени пацієнта — їх потім бачить пацієнт у
// міні-аппі. КТ — папка/архів з DICOM (папку пакуємо в .zip), рентген —
// зображення, тип якого (панорама / прицільний) обирає людина. Інші файли
// відхиляються ще тут, до завантаження.

export interface Incoming {
  seq: number;
  paths: string[];
}

export function UnifiedMode({ nodeId, incoming }: { nodeId: string; incoming: Incoming | null }) {
  const [patient, setPatient] = useState<Patient | null>(null);
  const [flashMsg, setFlashState] = useState('');
  // Файли, що прийшли до вибору пацієнта (з буфера чи drag-drop).
  const [waiting, setWaiting] = useState<string[]>([]);
  // Зображення, для яких ще не обрано тип знімка.
  const [pendingXrays, setPendingXrays] = useState<string[]>([]);

  const flash = (msg: string, ms = 3000) => {
    setFlashState(msg);
    if (ms) setTimeout(() => setFlashState(''), ms);
  };

  const enqueue = async (p: Patient, paths: string[], kind: ImagingKind) => {
    for (const path of paths) {
      await queue.addFile(path, {
        kind,
        patient_id: p.id,
        patient_name: p.full_name,
        node_id: nodeId,
      });
    }
  };

  const process = async (p: Patient, paths: string[]) => {
    const c = await classifyPaths(paths);
    if (c.rejected.length) {
      flash(`Пропущено (не КТ і не рентген): ${c.rejected.map(fileName).join(', ')}`, 6000);
    }
    if (c.ct.length) {
      let prepared: string[];
      try {
        prepared = await zipCtFolders(c.ct, (name) => flash(`Архівуємо «${name}»…`, 0));
      } catch (e: any) {
        flash(`Помилка архівації: ${e?.message || e}`, 4000);
        return;
      }
      await enqueue(p, prepared, 'ct');
      if (!c.rejected.length) flash(`КТ додано в чергу: ${prepared.length}`, 2500);
    }
    if (c.images.length) setPendingXrays(prev => [...prev, ...c.images]);
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
    await enqueue(patient, paths, kind);
    flash(`Додано в чергу: ${paths.length}`, 2500);
  };

  // Tauri v2 drag-drop. Перереєстрація при зміні patient/node.
  useEffect(() => onTauriDrop(handleFiles), [patient, nodeId]);

  // Файли з буфера обміну (ClipboardToast → App → сюди).
  useEffect(() => {
    if (incoming) void handleFiles(incoming.paths);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming?.seq]);

  const onPickFiles = async () => {
    const selected = await open({
      multiple: true,
      filters: [
        { name: 'Рентген / КТ-архів', extensions: [...IMAGE_EXT, ...ARCHIVE_EXT] },
        { name: 'Рентген (зображення)', extensions: IMAGE_EXT },
        { name: 'КТ-архів', extensions: ARCHIVE_EXT },
      ],
    });
    if (!selected) return;
    await handleFiles(Array.isArray(selected) ? selected : [selected]);
  };

  const onPickFolder = async () => {
    const selected = await open({ directory: true, multiple: true });
    if (!selected) return;
    await handleFiles(Array.isArray(selected) ? selected : [selected]);
  };

  const reset = () => {
    setPatient(null);
    setPendingXrays([]);
  };

  return (
    <div className="mode-layout">
      <div className="mode-scroll">
        {!patient ? (
          <>
            {waiting.length > 0 && (
              <div className="dock-flash">
                Оберіть пацієнта — файлів чекає: {waiting.length}
                <button className="link" onClick={() => setWaiting([])}>Скасувати</button>
              </div>
            )}
            <PatientSearch onPick={pickPatient} />
          </>
        ) : (
          <div className="picked-patient">
            <div>
              <strong>{patient.full_name}</strong>
              <div className="meta">картка {patient.card_number}</div>
            </div>
            <button className="link" onClick={reset}>Інший пацієнт</button>
          </div>
        )}
      </div>

      <div className="mode-dock">
        {flashMsg && <div className="dock-flash">{flashMsg}</div>}
        {pendingXrays.length > 0 ? (
          <div className="kind-picker">
            <div className="kind-picker-title">
              Що це за знімки? <span className="meta">({pendingXrays.map(fileName).join(', ')})</span>
            </div>
            <div className="kind-picker-actions">
              <button onClick={() => chooseKind('panoramic')}>Панорама</button>
              <button onClick={() => chooseKind('periapical')}>Прицільний</button>
              <button className="link" onClick={() => setPendingXrays([])}>Скасувати</button>
            </div>
          </div>
        ) : (
          <div className="dropzone" onClick={onPickFiles}>
            <div className="dz-icon">📥</div>
            <div>Перетягніть файли сюди чи клікніть</div>
            <div className="dz-hint">
              КТ (папка або архів з DICOM) · рентген: панорама, прицільний
            </div>
            <button
              className="link"
              onClick={(e) => { e.stopPropagation(); onPickFolder(); }}
            >
              Обрати папку (КТ)…
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
