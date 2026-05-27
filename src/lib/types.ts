export type Mode = 'ct' | 'analysis';

export interface Node {
  id: string;
  label: string;
  lan_url?: string;
  ts_url?: string;
  url: string; // активний URL (lan або ts після пінгу)
}

export interface Patient {
  id: string;
  card_number: string;
  full_name: string;
  birth_date: string | null;
}

export interface Appointment {
  id: string;
  kind?: 'appointment' | 'visit';
  date: string;
  doctor_name: string;
  department: string;
  procedure: string;
  doc_number: string;
}

export type TaskStatus = 'queued' | 'uploading' | 'done' | 'failed';

export interface UploadTask {
  id: string;
  mode: Mode;
  patient_id: string;
  patient_name: string;
  appointment_id?: string; // для КТ
  files: { path: string; name: string; size: number }[];
  status: TaskStatus;
  progress: number; // 0..100
  speed_mbps?: number;
  error?: string;
  node_id: string;
  retry_count: number;
  created_at: number;
  finished_at?: number;
}

export interface AuthUser {
  id: string;
  username: string;
  first_name: string;
  last_name: string;
  role: string;
}

export interface AgentSettings {
  mode: Mode;
  token: string | null;
  user: AuthUser | null;
  preferred_node_id: string | null;
  autostart: boolean;
}
