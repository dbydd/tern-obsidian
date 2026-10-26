// hindsight-api.mjs: Hindsight calls for Carly. The endpoint, bank and root
// come from the vault binding (cfg); request options narrow the tag filter but
// never choose the endpoint, bank or root. Read actions only read; write
// actions only run for an explicit action name.
import { apiCall, defaultScope, resolveSources } from './hindsight.mjs';

const MODEL_ACTIONS = new Set(['list', 'get', 'query', 'create', 'update', 'refresh', 'delete', 'operation']);
const KNOWLEDGE_ACTIONS = new Set(['tree', 'search', 'get', 'create', 'update', 'delete', 'folder', 'refresh', 'operation']);
const BUDGETS = new Set(['low', 'mid', 'high']);
const MATCHES = new Set(['any', 'all', 'any_strict', 'all_strict', 'exact']);
const MODEL_MATCHES = new Set(['any', 'all', 'exact']);
const DETAILS = new Set(['metadata', 'content', 'full']);
const FACT_TYPES = new Set(['world', 'experience', 'observation']);
const SOURCE_FACT_MAX_TOKENS = 4096;
const MAX_EXPANDED_OBSERVATIONS = 8;
const MAX_SOURCES_PER_OBSERVATION = 6;
const MAX_SOURCE_LOOKUPS = 40;
const TRACE_KEYS = ['tool_calls', 'output', 'input', 'memories', 'observations', 'source_facts', 'results', 'facts', 'mental_models'];

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const text = value => String(value ?? '').trim();
const strings = value => (Array.isArray(value) ? value : String(value ?? '').split(',')).map(item => String(item).trim()).filter(Boolean);
const queryString = params => (params.toString() ? '?' + params.toString() : '');
const vaultTag = cfg => 'vault:' + cfg.vault;

function budgetOf(request, cfg) {
  const budget = request.budget ?? cfg.budget;
  if (budget === undefined || budget === null || budget === '') return undefined;
  if (!BUDGETS.has(String(budget))) throw new Error('budget must be low, mid or high');
  return String(budget);
}

function typesOf(value) {
  const types = strings(value);
  if (!types.length) return null;
  for (const type of types) if (!FACT_TYPES.has(type)) throw new Error('types must be world, experience or observation');
  return types;
}

function bodyFrom(request, keys) {
  const body = {};
  for (const key of keys) if (has(request, key) && request[key] !== undefined) body[key] = request[key];
  return body;
}

function tagParams(params, request) {
  for (const tag of strings(request.tags)) params.append('tags', tag);
  if (request.tags_match !== undefined && request.tags_match !== null) {
    if (!MATCHES.has(String(request.tags_match))) throw new Error('tags_match must be any, all, any_strict, all_strict or exact');
    params.set('tags_match', String(request.tags_match));
  }
  if (request.tag_groups !== undefined && request.tag_groups !== null) {
    params.set('tag_groups', typeof request.tag_groups === 'string' ? request.tag_groups : JSON.stringify(request.tag_groups));
  }
}

function scopeOf(cfg, request, filter) {
  const folder = text(request.folder);
  return {
    mode: request.scope === 'bank' ? 'bank' : 'vault',
    vault: cfg.vault,
    folder: folder || null,
    filter: filter || {},
  };
}

const sourceKey = source => [source.root, source.rel, source.document_id, source.state, source.line, source.chunk_id, source.citation_id]
  .map(value => value ?? '').join('\u0000');

function uniqueSources(values) {
  const seen = new Set();
  const out = [];
  for (const source of values) {
    if (!source || typeof source !== 'object') continue;
    const key = sourceKey(source);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(source);
  }
  return out;
}

function enrich(row, resolved) {
  const copy = resolved ? { ...row, ...resolved } : { ...row, source: null, sources: [] };
  copy.sources = uniqueSources([copy.source, ...(copy.sources || [])]);
  return copy;
}

