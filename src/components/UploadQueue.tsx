import { useEffect, useState } from 'react';
import { queue } from '../lib/upload';
import type { UploadTask } from '../lib/types';

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} ГБ`;
}

export function UploadQueue() {
  const [tasks, setTasks] = useState<UploadTask[]>([]);

  useEffect(() => queue.subscribe(setTasks), []);

  if (tasks.length === 0) {
    return <div className="queue-empty">Задач немає. Перетягніть файли в зону завантаження.</div>;
  }

  return (
    <div className="queue">
      {tasks.map(t => {
        const totalSize = t.files.reduce((s, f) => s + f.size, 0);
        const icon = t.status === 'done' ? '✓'
                   : t.status === 'failed' ? '✗'
                   : t.status === 'uploading' ? '⏳' : '📤';
        const colorClass = `queue-row queue-${t.status}`;
        return (
          <div key={t.id} className={colorClass}>
            <span className="queue-icon">{icon}</span>
            <div className="queue-body">
              <div className="queue-title">
                <strong>{t.files[0].name}</strong>
                {t.files.length > 1 && <span className="queue-extra"> +{t.files.length - 1}</span>}
                <span className="queue-arrow"> → {t.patient_name}</span>
              </div>
              <div className="queue-meta">
                {fmtSize(totalSize)} · {t.mode === 'ct' ? 'КТ' : 'Аналізи'} · {t.node_id}
                {t.status === 'uploading' && t.progress > 0 && ` · ${t.progress}%`}
                {t.status === 'failed' && t.retry_count > 0 && ` · ${t.retry_count} спроб`}
              </div>
              {t.status === 'failed' && t.error && (
                <div className="queue-err">{t.error}</div>
              )}
              {t.status === 'uploading' && (
                <div className="queue-bar"><span style={{ width: `${t.progress}%` }} /></div>
              )}
            </div>
            <div className="queue-actions">
              {t.status === 'failed' && (
                <button onClick={() => queue.retry(t.id)} title="Повторити">↻</button>
              )}
              {t.status !== 'uploading' && (
                <button onClick={() => queue.remove(t.id)} title="Прибрати">×</button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
