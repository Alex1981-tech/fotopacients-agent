import { useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { PatientSearch } from '../components/PatientSearch';
import { queue } from '../lib/upload';
import type { Patient } from '../lib/types';

export function AnalysisMode({ nodeId }: { nodeId: string }) {
  const [patient, setPatient] = useState<Patient | null>(null);

  const handleFiles = async (paths: string[]) => {
    if (!patient) return;
    for (const path of paths) {
      await queue.addFile(path, {
        mode: 'analysis',
        patient_id: patient.id,
        patient_name: patient.full_name,
        node_id: nodeId,
      });
    }
  };

  const onClickPick = async () => {
    const selected = await open({
      multiple: true,
      filters: [{ name: 'Аналізи', extensions: ['jpg', 'jpeg', 'png', 'webp', 'heic', 'pdf'] }],
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    await handleFiles(paths);
  };

  const reset = () => setPatient(null);

  return (
    <div className="analysis-mode">
      {!patient ? (
        <PatientSearch onPick={setPatient} />
      ) : (
        <>
          <div className="picked-patient">
            <div>
              <strong>{patient.full_name}</strong>
              <div className="meta">картка {patient.card_number}</div>
            </div>
            <button className="link" onClick={reset}>Інший пацієнт</button>
          </div>
          <div
            className="dropzone"
            onClick={onClickPick}
            onDragOver={e => e.preventDefault()}
            onDrop={e => {
              e.preventDefault();
              const paths: string[] = [];
              const list = e.dataTransfer.files;
              for (let i = 0; i < list.length; i++) {
                const f = list[i] as File & { path?: string };
                if (f.path) paths.push(f.path);
              }
              if (paths.length) handleFiles(paths);
            }}
          >
            <div className="dz-icon">📋</div>
            <div>Перетягніть фото / PDF</div>
            <div className="dz-hint">кілька файлів одразу · JPG · PNG · HEIC · PDF</div>
          </div>
        </>
      )}
    </div>
  );
}