async function resolveRows(cfg, cache, rows) {
  const resolved = await resolveSources(cfg, cache, rows);
  const list = Array.isArray(resolved) ? resolved : [];
  const byId = new Map();
  for (const row of list) if (row && row.id) byId.set(row.id, row);
  return { list, byId };
}

function findNode(roots, id) {
  const stack = Array.isArray(roots) ? [...roots] : [];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (node.id === id) return node;
    if (Array.isArray(node.children)) stack.push(...node.children);
  }
  return null;
}

// Trace tool outputs repeat facts without source ids; collect the ones that do
// carry a document or chunk so an aggregate fact can use the real citation.
function collectFacts(trace) {
  const facts = new Map();
  const walk = (value, depth) => {
    if (!value || typeof value !== 'object' || depth > 8) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (typeof value.id === 'string'
      && ('document_id' in value || 'chunk_id' in value || Array.isArray(value.source_fact_ids))) {
      const known = facts.get(value.id);
      if (!known || (!known.document_id && value.document_id)) facts.set(value.id, value);
    }
    for (const key of TRACE_KEYS) if (value[key] !== undefined && value[key] !== null) walk(value[key], depth + 1);
  };
  walk(trace, 0);
  return facts;
}

// A reflect citation for an observation has no document of its own. Read the
// memory to find its source facts, then read those for the real document ids;
// whatever the service cannot tell us stays unresolved.
async function expandObservations(cfg, rows) {
  const expansions = new Map();
  const targets = rows
    .filter(row => row && typeof row === 'object' && row.id && !row.document_id)
    .slice(0, MAX_EXPANDED_OBSERVATIONS);
  if (!targets.length) return expansions;
  const details = await Promise.all(targets.map(async row => {
    try {
      return { row, detail: await apiCall(cfg, 'GET', '/memories/' + encodeURIComponent(row.id)) };
    } catch {
      return { row, detail: null };
    }
  }));
  const pending = [];
  for (const { row, detail } of details) {
    if (!detail) continue;
    if (detail.document_id) {
      row.document_id = detail.document_id;
      if (detail.chunk_id) row.chunk_id = detail.chunk_id;
      continue;
    }
    const inline = Array.isArray(detail.source_memories) ? detail.source_memories : [];
    const ids = [...new Set([
      ...(Array.isArray(detail.source_memory_ids) ? detail.source_memory_ids : []),
      ...(Array.isArray(detail.source_fact_ids) ? detail.source_fact_ids : []),
      ...inline.map(memory => memory && memory.id).filter(Boolean),
    ])].slice(0, MAX_SOURCES_PER_OBSERVATION);
    if (!ids.length) continue;
    const facts = ids.map(id => {
      const known = inline.find(memory => memory && memory.id === id);
      return known ? { ...known } : { id };
    });
    expansions.set(row.id, facts);
    for (const fact of facts) if (!fact.document_id) pending.push(fact);
  }
  const shared = new Map();
  for (const fact of pending) {
    if (!shared.has(fact.id)) shared.set(fact.id, []);
    shared.get(fact.id).push(fact);
  }
  await Promise.all([...shared.keys()].slice(0, MAX_SOURCE_LOOKUPS).map(async id => {
    try {
      const detail = await apiCall(cfg, 'GET', '/memories/' + encodeURIComponent(id));
      if (detail && typeof detail === 'object') {
        for (const fact of shared.get(id)) Object.assign(fact, detail);
      }
    } catch {
      // The source keeps its unresolved state rather than borrowing a document.
    }
  }));
  return expansions;
}

