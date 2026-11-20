// Що агент вантажить: лише КТ (архів з DICOM) і рентгени. Інших файлів немає.
export type ImagingKind = 'ct' | 'panoramic' | 'periapical';

export const KIND_LABEL: Record<ImagingKind, string> = {
  ct: 'КТ',
  panoramic: 'Панорама',
  periapical: 'Прицільний',
};

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

export type TaskStatus = 'queued' | 'uploading' | 'done' | 'failed' | 'duplicate';

export interface DuplicateInfo {
  name: string;
  match: 'content' | 'name';   // той самий файл vs та сама назва
  existing_name: string;
  existing_uploaded_at: string;
}

export interface UploadTask {
  id: string;
  kind?: ImagingKind;           // відсутній у задачах до 0.2.0 (аналізи)
  patient_id: string;
  patient_name: string;
  files: { path: string; name: string; size: number }[];
  status: TaskStatus;
  progress: number; // 0..100
  speed_mbps?: number;
  error?: string;
  node_id: string;
  retry_count: number;
  created_at: number;
  finished_at?: number;
  force?: boolean;              // користувач підтвердив повторне завантаження
  duplicates?: DuplicateInfo[]; // знайдені дублі (status='duplicate')
  // КТ частинами (20.11.2026): що зараз робимо, id завантаження на ноді (для докачування), SHA-256,
  // тимчасовий архів папки (видаляємо після), скільки вже на сервері
  stage?: 'zipping' | 'hashing' | 'uploading' | 'finishing' | 'waiting_net';
  server_upload_id?: string;
  sha256?: string;
  temp_zip?: string;
  uploaded_bytes?: number;
}

export interface AuthUser {
  id: string;
  username: string;
  first_name: string;
  last_name: string;
  role: string;
}

// Нода, до якої агент «прибитий» на час сесії. Вибирається ОДИН раз при
// логіні (домашня /24 → інакше найшвидша) і далі не міняється — агент не
// скаче між нодами, бо токен існує лише на тій ноді, де відбувся логін.
export interface PinnedNode {
  id: string;
  label: string;
  url: string;
}

// Світлий опис ноди для екрану входу (до того як обрано прибиту ноду).
export interface LoginNode {
  id: string;
  label: string;
  url: string;
  ms: number | null;
}

export interface AgentSettings {
  token: string | null;
  user: AuthUser | null;
  preferred_node_id: string | null;
  autostart: boolean;
  // Прибита нода поточної сесії (null до першого логіну).
  pinned_node: PinnedNode | null;
  // Коли локально скинути токен (epoch ms = сьогодні 20:00 з бекенду).
  // Сервер однаково відхилить токен після вікна, це — клієнтський дубль.
  session_expires_at: number | null;
}
