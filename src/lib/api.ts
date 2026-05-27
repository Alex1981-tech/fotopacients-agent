import { fetch } from '@tauri-apps/plugin-http';
import type { Appointment, AuthUser, Patient } from './types';

export interface ApiConfig {
  baseUrl: string;
  token: string | null;
}

let config: ApiConfig = { baseUrl: '', token: null };

export function setApi(cfg: Partial<ApiConfig>) {
  config = { ...config, ...cfg };
}

export function getApi(): ApiConfig { return config; }

async function call<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  if (!config.baseUrl) throw new Error('API base URL не вибрано (нода не доступна)');
  const headers = new Headers(init.headers || {});
  if (config.token) headers.set('Authorization', `Token ${config.token}`);
  if (!headers.has('Content-Type') && init.body && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  const resp = await fetch(`${config.baseUrl}${path}`, { ...init, headers });
  if (resp.status === 204) return undefined as T;
  const text = await resp.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!resp.ok) {
    const detail = (json as { detail?: string; error?: string })?.detail
                || (json as { detail?: string; error?: string })?.error
                || text
                || `HTTP ${resp.status}`;
    throw new Error(detail);
  }
  return json as T;
}

// ─── Auth ────────────────────────────────────────────────────────

export interface RequestCodeResp { status: string; detail?: string }
export interface VerifyCodeResp { token: string; user: AuthUser }

export const auth = {
  requestCode(phone: string) {
    return call<RequestCodeResp>('/api/agent/auth/request-code/', {
      method: 'POST',
      body: JSON.stringify({ phone }),
    });
  },
  verifyCode(phone: string, code: string) {
    return call<VerifyCodeResp>('/api/agent/auth/verify-code/', {
      method: 'POST',
      body: JSON.stringify({ phone, code }),
    });
  },
  revoke() {
    return call<{ status: string }>('/api/agent/auth/revoke/', { method: 'POST' });
  },
};

// ─── Patients ────────────────────────────────────────────────────

export interface PatientSearchResp {
  count: number;
  results: Patient[];
}

export const patients = {
  byCardNumber(card_number: string) {
    return call<PatientSearchResp>(
      `/api/patients/?card_number=${encodeURIComponent(card_number)}`,
    );
  },
  search(query: string) {
    return call<PatientSearchResp>(
      `/api/patients/?q=${encodeURIComponent(query)}`,
    );
  },
  recentAppointments(patient_id: string) {
    return call<{ patient: Patient; appointments: Appointment[] }>(
      `/api/agent/patients/${patient_id}/recent-appointments/`,
    );
  },
  promoteVisit(visit_id: string) {
    return call<{ appointment_id: string; created: boolean }>(
      `/api/agent/visits/${visit_id}/promote/`,
      { method: 'POST' },
    );
  },
};
