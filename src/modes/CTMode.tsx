import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { PatientSearch } from '../components/PatientSearch';
import { patients } from '../lib/api';
import { queue } from '../lib/upload';
import type { Appointment, Patient } from '../lib/types';

export function CTMode({ nodeId }: { nodeId: string }) {
  const [patient, setPatient] = useState<Patient | null>(null);
  const [appts, setAppts] = useState<Appointment[]>([]);
  const [pickedAppt, setPickedAppt] = useState<string>('');
  const [loadingAppts, setLoadingAppts] = useState(false);

  useEffect(() => {
    if (!patient) { setAppts([]); setPickedAppt(''); return; }
    setLoadingAppts(true);
    patients.recentAppointments(patient.id)
      .then(r => {
        setAppts(r.appointments);
        if (r.appointments[0]) setPickedAppt(r.appointments[0].id);
      })
      .catch(() => setAppts([]))
      .finally(() => setLoadingAppts(false));
  }, [patient]);

  const handleFiles = async (paths: string[]) => {
    if (!patient || !pickedAppt) return;
    for (const path of paths) {
      await queue.addFile(path, {
        mode: 'ct',
        patient_id: patient.id,
        patient_name: patient.full_name,
        appointment_id: pickedAppt,
        node_id: nodeId,
      });
    }
  };

  const onClickPick = async () => {
    const selected = await open({
      multiple: true,
      filters: [{ name: 'CT archives', extensions: ['zip', 'rar', '7z', 'isz'] }],
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    await handleFiles(paths);
  };

  const reset = () => { setPatient(null); setAppts([]); setPickedAppt(''); };

  return (
    <div className="ct-mode">
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

          <div className="appt-pick">
            <div className="label">Прийом для прив'язки КТ:</div>
            {loadingAppts && <div className="hint">Завантажуємо…</div>}
            {!loadingAppts && appts.length === 0 && <div className="hint">Прийомів немає</div>}
            {appts.map(a => (
              <label key={a.id} className="appt-row">
                <input
                  type="radio"
                  name="appt"
                  checked={pickedAppt === a.id}
                  onChange={() => setPickedAppt(a.id)}
                />
                <span>
                  {new Date(a.date).toLocaleString('uk-UA')} · {a.doctor_name} · {a.procedure || '—'}
                </span>
              </label>
            ))}
          </div>

          <div
            className="dropzone"
            onClick={onClickPick}
            onDragOver={e => e.preventDefault()}
            onDrop={e => {
              e.preventDefault();
              const paths: string[] = [];
              const list = e.dataTransfer.files;
              // Tauri передає file.path як non-standard property
              for (let i = 0; i < list.length; i++) {
                const f = list[i] as File & { path?: string };
                if (f.path) paths.push(f.path);
              }
              if (paths.length) handleFiles(paths);
            }}
          >
            <div className="dz-icon">📦</div>
            <div>Перетягніть архів КТ сюди або клікніть</div>
            <div className="dz-hint">.zip · .rar · .7z · .isz · до 3 ГБ</div>
          </div>
        </>
      )}
    </div>
  );
}
