import { readFile, stat, realpath, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { matchesFilter } from './vault-filters.mjs';

const CONFIG_FILE = '.obsidian/plugins/hindsight/data.json';
// All Tern state for a vault lives inside it, next to the Obsidian plugin's
// own config, so it travels with the vault instead of Tern's global kv.
const STATE_DIR = '.obsidian/tern-obsidian';
const CONFIG_KEYS = new Set(['apiUrl', 'apiKey', 'bankId', 'includeFolders', 'excludeFolders', 'prefixDocId', 'defaultBudget', 'syncOnEdit', 'observationScopes']);
const defaults = { apiUrl: '', apiKey: '', bankId: '', includeFolders: [], excludeFolders: [], prefixDocId: true, defaultBudget: 'low', syncOnEdit: false };
const list = value => value == null ? [] : Array.isArray(value) ? value.map(String).map(v => v.trim()).filter(Boolean) : typeof value === 'object' && Object.keys(value).length === 0 ? [] : String(value).split(',').map(v => v.trim()).filter(Boolean);
const endpoint = value => String(value || '').trim().replace(/\/+$/, '');
const timestamp = value => {
  const at = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
};

export async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.' + randomUUID();
  await writeFile(temporary, JSON.stringify(value));
  await rename(temporary, file);
}

export function keyFor(cfg) {
  return createHash('sha256').update(`${cfg.root}|${cfg.apiUrl}|${cfg.bankId}|${cfg.prefix}`).digest('hex').slice(0, 16);
}

export const settingsFile = root => path.join(root, STATE_DIR, 'settings.json');
export const bindingDir = (root, cfg) => path.join(root, STATE_DIR, 'hindsight', keyFor(cfg));

export async function readSettings(root) { return readJson(settingsFile(root), {}); }
export async function writeSettings(root, value) { await writeJson(settingsFile(root), value); }