export async function recall(request = {}, cfg) {
  const query = text(request.query);
  if (!query) throw new Error('Recall needs a query');
  const filter = await defaultScope(cfg, request);
  const body = { query, ...(filter || {}) };
  const budget = budgetOf(request, cfg);
  if (budget) body.budget = budget;
  const types = request.types === undefined || request.types === null ? null : typesOf(request.types);
  if (types) body.types = types;
  for (const key of ['max_tokens', 'prefer_observations', 'min_scores']) {
    if (request[key] !== undefined && request[key] !== null) body[key] = request[key];
  }
  const offset = Number.isFinite(Number(request.offset)) ? Math.max(0, Math.trunc(Number(request.offset))) : 0;
  const limit = Number.isFinite(Number(request.limit)) ? Math.min(100, Math.max(1, Math.trunc(Number(request.limit)))) : 20;
  const include = {};
  if (request.include_source_facts !== false) {
    const asked = Number(request.max_tokens);
    include.source_facts = {
      max_tokens: Number.isFinite(asked) && asked > 0
        ? Math.min(SOURCE_FACT_MAX_TOKENS, Math.max(256, Math.trunc(asked)))
        : SOURCE_FACT_MAX_TOKENS,
    };
  }
  if (request.include_chunks === true) include.chunks = {};
  include.entities = request.include_entities === true ? {} : null;
  body.include = include;

  const result = await apiCall(cfg, 'POST', '/memories/recall', body);
  const page = Array.isArray(result.results) ? result.results : [];
  const window = page.slice(offset, offset + limit);
  const wanted = new Set(window.flatMap(row => row.source_fact_ids || []));
  const expanded = Object.values(result.source_facts || {}).filter(row => wanted.has(row.id));
  const { byId } = await resolveRows(cfg, request.cache, [...window, ...expanded]);
  const expandedById = new Map(expanded.map(row => [row.id, row]));
  const chunks = result.chunks || {};
  const withChunk = row => {
    if (request.include_chunks === true && row.chunk_id && chunks[row.chunk_id]) row.chunk = chunks[row.chunk_id];
    return row;
  };

  const results = window.map(row => {
    const own = enrich(row, byId.get(row.id) || null);
    const facts = (row.source_fact_ids || []).map(id => {
      const raw = expandedById.get(id);
      if (!raw) return null;
      return withChunk(enrich(raw, byId.get(id) || null));
    }).filter(Boolean);
    own.sources = uniqueSources([...(own.sources || []), ...facts.flatMap(fact => fact.sources || [])]);
    if (facts.length) own.source_facts = facts;
    return withChunk(own);
  });
  const answer = {
    root: cfg.root,
    bank: cfg.bankId,
    scope: scopeOf(cfg, request, filter),
    results,
    total: page.length,
    next_offset: offset + results.length < page.length ? offset + results.length : null,
    sources: uniqueSources(results.flatMap(row => row.sources || [])),
    source_facts_truncated: result.source_facts_truncated ?? null,
  };
  if (request.include_entities === true && result.entities) answer.entities = result.entities;
  return answer;
}

