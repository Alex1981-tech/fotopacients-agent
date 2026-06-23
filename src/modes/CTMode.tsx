import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { PatientSearch } from '../components/PatientSearch';
import { patients } from '../lib/api';
import { onTauriDrop } from '../lib/drop';
import { prepareCtPaths } from '../lib/archive';
import { queue } from '../lib/upload';
import type { Appointment, Patient } from '../lib/types';

export function CTMode({ nodeId }: { nodeId: string }) {
  const [patient, setPatient] = useState<Patient | null>(null);
  const [appts, setAppts] = useState<Appointment[]>([]);
  const [pickedAppt, setPickedAppt] = useState<string>('');
  const [loadingAppts, setLoadingAppts] = useState(false);
  const [flash, setFlash] = useState('');

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
    if (!patient) {
      setFlash('Спершу оберіть пацієнта');
      setTimeout(() => setFlash(''), 3000);
      return;
    }
    if (!pickedAppt) {
      setFlash('Оберіть прийом для прив\'язки');
      setTimeout(() => setFlash(''), 3000);
      return;
    }
    // Якщо обрано Visit (а не Appointment) — спочатку конвертуємо у Appointment
    let apptId = pickedAppt;
    const picked = appts.find(a => a.id === pickedAppt);
    if (picked?.kind === 'visit') {
      try {
        const r = await patients.promoteVisit(picked.id);
        apptId = r.appointment_id;
      } catch (e: any) {
        setFlash(`Помилка: ${e?.message || 'не вдалось створити прийом з візиту'}`);
        setTimeout(() => setFlash(''), 4000);
        return;
      }
    }
    // Папки запаковуємо у .zip автоматично; готові архіви/файли — як є.
    let uploadPaths: string[];
    try {
      uploadPaths = await prepareCtPaths(paths, (name) => {
        setFlash(`Архівуємо папку «${name}»…`);
      });
    } catch (e: any) {
      setFlash(`Помилка архівації: ${e?.message || e}`);
      setTimeout(() => setFlash(''), 4000);
      return;
    }
    for (const path of uploadPaths) {
      await queue.addFile(path, {
        mode: 'ct',
        patient_id: patient.id,
        patient_name: patient.full_name,
        appointment_id: apptId,
        node_id: nodeId,
      });
    }
    setFlash(`Додано в чергу: ${uploadPaths.length}`);
    setTimeout(() => setFlash(''), 2500);
  };

  // Tauri v2 drag-drop (HTML5 onDrop не працює у webview)
  useEffect(() => onTauriDrop(handleFiles), [patient, pickedAppt, nodeId]);

  const onClickPick = async () => {
    const selected = await open({
      multiple: true,
      filters: [{ name: 'CT archives', extensions: ['zip', 'rar', '7z', 'isz'] }],
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    await handleFiles(paths);
  };

  const onPickFolder = async () => {
    const selected = await open({ directory: true, multiple: true });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    await handleFiles(paths);
  };

  const reset = () => { setPatient(null); setAppts([]); setPickedAppt(''); };

  return (
    <div className="mode-layout">
      <div className="mode-scroll">
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
          </>
        )}
      </div>

      <div className="mode-dock">
        {flash && <div className="dock-flash">{flash}</div>}
        <div className="dropzone" onClick={onClickPick}>
          <div className="dz-icon">📦</div>
          <div>Перетягніть архів або папку КТ сюди чи клікніть</div>
          <div className="dz-hint">.zip · .rar · .7z · .isz або папку (запакуємо самі) · до 3 ГБ</div>
          <button
            className="link"
            onClick={(e) => { e.stopPropagation(); onPickFolder(); }}
          >
            Обрати папку…
          </button>
        </div>
      </div>
    </div>
  );
}