export async function loadConfig(root, cache, { required = true } = {}) {
  // A symlinked path (/tmp on macOS) must not produce a second binding key.
  try { root = await realpath(root); } catch {}
  const reference = await readJson(path.join(root, CONFIG_FILE), {});
  const settings = await readSettings(root);
  const overrides = settings.hindsight || {};
  const stored = reference.settings || {};
  const merged = { ...defaults, ...stored, ...overrides };
  const apiUrl = endpoint(merged.apiUrl);
  const bankId = String(merged.bankId || '').trim();
  if (required && (!apiUrl || !bankId)) throw new Error(`Hindsight is not configured for ${root}: set API URL and bank explicitly`);
  if (apiUrl) {
    const url = new URL(apiUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Hindsight API URL must be an HTTP(S) URL without credentials, query or fragment');
  }
  if (!['low', 'mid', 'high'].includes(merged.defaultBudget)) throw new Error('Hindsight budget must be low, mid or high');
  const filters = settings.filters || {};
  const prefix = merged.prefixDocId !== false;
  const sameBinding = apiUrl === endpoint(stored.apiUrl) && bankId === String(stored.bankId || '').trim() && prefix === (stored.prefixDocId !== false);
  return {
    root, vault: path.basename(root), apiUrl, bankId, apiKey: String(merged.apiKey || '').trim(),
    include: list(merged.includeFolders), exclude: list(merged.excludeFolders), prefix,
    budget: merged.defaultBudget, syncOnEdit: merged.syncOnEdit === true,
    observationScopes: merged.observationScopes ?? undefined,
    source: Object.keys(overrides).length ? 'tern+obsidian' : reference.settings ? 'obsidian' : 'unconfigured',
    filters: { allow: list(filters.allow), deny: list(filters.deny) },
    baseline: sameBinding ? reference.syncIndex || {} : {},
    referenceLastSyncAt: sameBinding ? reference.lastSyncAt || null : null,
  };
}

export async function apiCall(cfg, method, route, body) {
  const headers = { 'content-type': 'application/json' };
  if (cfg.apiKey) headers.authorization = 'Bearer ' + cfg.apiKey;
  const response = await fetch(`${cfg.apiUrl}/v1/default/banks/${encodeURIComponent(cfg.bankId)}${route}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000),
  });
  const text = await response.text();
  if (!response.ok) {
    const detail = cfg.apiKey ? text.replaceAll(cfg.apiKey, '[redacted]') : text;
    throw new Error(`Hindsight ${method} ${route} → HTTP ${response.status}: ${detail.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : {};
}

const within = (rel, folder) => { const clean = folder.replace(/^\/+|\/+$/g, ''); return !clean || rel === clean || rel.startsWith(clean + '/'); };
export function isSelected(rel, cfg) {
  if (!rel.toLowerCase().endsWith('.md')) return false;
  if (rel.split('/').some(part => part.startsWith('.') || part === 'node_modules')) return false;
  if (cfg.exclude.some(folder => within(rel, folder))) return false;
  if (cfg.include.length && !cfg.include.some(folder => within(rel, folder))) return false;
  if (cfg.filters.deny.some(pattern => matchesFilter(pattern, rel))) return false;
  return !cfg.filters.allow.length || cfg.filters.allow.some(pattern => matchesFilter(pattern, rel));
}

export function buildItem(source, rel, cfg, info) {
  const clean = source.replace(/^\uFEFF/, '');
  const match = clean.match(/^---\r?\n([\s\S]*?)(?:\r?\n---|\r?\n\.\.\.)(?:\r?\n|$)/);
  const props = match ? Bun.YAML.parse(match[1]) || {} : {};
  const body = (match ? clean.slice(match[0].length) : clean).trim();
  if (!body) return null;
  const ctime = info.birthtimeMs || info.ctimeMs;
  const occurred = timestamp(props.created ?? props.date) || timestamp(ctime);
  const tags = [...list(props.tags ?? props.tag).flatMap(v => v.split(/[\s,]+/)), ...list(props.aliases ?? props.alias)];
  tags.push(`vault:${cfg.vault}`);
  const folders = path.posix.dirname(rel).split('/');
  if (folders[0] !== '.') folders.forEach((_, i) => tags.push('folder:' + folders.slice(0, i + 1).join('/')));
  for (const [prefix, value] of [['created', occurred], ['updated', timestamp(info.mtimeMs)]]) {
    tags.push(`${prefix}:${value.slice(0, 4)}`, `${prefix}:${value.slice(0, 7)}`);
  }
  const metadata = {};
  for (const [key, value] of Object.entries(props)) {
    if (['tags', 'tag', 'alias', 'aliases', 'created', 'date'].includes(key.toLowerCase())) continue;
    if (['string', 'number', 'boolean'].includes(typeof value)) metadata[key.toLowerCase()] = String(value);
  }
  const folder = path.posix.dirname(rel);
  if (folder !== '.') metadata.folder = folder;
  const item = {
    content: body, document_id: cfg.prefix ? `${cfg.vault}/${rel}` : rel,
    context: 'obsidian', update_mode: 'replace', tags: [...new Set(tags)],
    metadata: { ...metadata, vault: cfg.vault, path: rel }, timestamp: occurred,
  };
  if (cfg.observationScopes !== undefined) item.observation_scopes = cfg.observationScopes;
  return item;
}

export function defaultScope(cfg, opts) {
  const groups = opts.scope === 'bank' ? [] : [{ tags: [`vault:${cfg.vault}`], match: 'all_strict' }];
  if (opts.scope && !['bank', 'vault'].includes(opts.scope)) throw new Error('scope must be vault or bank');
  if (opts.folder) groups.push({ tags: ['folder:' + opts.folder.replace(/^\/+|\/+$/g, '')], match: 'all_strict' });
  if (opts.tags !== undefined) groups.push({ tags: list(opts.tags), match: opts.tags_match || 'all_strict' });
  if (opts.tag_groups) groups.push(...opts.tag_groups);
  return groups.length ? { tag_groups: groups } : {};
}

export async function resolveSources(cfg, cache, rows) {
  const index = await readJson(path.join(bindingDir(cfg.root, cfg), 'index.json'), { files: {} });
  const known = { ...cfg.baseline, ...index.files };
  const byDoc = new Map(Object.entries(known).map(([rel, entry]) => [entry.docId || (cfg.prefix ? cfg.vault + '/' + rel : rel), rel]));
  return Promise.all(rows.map(async row => {
    const id = row.document_id || null;
    let rel = id ? byDoc.get(id) : null;
    if (!rel && id && cfg.prefix && id.startsWith(cfg.vault + '/')) rel = id.slice(cfg.vault.length + 1);
    if (!rel && id && !cfg.prefix && !path.isAbsolute(id)) rel = id;
    if (!rel && row.metadata?.vault === cfg.vault && row.metadata?.path) rel = row.metadata.path;
    const source = { root: cfg.root, rel: rel || null, path: null, document_id: id, citation_id: row.id || null, chunk_id: row.chunk_id || null, state: 'unresolved' };
    if (rel) {
      const absolute = path.resolve(cfg.root, rel);
      if (!absolute.startsWith(cfg.root + path.sep)) source.rel = null;
      else {
        source.path = absolute;
        try {
          const canonical = await realpath(absolute);
          if (!canonical.startsWith(cfg.root + path.sep)) { source.rel = null; source.path = null; }
          else {
            const info = await stat(canonical);
            const entry = known[rel];
            source.state = 'current';
            if (entry && info.mtimeMs !== entry.mtime) {
              const hash = 'sha256:' + createHash('sha256').update(await readFile(canonical)).digest('hex');
              if (hash !== entry.hash) source.state = 'stale';
            }
            if (!isSelected(rel, cfg)) source.state = 'excluded';
            if (Number.isInteger(row.metadata?.line) && row.metadata.line > 0) source.line = row.metadata.line;
          }
        } catch (error) {
          if (error.code === 'ENOENT') source.state = 'stale'; else throw error;
        }
      }
    }
    return { ...row, document_id: id, source, sources: id && source.rel ? [source] : [] };
  }));
}

export async function configuration(request, root) {
  if (request.patch) {
    for (const key of Object.keys(request.patch)) if (!CONFIG_KEYS.has(key)) throw new Error('Unknown Hindsight setting: ' + key);
    for (const [key, value] of Object.entries(request.patch)) {
      if (value === null) continue;
      if (['apiUrl', 'apiKey', 'bankId', 'defaultBudget'].includes(key) && typeof value !== 'string') throw new Error(key + ' must be a string');
      if (['syncOnEdit', 'prefixDocId'].includes(key) && typeof value !== 'boolean') throw new Error(key + ' must be a boolean');
      if (['includeFolders', 'excludeFolders'].includes(key) && (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !v.trim()))) throw new Error(key + ' must be an array of non-empty folder names');
      if (key === 'observationScopes' && !(typeof value === 'string' && ['per_tag', 'combined', 'all_combinations', 'shared'].includes(value)) && !(Array.isArray(value) && value.every(tags => Array.isArray(tags) && tags.every(tag => typeof tag === 'string')))) throw new Error('observationScopes must be a scope mode or array of tag arrays');
      if (key === 'defaultBudget' && !['low', 'mid', 'high'].includes(value)) throw new Error('defaultBudget must be low, mid or high');
      if (key === 'apiUrl' && value) {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid API URL');
      }
    }
    const settings = await readSettings(root);
    const entry = (settings.hindsight ||= {});
    for (const [key, value] of Object.entries(request.patch)) {
      if (value === null) delete entry[key]; else entry[key] = value;
    }
    await writeSettings(root, settings);
  }
  const cfg = await loadConfig(root, request.cache, { required: false });
  return { root, configured: Boolean(cfg.apiUrl && cfg.bankId), endpoint: cfg.apiUrl, bank: cfg.bankId, hasApiKey: Boolean(cfg.apiKey), configSource: cfg.source, scope: { include: cfg.include, exclude: cfg.exclude, filters: cfg.filters, prefixDocId: cfg.prefix, budget: cfg.budget, syncOnEdit: cfg.syncOnEdit, observationScopes: cfg.observationScopes || null } };
}

export async function dispatch(request, root) {
  request.cache ||= process.env.TERN_PLUGIN_DATA || path.join(os.homedir(), '.cache', 'tern-obsidian');
  if (request.op === 'hindsight-config') return configuration(request, root);
  if (['hindsight-status', 'hindsight-sync', 'hindsight-sync-run', 'hindsight-watch'].includes(request.op)) {
    const sync = await import('./hindsight-sync.mjs');
    if (request.op === 'hindsight-status') return sync.syncStatus(request, root);
    if (request.op === 'hindsight-sync') return sync.prepareSync(request, root);
    if (request.op === 'hindsight-sync-run') return sync.runSync(request, root);
    return sync.watchVault(request, root);
  }
  const cfg = await loadConfig(root, request.cache);
  const api = await import('./hindsight-api.mjs');
  if (request.op === 'hindsight-recall') return api.recall(request, cfg);
  if (request.op === 'hindsight-reflect') return api.reflect(request, cfg);
  if (request.op === 'hindsight-models') return api.models(request, cfg);
  if (request.op === 'hindsight-knowledge') return api.knowledge(request, cfg);
  throw new Error('Unknown Hindsight op: ' + request.op);
}