export async function reflect(request = {}, cfg) {
  const query = text(request.query);
  if (!query) throw new Error('Reflect needs a query');
  const filter = await defaultScope(cfg, request);
  const body = { query, ...(filter || {}) };
  const budget = budgetOf(request, cfg);
  if (budget) body.budget = budget;
  const types = request.fact_types === undefined || request.fact_types === null ? null : typesOf(request.fact_types);
  if (types) body.fact_types = types;
  for (const key of ['max_tokens', 'response_schema', 'exclude_mental_models', 'exclude_mental_model_ids']) {
    if (request[key] !== undefined && request[key] !== null) body[key] = request[key];
  }
  const include = { facts: {} };
  if (request.trace === true) include.tool_calls = {};
  body.include = include;

  const result = await apiCall(cfg, 'POST', '/reflect', body);
  const based = result.based_on || {};
  const memories = Array.isArray(based.memories) ? based.memories : [];
  const traceFacts = collectFacts(result.trace);
  const rows = memories.map(fact => {
    if (!fact || typeof fact !== 'object') return fact;
    const known = traceFacts.get(fact.id);
    const row = { ...fact };
    if (!row.document_id && known && known.document_id) row.document_id = known.document_id;
    if (!row.chunk_id && known && known.chunk_id) row.chunk_id = known.chunk_id;
    return row;
  });
  const expansions = await expandObservations(cfg, rows);
  const expandedRows = [...expansions.values()].flat();
  const sourceRows = [...new Map(expandedRows.map(row => [row.id, row])).values()];
  const { byId } = await resolveRows(cfg, request.cache, [...rows, ...sourceRows]);

  const basedOnMemories = rows.map(row => {
    if (!row || typeof row !== 'object') return row;
    const own = enrich(row, byId.get(row.id) || null);
    const expanded = (expansions.get(row.id) || []).map(fact => enrich(fact, byId.get(fact.id) || null));
    own.sources = uniqueSources([...(own.sources || []), ...expanded.flatMap(fact => fact.sources || [])]);
    if (expanded.length) own.source_facts = expanded;
    return own;
  });

  const answer = {
    root: cfg.root,
    bank: cfg.bankId,
    scope: scopeOf(cfg, request, filter),
    text: result.text || '',
    structured: result.structured_output ?? null,
    structured_error: result.structured_output_error ?? null,
    based_on: {
      memories: basedOnMemories,
      mental_models: Array.isArray(based.mental_models) ? based.mental_models : [],
      directives: Array.isArray(based.directives) ? based.directives : [],
    },
    sources: uniqueSources(basedOnMemories.flatMap(row => (row && row.sources) || [])),
    usage: result.usage ?? null,
  };
  if (request.trace === true && result.trace) answer.trace = result.trace;
  return answer;
}

async function operation(cfg, request, label) {
  const id = text(request.operation_id ?? request.id);
  if (!id) throw new Error(label + ' operation needs operation_id');
  const params = new URLSearchParams();
  if (request.include_payload === true) params.set('include_payload', 'true');
  const result = await apiCall(cfg, 'GET', '/operations/' + encodeURIComponent(id) + queryString(params));
  return { root: cfg.root, bank: cfg.bankId, action: 'operation', ...result };
}

async function queryModel(request, cfg) {
  const id = text(request.id);
  const question = text(request.query);
  if (!id) throw new Error('Mental model query needs id');
  if (!question) throw new Error('Mental model query needs query');
  const model = await apiCall(cfg, 'GET', '/mental-models/' + encodeURIComponent(id) + '?detail=content');
  const content = text(model.content);
  if (!content) throw new Error('Mental model ' + id + ' has no cached content; refresh it before querying');
  const reflectRequest = bodyFrom(request, [
    'budget', 'max_tokens', 'tags', 'tags_match', 'tag_groups', 'scope', 'folder',
    'fact_types', 'response_schema', 'exclude_mental_models', 'exclude_mental_model_ids', 'trace',
  ]);
  reflectRequest.cache = request.cache;
  reflectRequest.query = question + '\n\nCached mental model "' + (model.name || id) + '" (' + id + '):\n\n' + content;
  const answer = await reflect(reflectRequest, cfg);
  const summary = {
    id: model.id || id,
    name: model.name ?? null,
    source_query: model.source_query ?? null,
    tags: Array.isArray(model.tags) ? model.tags : [],
    max_tokens: model.max_tokens ?? null,
    is_stale: model.is_stale ?? null,
    last_refreshed_at: model.last_refreshed_at ?? null,
    last_memory_seen_at: model.last_memory_seen_at ?? null,
  };
  const { root, bank, ...rest } = answer;
  return {
    root: cfg.root,
    bank: cfg.bankId,
    action: 'query',
    model: summary,
    context_model_id: summary.id,
    context_model_note: 'The cached content of this model was passed as reflect context. The service cannot restrict reflect to one model id, so the answer may also draw on other evidence in the vault bank.',
    ...rest,
  };
}

