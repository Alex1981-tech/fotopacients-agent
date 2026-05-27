import { load, Store } from '@tauri-apps/plugin-store';
import type { AgentSettings, Mode } from './types';

const DEFAULT_SETTINGS: AgentSettings = {
  mode: 'ct',
  token: null,
  user: null,
  preferred_node_id: null,
  autostart: false,
};

let storeInstance: Store | null = null;

async function getStore(): Promise<Store> {
  if (!storeInstance) {
    storeInstance = await load('agent.json', { autoSave: true, defaults: {} });
  }
  return storeInstance;
}

export async function getSettings(): Promise<AgentSettings> {
  const store = await getStore();
  const settings: Partial<AgentSettings> = {};
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof AgentSettings)[]) {
    const val = await store.get(key);
    if (val !== undefined && val !== null) {
      (settings as Record<string, unknown>)[key] = val;
    }
  }
  return { ...DEFAULT_SETTINGS, ...settings };
}

export async function setSetting<K extends keyof AgentSettings>(
  key: K,
  value: AgentSettings[K],
): Promise<void> {
  const store = await getStore();
  await store.set(key, value);
}

export async function setMode(mode: Mode) { await setSetting('mode', mode); }
export async function clearAuth() {
  await setSetting('token', null);
  await setSetting('user', null);
}
