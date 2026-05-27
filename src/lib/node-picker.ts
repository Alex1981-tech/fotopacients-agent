import { fetch } from '@tauri-apps/plugin-http';
import { invoke } from '@tauri-apps/api/core';
import type { Node } from './types';
import { getSettings, setSetting } from './store';

// Default discovery URL — звідки агент бере список нод при першому запуску.
// Можна перевизначити в settings.discovery_url для тестового стенду.
const DEFAULT_DISCOVERY_URL = 'https://photo.vidnova.app';

const TIMEOUT_MS = 2500;

interface RawNode {
  id: string;
  label: string;
  lan_url?: string;
  ts_url?: string;
}

interface DiscoveryResp {
  version: number;
  nodes: RawNode[];
  fallback_url: string;
}

async function probe(url: string): Promise<number | null> {
  const t0 = performance.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const resp = await fetch(`${url}/api/sync/status/`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!resp.ok) return null;
    return performance.now() - t0;
  } catch {
    return null;
  }
}

async function fetchDiscovery(discoveryUrl: string): Promise<DiscoveryResp | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch(`${discoveryUrl}/api/agent/config/`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!resp.ok) return null;
    return await resp.json() as DiscoveryResp;
  } catch {
    return null;
  }
}

export interface NodeProbe {
  node: Node;
  url: string;
  ms: number;
}

async function loadNodes(): Promise<RawNode[]> {
  const settings = await getSettings();
  const discoveryUrl = (settings as any).discovery_url || DEFAULT_DISCOVERY_URL;

  // Спочатку пробуємо отримати свіжий конфіг
  const fresh = await fetchDiscovery(discoveryUrl);
  if (fresh?.nodes?.length) {
    await setSetting('nodes_cache' as any, fresh.nodes as any);
    await setSetting('fallback_url' as any, fresh.fallback_url as any);
    return fresh.nodes;
  }
  // Якщо discovery недоступний — використовуємо кеш
  const cached = (settings as any).nodes_cache as RawNode[] | undefined;
  if (cached?.length) return cached;
  // Останній fallback — discoveryUrl як єдина «нода»
  return [{ id: 'fallback', label: 'Discovery', ts_url: discoveryUrl }];
}

function subnet24(ip: string): string {
  // '192.168.91.92' → '192.168.91'
  const parts = ip.split('.');
  return parts.length >= 3 ? parts.slice(0, 3).join('.') : '';
}

function urlHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch { return ''; }
}

async function getLocalIp(): Promise<string | null> {
  try { return await invoke<string | null>('get_local_ip'); }
  catch { return null; }
}

export async function pingAll(): Promise<NodeProbe[]> {
  const nodes = await loadNodes();
  const probes: Promise<NodeProbe | null>[] = [];
  for (const raw of nodes) {
    const node: Node = { ...raw, url: '' };
    for (const url of [raw.lan_url, raw.ts_url].filter(Boolean) as string[]) {
      probes.push((async () => {
        const ms = await probe(url);
        return ms === null ? null : { node: { ...node, url }, url, ms };
      })());
    }
  }
  const results = (await Promise.all(probes)).filter((r): r is NodeProbe => r !== null);
  const byNode = new Map<string, NodeProbe>();
  for (const r of results.sort((a, b) => a.ms - b.ms)) {
    if (!byNode.has(r.node.id)) byNode.set(r.node.id, r);
  }
  return [...byNode.values()].sort((a, b) => a.ms - b.ms);
}

/**
 * Виборка ноди: «своя» клінічна підмережа в пріоритеті.
 *
 * Логіка:
 * 1. Дізнаємось локальну LAN-IP клієнтського ПК.
 * 2. Серед нод знаходимо ту, у якої lan_url у ТІЙ САМІЙ /24 підмережі — це
 *    «домашня нода» для цієї клініки. Беремо її навіть якщо чужа через
 *    IPsec відповідає швидше (не хочемо ганяти трафік через тунель коли
 *    локальна доступна).
 * 3. Якщо домашньої не знайдено (агент стоїть в іншій мережі) — fallback
 *    на найшвидшу за ping.
 */
export async function pickFastest(): Promise<NodeProbe | null> {
  const localIp = await getLocalIp();
  const myNet = localIp ? subnet24(localIp) : '';

  if (myNet) {
    // Спершу пробуємо лише «свою» ноду — якщо вона жива, повертаємо
    const nodes = await loadNodes();
    const home = nodes.find(n => subnet24(urlHost(n.lan_url || '')) === myNet);
    if (home && home.lan_url) {
      const ms = await probe(home.lan_url);
      if (ms !== null) {
        return { node: { ...home, url: home.lan_url }, url: home.lan_url, ms };
      }
    }
  }

  // Fallback — ping всіх, повертаємо найшвидшу
  const all = await pingAll();
  return all[0] ?? null;
}
