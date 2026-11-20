import { useEffect, useState } from 'react';
import { queue, taskTitle } from '../lib/upload';
import { KIND_LABEL, type UploadTask } from '../lib/types';

function fmtSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} ГБ`;
}

function fmtAgo(ts?: number): string {
  if (!ts) return '';
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return 'щойно';
  if (sec < 3600) return `${Math.floor(sec / 60)} хв тому`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} год тому`;
  return new Date(ts).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' });
}

/** Що зараз відбувається із завданням — людською мовою */
function stageText(t: UploadTask): string {
  const size = t.files.reduce((s, f) => s + f.size, 0);
  if (t.status === 'queued') return t.server_upload_id ? 'Продовжимо з місця зупинки' : 'У черзі';
  switch (t.stage) {
    case 'hashing': return 'Перевіряємо файл…';
    case 'waiting_net': return 'Немає звʼязку — повторюємо, нічого не втрачено';
    case 'finishing': return 'Сервер перевіряє архів…';
    default: {
      const done = t.uploaded_bytes ?? Math.round((t.progress / 100) * size);
      const speed = t.speed_mbps && t.speed_mbps > 0 ? ` · ${t.speed_mbps.toFixed(1)} МБ/с` : '';
      return `${fmtSize(done)} з ${fmtSize(size)}${speed}`;
    }
  }
}

type Filter = 'all' | 'active' | 'done' | 'failed';
const isActive = (t: UploadTask) => t.status === 'queued' || t.status === 'uploading';

export function UploadQueue({ onClose }: { onClose?: () => void }) {
  const [tasks, setTasks] = useState<UploadTask[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  useEffect(() => queue.subscribe(setTasks), []);

  const counts = {
    active: tasks.filter(isActive).length,
    done: tasks.filter(t => t.status === 'done').length,
    failed: tasks.filter(t => t.status === 'failed' || t.status === 'duplicate').length,
  };
  const shown = tasks.filter(t => filter === 'all' || (filter === 'active' ? isActive(t)
    : filter === 'done' ? t.status === 'done' : t.status === 'failed' || t.status === 'duplicate'));

  return (
    <div className="queue">
      <div className="queue-head">
        <h2>Завантаження</h2>
        {counts.done > 0 && (
          <button type="button" className="btn-link" onClick={() => void queue.clearHistory(t => t.status === 'done')}>
            Прибрати готові
          </button>
        )}
        {onClose && <button type="button" className="icon-btn sheet-close" onClick={onClose} aria-label="Закрити">✕</button>}
      </div>

      {tasks.length > 0 && (
        <div className="qseg" role="tablist">
          {([['all', 'Усі', tasks.length], ['active', 'Активні', counts.active],
             ['done', 'Готово', counts.done], ['failed', 'Помилки', counts.failed]] as const).map(([k, l, n]) => (
            <button key={k} type="button" role="tab" aria-selected={filter === k}
              className={filter === k ? 'is-on' : ''} onClick={() => setFilter(k)}>
              {l}{n > 0 && <span className={`qseg-n ${k === 'failed' ? 'is-bad' : ''}`}>{n}</span>}
            </button>
          ))}
        </div>
      )}

      {tasks.length === 0 ? (
        <div className="queue-empty">
          <div className="queue-empty-ring" />
          <div>Тут зʼявляться завантаження</div>
          <div className="muted small">Можна закрити вікно — агент докачає у фоні</div>
        </div>
      ) : (
        <ul className="tasks">
          {shown.map(t => <TaskRow key={t.id} t={t} />)}
          {!shown.length && <li className="muted small tasks-none">Нічого немає</li>}
        </ul>
      )}
    </div>
  );
}

function TaskRow({ t }: { t: UploadTask }) {
  const size = t.files.reduce((s, f) => s + f.size, 0);
  const active = isActive(t);
  return (
    <li className={`task task-${t.status} ${t.stage === 'waiting_net' ? 'task-net' : ''}`}>
      <div className="task-top">
        <span className={`kind kind-${t.kind ?? 'ct'}`}>{t.kind ? KIND_LABEL[t.kind] : '—'}</span>
        <span className="task-name" title={t.files.map(f => f.name).join('\n')}>{taskTitle(t)}</span>
        <span className="task-actions">
          {(t.status === 'failed') && (
            <button type="button" className="icon" title="Повторити" aria-label="Повторити" onClick={() => queue.retry(t.id)}><RetryIcon /></button>
          )}
          {t.status !== 'uploading' && (
            <button type="button" className="icon" title="Прибрати" aria-label="Прибрати" onClick={() => queue.remove(t.id)}>✕</button>
          )}
        </span>
      </div>
      <div className="task-sub">{t.patient_name}</div>

      {active && (
        <>
          <div className={`pbar ${t.status === 'queued' || t.stage === 'hashing' || t.stage === 'finishing' ? 'is-indeterminate' : ''}`}>
            <span style={{ transform: `scaleX(${t.progress / 100})` }} />
          </div>
          <div className="task-stage">
            <span>{stageText(t)}</span>
            {t.status === 'uploading' && t.stage === 'uploading' && <strong>{t.progress}%</strong>}
          </div>
        </>
      )}
      {t.status === 'done' && (
        <div className="task-stage is-ok"><CheckIcon /> Завантажено · {fmtSize(size)} · {fmtAgo(t.finished_at)}</div>
      )}
      {t.status === 'failed' && t.error && <div className="task-err">{t.error}</div>}
      {t.status === 'duplicate' && (
        <div className="task-dup">
          <span>Цей файл уже є в пацієнта{t.duplicates?.[0] ? `: ${t.duplicates[0].existing_name}` : ''}</span>
          <button type="button" className="btn-link" onClick={() => queue.forceUpload(t.id)}>Завантажити ще раз</button>
        </div>
      )}
    </li>
  );
}

function CheckIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>;
}
function RetryIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" /></svg>;
}