export async function models(request = {}, cfg) {
  const action = text(request.action);
  if (!MODEL_ACTIONS.has(action)) throw new Error('Unknown mental model action: ' + (action || '(missing)'));
  if (action === 'operation') return operation(cfg, request, 'Mental model');
  if (action === 'query') return queryModel(request, cfg);

  if (action === 'list') {
    const params = new URLSearchParams();
    for (const tag of strings(request.tags)) params.append('tags', tag);
    if (request.tags_match !== undefined && request.tags_match !== null) {
      if (!MODEL_MATCHES.has(String(request.tags_match))) throw new Error('Mental model tags_match must be any, all or exact');
      params.set('tags_match', String(request.tags_match));
    }
    if (request.detail !== undefined && request.detail !== null) {
      if (!DETAILS.has(String(request.detail))) throw new Error('detail must be metadata, content or full');
      params.set('detail', String(request.detail));
    }
    if (request.limit !== undefined && request.limit !== null) {
      params.set('limit', String(Math.min(1000, Math.max(1, Math.trunc(Number(request.limit) || 100)))));
    }
    if (request.offset !== undefined && request.offset !== null) {
      params.set('offset', String(Math.max(0, Math.trunc(Number(request.offset) || 0))));
    }
    const result = await apiCall(cfg, 'GET', '/mental-models' + queryString(params));
    return { root: cfg.root, bank: cfg.bankId, action, ...result };
  }

  if (action === 'create') {
    const name = text(request.name);
    const sourceQuery = text(request.source_query);
    if (!name) throw new Error('Mental model create needs name');
    if (!sourceQuery) throw new Error('Mental model create needs source_query');
    const body = { name, source_query: sourceQuery, tags: request.tags === undefined ? [vaultTag(cfg)] : request.tags };
    if (request.max_tokens !== undefined && request.max_tokens !== null) body.max_tokens = request.max_tokens;
    if (request.trigger !== undefined && request.trigger !== null) body.trigger = request.trigger;
    const result = await apiCall(cfg, 'POST', '/mental-models', body);
    return { root: cfg.root, bank: cfg.bankId, action, ...result };
  }

  const id = text(request.id);
  if (!id) throw new Error('Mental model id is required for ' + action);

  if (action === 'get') {
    const params = new URLSearchParams();
    if (request.detail !== undefined && request.detail !== null) {
      if (!DETAILS.has(String(request.detail))) throw new Error('detail must be metadata, content or full');
      params.set('detail', String(request.detail));
    }
    const result = await apiCall(cfg, 'GET', '/mental-models/' + encodeURIComponent(id) + queryString(params));
    return { root: cfg.root, bank: cfg.bankId, action, ...result };
  }
  if (action === 'refresh') {
    const result = await apiCall(cfg, 'POST', '/mental-models/' + encodeURIComponent(id) + '/refresh');
    return { root: cfg.root, bank: cfg.bankId, action, ...result };
  }
  if (action === 'delete') {
    const result = await apiCall(cfg, 'DELETE', '/mental-models/' + encodeURIComponent(id));
    return { root: cfg.root, bank: cfg.bankId, action, id, ...result };
  }
  const body = bodyFrom(request, ['name', 'source_query', 'tags', 'max_tokens', 'trigger']);
  if (!Object.keys(body).length) throw new Error('Mental model update needs at least one field');
  const result = await apiCall(cfg, 'PATCH', '/mental-models/' + encodeURIComponent(id), body);
  return { root: cfg.root, bank: cfg.bankId, action, ...result };
}

