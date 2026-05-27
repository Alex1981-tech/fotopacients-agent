import { useEffect, useState } from 'react';
import { queue } from '../lib/upload';
import type { UploadTask } from '../lib/types';

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} ГБ`;
}

function fmtAgo(ts?: number): string {
  if (!ts) return '';
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}с тому`;
  if (sec < 3600) return `${Math.floor(sec / 60)} хв тому`;
  return `${Math.floor(sec / 3600)} год тому`;
}

export function UploadQueue() {
  const [tasks, setTasks] = useState<UploadTask[]>([]);
  const [filter, setFilter] = useState<'all' | 'active' | 'done' | 'failed'>('all');

  useEffect(() => queue.subscribe(setTasks), []);

  const filtered = tasks.filter(t => {
    if (filter === 'all') return true;
    if (filter === 'active') return t.status === 'queued' || t.status === 'uploading';
    if (filter === 'done') return t.status === 'done';
    return t.status === 'failed';
  });

  const counts = {
    active: tasks.filter(t => t.status === 'queued' || t.status === 'uploading').length,
    done: tasks.filter(t => t.status === 'done').length,
    failed: tasks.filter(t => t.status === 'failed').length,
  };

  if (tasks.length === 0) {
    return (
      <div className="queue-empty">
        <div className="qe-icon">📭</div>
        <div className="qe-text">Поки порожньо</div>
        <div className="qe-hint">Перетягніть файл у зону завантаження</div>
      </div>
    );
  }

  return (
    <>
      <div className="queue-filters">
        <button onClick={() => setFilter('all')} className={filter === 'all' ? 'active' : ''}>
          Всі <span className="cnt">{tasks.length}</span>
        </button>
        <button onClick={() => setFilter('active')} className={filter === 'active' ? 'active' : ''}>
          <span className="cnt-dot uploading" /> {counts.active}
        </button>
        <button onClick={() => setFilter('done')} className={filter === 'done' ? 'active' : ''}>
          <span className="cnt-dot done" /> {counts.done}
        </button>
        <button onClick={() => setFilter('failed')} className={filter === 'failed' ? 'active' : ''}>
          <span className="cnt-dot failed" /> {counts.failed}
        </button>
      </div>

      <div className="queue">
        {filtered.map(t => {
          const totalSize = t.files.reduce((s, f) => s + f.size, 0);
          const colorClass = `qcard qcard-${t.status}`;
          return (
            <div key={t.id} className={colorClass}>
              <div className="qcard-head">
                <span className={`qcard-status status-${t.status}`}>
                  {t.status === 'queued' && <span className="spinner" />}
                  {t.status === 'uploading' && <span className="spinner spin" />}
                  {t.status === 'done' && <CheckIcon />}
                  {t.status === 'failed' && <XIcon />}
                </span>
                <div className="qcard-body">
                  <div className="qcard-title">
                    {t.files[0].name}
                    {t.files.length > 1 && <span className="qcard-extra"> +{t.files.length - 1}</span>}
                  </div>
                  <div className="qcard-sub">
                    → <strong>{t.patient_name}</strong>
                  </div>
                  <div className="qcard-meta">
                    {fmtSize(totalSize)} · {t.mode === 'ct' ? 'КТ' : 'Аналізи'} · {t.node_id}
                    {t.status === 'uploading' && (
                      <> · <strong>{t.progress}%</strong>
                      {t.speed_mbps != null && t.speed_mbps > 0 && ` · ${t.speed_mbps.toFixed(1)} МБ/с`}
                      </>
                    )}
                    {t.finished_at && ` · ${fmtAgo(t.finished_at)}`}
                  </div>
                </div>
                <div className="qcard-actions">
                  {t.status === 'failed' && (
                    <button onClick={() => queue.retry(t.id)} title="Повторити" className="iconbtn">
                      <RetryIcon />
                    </button>
                  )}
                  {t.status !== 'uploading' && (
                    <button onClick={() => queue.remove(t.id)} title="Прибрати" className="iconbtn">
                      ✕
                    </button>
                  )}
                </div>
              </div>

              {(t.status === 'uploading' || t.status === 'queued') && (
                <div className="qcard-bar">
                  <span style={{ width: `${t.status === 'queued' ? 0 : t.progress}%` }} />
                </div>
              )}
              {t.status === 'failed' && t.error && (
                <div className="qcard-err">⚠ {t.error}</div>
              )}
              {t.status === 'failed' && t.retry_count > 0 && (
                <div className="qcard-meta">Спроб: {t.retry_count}</div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

function CheckIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>;
}
function XIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>;
}
function RetryIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>;
}
