import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { PatientSearch } from '../components/PatientSearch';
import { onTauriDrop } from '../lib/drop';
import { queue } from '../lib/upload';
import type { Patient } from '../lib/types';

export function AnalysisMode({ nodeId }: { nodeId: string }) {
  const [patient, setPatient] = useState<Patient | null>(null);
  const [flash, setFlash] = useState('');

  const handleFiles = async (paths: string[]) => {
    if (!patient) {
      setFlash('Спершу оберіть пацієнта');
      setTimeout(() => setFlash(''), 3000);
      return;
    }
    // Захист: КТ-архіви не повинні попадати у Analysis-режим — їх
    // не оброблятиме process_ct_zip (без зрізів та панорами).
    const CT_EXT = /\.(zip|rar|7z|isz)$/i;
    const ctFiles = paths.filter(p => CT_EXT.test(p));
    if (ctFiles.length) {
      const names = ctFiles.map(p => p.split(/[\\/]/).pop()).join(', ');
      setFlash(`Це КТ-архів (${names}). Перемкніть режим у Налаштування → КТ`);
      setTimeout(() => setFlash(''), 6000);
      return;
    }
    for (const path of paths) {
      await queue.addFile(path, {
        mode: 'analysis',
        patient_id: patient.id,
        patient_name: patient.full_name,
        node_id: nodeId,
      });
    }
    setFlash(`Додано в чергу: ${paths.length}`);
    setTimeout(() => setFlash(''), 2500);
  };

  useEffect(() => onTauriDrop(handleFiles), [patient, nodeId]);

  const onClickPick = async () => {
    const selected = await open({
      multiple: true,
      filters: [
        { name: 'Аналізи (всі)', extensions: [
          'jpg', 'jpeg', 'jfif', 'png', 'gif', 'webp', 'heic', 'heif', 'avif',
          'tif', 'tiff', 'bmp',
          'pdf', 'doc', 'docx', 'odt', 'rtf', 'txt',
          'xls', 'xlsx', 'ods', 'csv',
        ] },
        { name: 'Фото', extensions: ['jpg', 'jpeg', 'png', 'heic', 'webp', 'tif', 'tiff'] },
        { name: 'PDF', extensions: ['pdf'] },
        { name: 'Документи', extensions: ['doc', 'docx', 'odt', 'rtf', 'txt', 'xls', 'xlsx'] },
      ],
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    await handleFiles(paths);
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
        {flash && <div className="dock-flash">{flash}</div>}
        <div className="dropzone" onClick={onClickPick}>
          <div className="dz-icon">📋</div>
          <div>Перетягніть фото / PDF</div>
          <div className="dz-hint">кілька файлів одразу · JPG · PNG · HEIC · PDF</div>
        </div>
      </div>
    </div>
  );
}
