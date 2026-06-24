import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { PatientSearch } from '../components/PatientSearch';
import { onTauriDrop } from '../lib/drop';
import { prepareCtPaths } from '../lib/archive';
import { queue } from '../lib/upload';
import type { Patient } from '../lib/types';

// Один режим, без ручного перемикання й без вибору прийому. Агент шле УСЕ
// (фото · PDF · документи · КТ-архів) на analysis-endpoint пацієнта; бекенд
// сам відрізняє КТ-архів від фото й кладе його карткою-вкладенням у розділ
// «Аналізи» пацієнта — БЕЗ прив'язки до візиту/прийому. Папку агент перед
// завантаженням авто-архівує у .zip (prepareCtPaths).

export function UnifiedMode({ nodeId }: { nodeId: string }) {
  const [patient, setPatient] = useState<Patient | null>(null);
  const [flashMsg, setFlashState] = useState('');

  const flash = (msg: string, ms = 3000) => {
    setFlashState(msg);
    if (ms) setTimeout(() => setFlashState(''), ms);
  };

  const handleFiles = async (paths: string[]) => {
    if (!patient) {
      flash('Спершу оберіть пацієнта');
      return;
    }
    // Папки → .zip, готові файли (фото/PDF/архів) — без змін.
    let prepared: string[];
    try {
      prepared = await prepareCtPaths(paths, (name) => flash(`Архівуємо «${name}»…`, 0));
    } catch (e: any) {
      flash(`Помилка архівації: ${e?.message || e}`, 4000);
      return;
    }
    for (const p of prepared) {
      await queue.addFile(p, {
        mode: 'analysis',
        patient_id: patient.id,
        patient_name: patient.full_name,
        node_id: nodeId,
      });
    }
    if (prepared.length) flash(`Додано в чергу: ${prepared.length}`, 2500);
  };

  // Tauri v2 drag-drop. Перереєстрація при зміні patient/node.
  useEffect(() => onTauriDrop(handleFiles), [patient, nodeId]);

  const onPickFiles = async () => {
    const selected = await open({
      multiple: true,
      filters: [
        { name: 'Усі (фото / PDF / документи / КТ-архів)', extensions: [
          'jpg', 'jpeg', 'jfif', 'png', 'gif', 'webp', 'heic', 'heif', 'avif', 'tif', 'tiff', 'bmp',
          'pdf', 'doc', 'docx', 'odt', 'rtf', 'txt', 'xls', 'xlsx', 'ods', 'csv',
          'zip', 'rar', '7z', 'isz',
        ] },
        { name: 'КТ-архів', extensions: ['zip', 'rar', '7z', 'isz'] },
        { name: 'Фото', extensions: ['jpg', 'jpeg', 'png', 'heic', 'webp', 'tif', 'tiff'] },
        { name: 'PDF', extensions: ['pdf'] },
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

  const reset = () => setPatient(null);

  return (
    <div className="mode-layout">
      <div className="mode-scroll">
        {!patient ? (
          <PatientSearch onPick={setPatient} />
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
        <div className="dropzone" onClick={onPickFiles}>
          <div className="dz-icon">📥</div>
          <div>Перетягніть файли сюди чи клікніть</div>
          <div className="dz-hint">
            фото · PDF · документи · КТ-архів → аналізи пацієнта
          </div>
          <button
            className="link"
            onClick={(e) => { e.stopPropagation(); onPickFolder(); }}
          >
            Обрати папку (КТ)…
          </button>
        </div>
      </div>
    </div>
  );
}