export async function knowledge(request = {}, cfg) {
  const action = text(request.action);
  if (!KNOWLEDGE_ACTIONS.has(action)) throw new Error('Unknown knowledge action: ' + (action || '(missing)'));

  if (action === 'tree') {
    const params = new URLSearchParams();
    tagParams(params, request);
    const result = await apiCall(cfg, 'GET', '/knowledge-base/tree' + queryString(params));
    return { root: cfg.root, bank: cfg.bankId, action, ...result };
  }
  if (action === 'search') {
    const query = text(request.query);
    if (!query) throw new Error('Knowledge search needs query');
    const params = new URLSearchParams({ q: query });
    if (request.limit !== undefined && request.limit !== null) {
      params.set('limit', String(Math.max(1, Math.trunc(Number(request.limit) || 20))));
    }
    tagParams(params, request);
    const result = await apiCall(cfg, 'GET', '/knowledge-base/search' + queryString(params));
    return { root: cfg.root, bank: cfg.bankId, action, ...result };
  }
  if (action === 'operation') return operation(cfg, request, 'Knowledge');

  const id = text(request.id);
  if (action === 'get') {
    if (!id) throw new Error('Knowledge get needs id');
    const result = await apiCall(cfg, 'GET', '/knowledge-base/pages/' + encodeURIComponent(id));
    return { root: cfg.root, bank: cfg.bankId, action, ...result };
  }
  if (action === 'delete') {
    if (!id) throw new Error('Knowledge delete needs id');
    const result = await apiCall(cfg, 'DELETE', '/knowledge-base/nodes/' + encodeURIComponent(id));
    return { root: cfg.root, bank: cfg.bankId, action, id, ...result };
  }
  if (action === 'refresh') {
    if (!id) throw new Error('Knowledge refresh needs id');
    const tree = await apiCall(cfg, 'GET', '/knowledge-base/tree');
    const node = findNode(tree.roots, id);
    if (!node) throw new Error('Knowledge page not found in tree: ' + id);
    if (node.kind !== 'page') throw new Error('Knowledge refresh needs a page, not a folder: ' + id);
    const modelId = text(node.mental_model_id);
    if (!modelId) throw new Error('Knowledge page has no backing mental model: ' + id);
    const result = await apiCall(cfg, 'POST', '/mental-models/' + encodeURIComponent(modelId) + '/refresh');
    return { root: cfg.root, bank: cfg.bankId, action, page_id: id, mental_model_id: modelId, ...result };
  }
  if (action === 'folder') {
    const name = text(request.name);
    if (!name) throw new Error('Knowledge folder needs name');
    const body = { name };
    if (has(request, 'parent_id') && request.parent_id !== undefined) body.parent_id = request.parent_id;
    const result = await apiCall(cfg, 'POST', '/knowledge-base/folders', body);
    return { root: cfg.root, bank: cfg.bankId, action, ...result };
  }
  if (action === 'create') {
    const name = text(request.name);
    const sourceQuery = text(request.source_query);
    if (!name) throw new Error('Knowledge create needs name');
    if (!sourceQuery) throw new Error('Knowledge create needs source_query');
    const body = { name, source_query: sourceQuery };
    if (has(request, 'parent_id') && request.parent_id !== undefined) body.parent_id = request.parent_id;
    body.tags = request.tags === undefined ? [vaultTag(cfg)] : request.tags;
    if (has(request, 'max_tokens') && request.max_tokens !== undefined) body.max_tokens = request.max_tokens;
    if (has(request, 'trigger') && request.trigger !== undefined) body.trigger = request.trigger;
    const result = await apiCall(cfg, 'POST', '/knowledge-base/pages', body);
    return { root: cfg.root, bank: cfg.bankId, action, ...result };
  }

  if (!id) throw new Error('Knowledge update needs id');
  const body = bodyFrom(request, ['name', 'parent_id', 'source_query', 'tags', 'max_tokens', 'trigger']);
  if (!Object.keys(body).length) throw new Error('Knowledge update needs at least one field');
  const result = await apiCall(cfg, 'PATCH', '/knowledge-base/nodes/' + encodeURIComponent(id), body);
  return { root: cfg.root, bank: cfg.bankId, action, ...result };
}
