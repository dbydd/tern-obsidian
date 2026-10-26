// hindsight-sync.mjs: durable, restartable vault-twin sync for Tern.
//
// prepareSync claims the binding's lock and writes a job record; the long Tern
// process then calls runSync with that job_id. A retain operation id is written
// to pending.json before its POST, so a retry after a lost acknowledgement
// resubmits the same idempotent operation instead of creating a second update.
import { readdir, readFile, stat, mkdir, unlink, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { loadConfig, apiCall, readJson, writeJson, isSelected, buildItem, keyFor, bindingDir } from './hindsight.mjs';

const CONCURRENCY = 3;
const DEBOUNCE_MS = 4000;
const POLL_BUDGET_MS = 60_000;
const POLL_BASE_MS = 500;
const POLL_MAX_MS = 5_000;
const PREPARED_STALE_MS = 60_000;
const RUNNING_STALE_MS = 120_000;
const HEARTBEAT_MS = 10_000;
const PREPARE_GRACE_MS = 5_000;
const WATCH_HEARTBEAT_MS = 15_000;
const WATCH_CHECK_MS = 10_000;
const WATCH_TAKEOVER_TRIES = 20;

const ACTIVE = new Set(['prepared', 'running']);
const TERMINAL = new Set(['done', 'failed', 'incomplete', 'interrupted']);

const INDEX_FILE = 'index.json';
const PENDING_FILE = 'pending.json';
const BINDING_FILE = 'binding.json';
const JOB_FILE = 'job.json';
const LOCK_FILE = 'lock.json';
const WATCH_LOCK_FILE = 'watch.lock.json';
const JOBS_DIR = 'jobs';

const now = () => new Date().toISOString();
const epoch = value => {
  const at = typeof value === 'number' ? value : Date.parse(value || '');
  return Number.isFinite(at) ? at : NaN;
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const cacheFor = request => request?.cache || path.join(os.homedir(), '.cache', 'tern-obsidian');
const jobIdOf = request => request?.job_id ?? request?.job ?? null;
const safeName = value => String(value).replace(/[^A-Za-z0-9._-]/g, '_');
const hashOf = source => 'sha256:' + createHash('sha256').update(source).digest('hex');
const docIdFor = (rel, cfg) => (cfg.prefix ? `${cfg.vault}/${rel}` : rel);
const encodeDocId = value => String(value).split('/').map(encodeURIComponent).join('/');

// writeJson renames through a pid-named temporary file, so two writes to the
// same path must not overlap. All state writes go through this per-path chain.
const writeChains = new Map();
function persist(file, value) {
  const base = (writeChains.get(file) || Promise.resolve()).catch(() => {});
  const next = base.then(() => writeJson(file, value));
  writeChains.set(file, next);
  return next;
}

async function pool(items, limit, worker) {
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: width }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

async function markdownFiles(root) {
  const out = [];
  async function walk(dir) {
    for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const rel = dir ? dir + '/' + entry.name : entry.name;
      if (entry.isDirectory()) await walk(rel);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) out.push(rel);
    }
  }
  await walk('');
  return out.sort();
}

async function openState(cfg, cache) {
  const key = String(keyFor(cfg));
  // The binding's state lives in the vault, so switching machines keeps the
  // index and job history with the notes it describes.
  const dir = bindingDir(cfg.root, cfg);
  // Locks stay machine-local: the vault directory syncs to other machines,
  // where a pid means nothing and a lock file would only churn.
  await mkdir(path.join(dir, JOBS_DIR), { recursive: true });
  const local = path.join(cache, 'hindsight', key);
  await mkdir(local, { recursive: true });
  return { key, dir, local, cfg };
}

const statePath = (state, name) => path.join(state.dir, name);
const lockPath = (state, name) => path.join(state.local, name);
const jobPath = (state, id) => path.join(state.dir, JOBS_DIR, safeName(id) + '.json');

async function ensureBinding(state) {
  const file = statePath(state, BINDING_FILE);
  const cfg = state.cfg;
  const existing = await readJson(file, null);
  const baseline = cfg.baseline && typeof cfg.baseline === 'object' ? cfg.baseline : {};
  const count = Object.keys(baseline).length;
  if (existing
    && existing.key === state.key
    && existing.root === cfg.root
    && existing.apiUrl === cfg.apiUrl
    && existing.bankId === cfg.bankId
    && existing.prefix === cfg.prefix) {
    if (!existing.inheritedAt && !existing.baselineCount && count > 0) {
      existing.baselineCount = count;
      existing.baselineSource = 'inherited';
      existing.inheritedAt = now();
      existing.referenceLastSyncAt = cfg.referenceLastSyncAt ?? existing.referenceLastSyncAt ?? null;
      await persist(file, existing);
    }
    return existing;
  }
  const binding = {
    version: 1,
    key: state.key,
    root: cfg.root,
    vault: cfg.vault,
    apiUrl: cfg.apiUrl,
    bankId: cfg.bankId,
    prefix: cfg.prefix,
    createdAt: now(),
    baselineCount: count,
    baselineSource: cfg.baselineSource || (count ? 'inherited' : 'none'),
    referenceLastSyncAt: cfg.referenceLastSyncAt ?? null,
    inheritedAt: count ? now() : null,
  };
  await persist(file, binding);
  return binding;
}

async function loadIndex(state) {
  const stored = await readJson(statePath(state, INDEX_FILE), null);
  return {
    files: stored && typeof stored.files === 'object' && stored.files ? stored.files : {},
    lastSyncAt: stored?.lastSyncAt || null,
  };
}

async function saveIndex(state, index) {
  await persist(statePath(state, INDEX_FILE), { files: index.files, lastSyncAt: index.lastSyncAt || null });
}

async function loadPending(state) {
  const stored = await readJson(statePath(state, PENDING_FILE), null);
  return stored && typeof stored === 'object' ? stored : {};
}

async function savePending(state, pending) {
  await persist(statePath(state, PENDING_FILE), pending);
}

async function readJob(state, id) {
  if (!id) return null;
  return readJson(jobPath(state, id), null);
}

async function saveJob(state, job, pointer = false) {
  job.updatedAt = now();
  await persist(jobPath(state, job.job_id), job);
  if (pointer) await persist(statePath(state, JOB_FILE), job);
  await beat(state, job.job_id);
}

const beats = new Map();
async function beat(state, jobId) {
  const key = state.dir + '|' + jobId;
  if (Date.now() - (beats.get(key) || 0) < HEARTBEAT_MS) return;
  beats.set(key, Date.now());
  await heartbeat(state, jobId);
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function lockStale(lock, job) {
  if (!lock) return true;
  if (job && TERMINAL.has(job.state)) return true;
  const last = epoch(lock.heartbeatAt ?? lock.acquiredAt);
  if (!Number.isFinite(last)) return true;
  const prepared = Boolean(job && job.state === 'prepared');
  const limit = prepared ? PREPARED_STALE_MS : RUNNING_STALE_MS;
  if (Date.now() - last > limit) return true;
  // A dead preparer's fresh lock is still adoptable as a prepared job; a dead
  // runner's lock is not.
  if (!alive(lock.pid)) return !prepared;
  return false;
}

const readLock = state => readJson(lockPath(state, LOCK_FILE), null);

async function heartbeat(state, jobId) {
  const lock = await readLock(state);
  if (!lock || lock.job_id !== jobId || lock.pid !== process.pid) return;
  lock.heartbeatAt = now();
  lock.pid = process.pid;
  await persist(lockPath(state, LOCK_FILE), lock);
}

async function unlinkLock(state) {
  try {
    await unlink(lockPath(state, LOCK_FILE));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function releaseLock(state, jobId) {
  const file = lockPath(state, LOCK_FILE);
  const queued = writeChains.get(file);
  if (queued) await queued.catch(() => {});
  const lock = await readLock(state);
  if (!lock || lock.job_id !== jobId || lock.pid !== process.pid) return;
  await unlinkLock(state);
  writeChains.delete(file);
}

async function markInterrupted(state, job, reason) {
  if (!job || !ACTIVE.has(job.state)) return job;
  job.state = 'interrupted';
  job.interruption = reason;
  job.finishedAt = now();
  job.updatedAt = now();
  job.errors = [...(job.errors || []), reason].slice(-50);
  await persist(jobPath(state, job.job_id), job);
  const pointer = await readJson(statePath(state, JOB_FILE), null);
  if (pointer && pointer.job_id === job.job_id) await persist(statePath(state, JOB_FILE), job);
  return job;
}

async function claimLock(state, jobId, meta) {
  const file = lockPath(state, LOCK_FILE);
  const record = { job_id: jobId, pid: process.pid, acquiredAt: now(), heartbeatAt: now(), ...meta };
  const existing = await readLock(state);
  if (existing && existing.job_id !== jobId) {
    const other = await readJob(state, existing.job_id);
    if (!other) {
      await unlinkLock(state);
    } else if (!lockStale(existing, other)) {
      return { acquired: false, lock: existing, job: other };
    } else {
      await markInterrupted(state, other, 'process stopped before finishing');
      await unlinkLock(state);
    }
  } else if (existing && existing.job_id === jobId) {
    const current = await readJob(state, jobId);
    if (existing.pid === process.pid) {
      existing.heartbeatAt = now();
      existing.pid = process.pid;
      await persist(file, existing);
      return { acquired: true, lock: existing };
    }
    const deadPreparer = Boolean(current && current.state === 'prepared' && !alive(existing.pid));
    if (!deadPreparer && !lockStale(existing, current)) {
      return { acquired: false, lock: existing, job: current };
    }
    // A dead preparer or a stale runner: replace the lock atomically so two
    // claimers cannot both take it.
    await unlinkLock(state);
  }
  try {
    await mkdir(state.dir, { recursive: true });
    await writeFile(file, JSON.stringify(record), { flag: 'wx' });
    return { acquired: true, lock: record };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const lock = await readLock(state);
    if (lock && lock.job_id === jobId && lock.pid === process.pid) {
      lock.heartbeatAt = now();
      await persist(file, lock);
      return { acquired: true, lock };
    }
    return { acquired: false, lock, job: lock ? await readJob(state, lock.job_id) : null };
  }
}

function summary(job, extra = {}) {
  return {
    job_id: job?.job_id || null,
    root: job?.root || null,
    bank: job?.bank || null,
    state: job?.state || 'idle',
    submitted: job?.submitted || 0,
    ingested: job?.ingested || 0,
    failed: job?.failed || 0,
    deleted: job?.deleted || 0,
    skipped: job?.skipped || 0,
    total: job?.total || 0,
    remaining: job?.remaining || 0,
    pending: job?.pending || 0,
    startedAt: job?.startedAt || null,
    finishedAt: job?.finishedAt || null,
    errors: job?.errors || [],
    ...extra,
  };
}

export async function prepareSync(request = {}, root) {
  const cache = cacheFor(request);
  const cfg = await loadConfig(root, cache, { required: true });
  const state = await openState(cfg, cache);
  await ensureBinding(state);

  const lock = await readLock(state);
  if (lock) {
    const lockJob = await readJob(state, lock.job_id);
    if (!lockJob) {
      // A prepare claims the lock just before writing its job record. Give it
      // a moment; only a lock older than that is an abandoned claim.
      const age = Date.now() - epoch(lock.acquiredAt);
      if (Number.isFinite(age) && age >= 0 && age < PREPARE_GRACE_MS) {
        return { job_id: lock.job_id, root: cfg.root, bank: cfg.bankId, state: 'prepared', launch: false };
      }
      await unlinkLock(state);
    } else if (lockStale(lock, lockJob)) {
      await markInterrupted(state, lockJob, 'process stopped before finishing');
      await unlinkLock(state);
    } else if (lockJob.state === 'prepared' && !alive(lock.pid)) {
      // A dead preparer left a fresh prepared job. Release the lock so the
      // current-job branch below can hand it to this caller.
      await unlinkLock(state);
    } else if (ACTIVE.has(lockJob.state)) {
      return { job_id: lockJob.job_id, root: cfg.root, bank: cfg.bankId, state: lockJob.state, launch: false };
    } else {
      await unlinkLock(state);
    }
  }

  const current = await readJson(statePath(state, JOB_FILE), null);
  if (current && ACTIVE.has(current.state)) {
    const lockNow = await readLock(state);
    if (lockNow && lockNow.job_id === current.job_id && !lockStale(lockNow, current)) {
      return { job_id: current.job_id, root: cfg.root, bank: cfg.bankId, state: current.state, launch: false };
    }
    // A prepared job without a lock is a launch that has not been picked up
    // yet. It can be launched by this caller; runSync's lock makes concurrent
    // launches collapse to one runner.
    if (current.state === 'prepared' && !lockNow) {
      const age = Date.now() - epoch(current.updatedAt || current.createdAt);
      if (Number.isFinite(age) && age >= 0 && age < PREPARED_STALE_MS) {
        return { job_id: current.job_id, root: cfg.root, bank: cfg.bankId, state: 'prepared', launch: true };
      }
    }
    await markInterrupted(state, current, 'process stopped before finishing');
  }

  const jobId = 'hs-' + Date.now().toString(36) + '-' + randomUUID().slice(0, 8);
  const job = {
    job_id: jobId,
    root: cfg.root,
    bank: cfg.bankId,
    endpoint: cfg.apiUrl,
    key: state.key,
    force: Boolean(request.force),
    state: 'prepared',
    total: 0,
    submitted: 0,
    ingested: 0,
    failed: 0,
    deleted: 0,
    skipped: 0,
    remaining: 0,
    pending: 0,
    attempts: 0,
    createdAt: now(),
    startedAt: null,
    updatedAt: now(),
    finishedAt: null,
    errors: [],
    baselineInherited: 0,
  };
  const claim = await claimLock(state, jobId, { root: cfg.root, bank: cfg.bankId, key: state.key });
  if (!claim.acquired) {
    const other = claim.job || (claim.lock ? await readJob(state, claim.lock.job_id) : null);
    return {
      job_id: other?.job_id || claim.lock?.job_id || null,
      root: cfg.root,
      bank: cfg.bankId,
      state: other?.state || 'prepared',
      launch: false,
    };
  }
  // Another prepare may have written a job while this one waited for the
  // lock. Adopt it instead of overwriting the pointer with a second job.
  const latest = await readJson(statePath(state, JOB_FILE), null);
  if (latest && ACTIVE.has(latest.state) && latest.job_id !== jobId) {
    await releaseLock(state, jobId);
    return {
      job_id: latest.job_id,
      root: cfg.root,
      bank: cfg.bankId,
      state: latest.state,
      launch: latest.state === 'prepared',
    };
  }
  await saveJob(state, job, true);
  // The runner runs in a separate process and must be able to claim the lock.
  await releaseLock(state, jobId);
  return { job_id: jobId, root: cfg.root, bank: cfg.bankId, state: 'prepared', launch: true };
}

const activeRuns = new Map();

export async function runSync(request = {}, root) {
  const requested = jobIdOf(request);
  if (requested) {
    const running = activeRuns.get(requested);
    if (running) return running;
  }
  const promise = startSync(request, root);
  if (requested) {
    activeRuns.set(requested, promise);
    promise.then(() => {}, () => {}).finally(() => {
      if (activeRuns.get(requested) === promise) activeRuns.delete(requested);
    });
  }
  return promise;
}

async function startSync(request, root) {
  const cache = cacheFor(request);
  const cfg = await loadConfig(root, cache, { required: true });
  const state = await openState(cfg, cache);
  const requested = jobIdOf(request);
  const job = requested ? await readJob(state, requested) : await readJson(statePath(state, JOB_FILE), null);
  if (!job) throw new Error('Unknown Hindsight sync job' + (requested ? ': ' + requested : ''));
  if (job.key && job.key !== state.key) throw new Error('Hindsight sync job belongs to another binding');
  if (job.root && job.root !== cfg.root) throw new Error('Hindsight sync job belongs to another vault');
  // A caller holding a job id may resume an interrupted, incomplete or failed
  // job; pending operations are durable. Without an explicit id, a terminal
  // pointer is not retried implicitly.
  if (TERMINAL.has(job.state) && (!requested || job.state === 'done')) {
    return summary(job, { launch: false });
  }
  return executeSync(state, job, request);
}

async function executeSync(state, job, request) {
  const cfg = state.cfg;
  const claim = await claimLock(state, job.job_id, { root: cfg.root, bank: cfg.bankId, key: state.key });
  if (!claim.acquired) {
    const other = claim.job || (claim.lock ? await readJob(state, claim.lock.job_id) : null);
    return summary(other || job, { launch: false, active_job: claim.lock?.job_id || null });
  }

  let index = { files: {}, lastSyncAt: null };
  let pending = {};
  let binding = null;
  const addError = message => {
    const text = String(message || '').slice(0, 500);
    if (!text || job.errors.includes(text)) return;
    job.errors.push(text);
    if (job.errors.length > 50) job.errors.splice(0, job.errors.length - 50);
  };

  try {
    const resuming = (job.attempts || 0) > 0;
    job.state = 'running';
    job.startedAt = job.startedAt || now();
    job.finishedAt = null;
    job.attempts = (job.attempts || 0) + 1;
    job.force = request.force === undefined ? Boolean(job.force) : Boolean(request.force);
    job.total = 0;
    if (!resuming) {
      job.submitted = 0;
      job.ingested = 0;
      job.deleted = 0;
    }
    job.failed = 0;
    job.skipped = 0;
    job.remaining = 0;
    job.pending = 0;
    job.errors = [];
    await saveJob(state, job, true);

    index = await loadIndex(state);
    pending = await loadPending(state);
    binding = await ensureBinding(state);
    job.baselineInherited = binding.baselineCount || 0;

    const resolved = new Set();
    const present = new Set();
    const scanned = new Map();
    let selectedSet = new Set();

    // A document the Obsidian plugin already indexed stays owned by it, even
    // after Tern rewrites its content: Tern must never delete inherited docs.
    const ownerFor = rel => {
      if (cfg.baseline && cfg.baseline[rel]) return 'obsidian';
      if (index.files[rel] && index.files[rel].owner === 'obsidian') return 'obsidian';
      return 'tern';
    };

    const submit = async (rel, source, info, hash, mtime, existingOperation) => {
      const item = await buildItem(source, rel, cfg, info);
      if (!item || !String(item.content || '').trim()) {
        job.skipped++;
        resolved.add(rel);
        return;
      }
      const documentId = item.document_id || docIdFor(rel, cfg);
      const payload = {
        ...item,
        document_id: documentId,
        context: item.context || 'obsidian',
        update_mode: item.update_mode || 'replace',
      };
      const operationId = existingOperation || randomUUID();
      const previous = pending[rel];
      pending[rel] = {
        hash,
        mtime,
        docId: documentId,
        owner: ownerFor(rel),
        operationId,
        status: 'submitting',
        acknowledged: previous?.acknowledged === true,
        submittedAt: now(),
        attempts: (previous?.attempts || 0) + 1,
        nextPollAt: 0,
      };
      // The operation id must be durable before the POST: if the response is
      // lost, the next attempt resubmits this exact id and the service returns
      // the original operation instead of enqueuing a duplicate.
      await savePending(state, pending);
      await beat(state, job.job_id);
      try {
        const result = await apiCall(cfg, 'POST', '/memories', {
          items: [payload],
          async: true,
          operation_id: operationId,
        });
        if (result && result.success === false) throw new Error('Hindsight retain returned success=false');
        const accepted = String(result?.operation_id
          || (Array.isArray(result?.operation_ids) && result.operation_ids[0])
          || operationId);
        pending[rel] = {
          ...pending[rel],
          operationId: accepted,
          status: 'submitted',
          acknowledged: true,
          submittedAt: now(),
          nextPollAt: Date.now(),
        };
        job.submitted++;
        await savePending(state, pending);
        await saveJob(state, job);
      } catch (error) {
        const message = String(error?.message || error);
        if (/HTTP 409/.test(message)) delete pending[rel];
        else pending[rel] = { ...pending[rel], status: 'submitting', lastError: message.slice(0, 300), nextPollAt: 0 };
        addError(rel + ': ' + message);
        job.failed++;
        await savePending(state, pending);
        await saveJob(state, job);
      }
    };

    const pollOperation = async (rel, entry) => {
      const operationId = entry.operationId;
      await beat(state, job.job_id);
      try {
        const result = await apiCall(cfg, 'GET', '/operations/' + encodeURIComponent(operationId));
        const status = String(result?.status || '').toLowerCase();
        if (status === 'completed') {
          const owner = entry.owner === 'obsidian' ? 'obsidian' : ownerFor(rel);
          index.files[rel] = {
            hash: entry.hash,
            mtime: entry.mtime,
            docId: entry.docId || docIdFor(rel, cfg),
            owner,
            syncedAt: now(),
            operationId,
          };
          delete pending[rel];
          job.ingested++;
          const current = scanned.get(rel);
          if (selectedSet.has(rel) && current && current.hash === entry.hash && current.mtime === entry.mtime) resolved.add(rel);
          await saveIndex(state, index);
          await savePending(state, pending);
          await saveJob(state, job);
          return;
        }
        if (status === 'failed' || status === 'cancelled') {
          addError(rel + ': operation ' + status + (result?.error_message ? ': ' + result.error_message : ''));
          job.failed++;
          delete pending[rel];
          await savePending(state, pending);
          await saveJob(state, job);
          return;
        }
        if (status === 'not_found') {
          // An acknowledged operation that the service no longer knows about
          // is a real failure; a never-acknowledged submission is not.
          if (entry.acknowledged) {
            addError(rel + ': operation not found');
            job.failed++;
          }
          delete pending[rel];
          await savePending(state, pending);
          await saveJob(state, job);
          return;
        }
        entry.status = status || entry.status;
        entry.attempts = (entry.attempts || 0) + 1;
        entry.nextPollAt = Date.now() + Math.min(POLL_BASE_MS * 2 ** Math.min(entry.attempts, 4), POLL_MAX_MS);
        await savePending(state, pending);
        await beat(state, job.job_id);
      } catch (error) {
        const message = String(error?.message || error);
        if (/HTTP 404/.test(message)) {
          if (entry.acknowledged) {
            addError(rel + ': operation not found');
            job.failed++;
          }
          delete pending[rel];
          await savePending(state, pending);
          await saveJob(state, job);
          return;
        }
        entry.attempts = (entry.attempts || 0) + 1;
        entry.nextPollAt = Date.now() + Math.min(POLL_BASE_MS * 2 ** Math.min(entry.attempts, 4), POLL_MAX_MS);
        entry.lastError = message.slice(0, 300);
        addError(rel + ': poll ' + entry.lastError);
        await savePending(state, pending);
        await beat(state, job.job_id);
      }
    };

    const all = await markdownFiles(cfg.root);
    const selected = [];
    for (const rel of all) {
      try {
        if (isSelected(rel, cfg)) selected.push(rel);
      } catch (error) {
        addError(rel + ': select ' + String(error?.message || error));
        job.failed++;
      }
    }
    selectedSet = new Set(selected);
    job.total = selected.length;
    await saveJob(state, job, true);

    await pool(selected, CONCURRENCY, async rel => {
      try {
        const info = await stat(path.join(cfg.root, rel));
        present.add(rel);
        const previous = index.files[rel];
        const waiting = pending[rel];

        if (!waiting && !job.force && previous && previous.mtime === info.mtimeMs) {
          const owner = ownerFor(rel);
          if (previous.owner !== owner) {
            index.files[rel] = { ...previous, owner };
            await saveIndex(state, index);
          }
          job.skipped++;
          resolved.add(rel);
          return;
        }

        const source = await readFile(path.join(cfg.root, rel), 'utf8');
        const hash = hashOf(source);
        const mtime = info.mtimeMs;
        scanned.set(rel, { hash, mtime });

        if (waiting) {
          // Never submit a second operation for the same document while the
          // first is unresolved: the older completion could overwrite newer
          // content. A never-acknowledged submission is safe to resend with
          // its existing operation id.
          if (waiting.hash === hash && waiting.mtime === mtime && waiting.status === 'submitting') {
            await submit(rel, source, info, hash, mtime, waiting.operationId);
          }
          return;
        }

        if (!job.force && previous && previous.hash === hash) {
          index.files[rel] = { ...previous, mtime, owner: ownerFor(rel) };
          job.skipped++;
          resolved.add(rel);
          await saveIndex(state, index);
          await saveJob(state, job);
          return;
        }

        if (!job.force && !previous && cfg.baseline && cfg.baseline[rel] && cfg.baseline[rel].hash === hash) {
          index.files[rel] = {
            hash,
            mtime,
            docId: docIdFor(rel, cfg),
            owner: 'obsidian',
            syncedAt: cfg.baseline[rel].syncedAt || null,
          };
          job.skipped++;
          resolved.add(rel);
          await saveIndex(state, index);
          await saveJob(state, job);
          return;
        }

        await submit(rel, source, info, hash, mtime);
      } catch (error) {
        if (error.code === 'ENOENT') {
          present.delete(rel);
          job.skipped++;
          resolved.add(rel);
          return;
        }
        addError(rel + ': ' + String(error?.message || error));
        job.failed++;
        await saveJob(state, job);
      }
    });

    // Poll submitted operations with per-operation bounded backoff. Anything
    // still unresolved when the budget ends stays in pending.json and the next
    // job continues from it.
    const pollDeadline = Date.now() + POLL_BUDGET_MS;
    while (Object.keys(pending).length > 0 && Date.now() < pollDeadline) {
      const due = Object.entries(pending).filter(([, entry]) => entry.operationId && Number(entry.nextPollAt || 0) <= Date.now());
      if (!due.length) {
        const future = Object.values(pending).map(entry => Number(entry.nextPollAt || 0)).filter(at => at > Date.now());
        if (!future.length) break;
        const wait = Math.min(Math.min(...future) - Date.now(), pollDeadline - Date.now());
        if (wait <= 0) break;
        await sleep(wait);
        continue;
      }
      // A single API call can take the full 60 s timeout. Check the deadline
      // before starting each poll so a huge backlog cannot extend the run.
      await pool(due, CONCURRENCY, async ([rel, entry]) => {
        if (Date.now() >= pollDeadline) return;
        await pollOperation(rel, entry);
      });
    }
    const stillWaiting = Object.keys(pending).length;
    if (stillWaiting > 0) addError(stillWaiting + ' operation(s) still pending after polling');

    // Deletion runs only after the scan is complete, so a path missing from
    // this pass is genuinely gone rather than merely unvisited.
    for (const [rel, entry] of Object.entries(index.files)) {
      if (!entry || entry.owner !== 'tern') continue;
      if (cfg.baseline && cfg.baseline[rel]) continue;
      if (selectedSet.has(rel) && present.has(rel)) continue;
      try {
        await apiCall(cfg, 'DELETE', '/documents/' + encodeDocId(entry.docId || docIdFor(rel, cfg)));
        delete index.files[rel];
        job.deleted++;
        await saveIndex(state, index);
        await saveJob(state, job);
      } catch (error) {
        const message = String(error?.message || error);
        if (/HTTP 404/.test(message)) {
          delete index.files[rel];
          job.deleted++;
          await saveIndex(state, index);
          await saveJob(state, job);
        } else {
          addError(rel + ': delete ' + message);
          job.failed++;
          await saveJob(state, job);
        }
      }
    }

    const pendingCount = Object.keys(pending).length;
    job.total = selected.length;
    job.remaining = selected.filter(rel => !resolved.has(rel)).length;
    job.pending = pendingCount;
    if (job.failed > 0) job.state = 'failed';
    else if (pendingCount > 0 || job.remaining > 0) job.state = 'incomplete';
    else job.state = 'done';
    if (job.state === 'done') index.lastSyncAt = now();
    job.finishedAt = now();
    await saveIndex(state, index);
    await savePending(state, pending);
    await saveJob(state, job, true);
    return summary(job, { launch: false, baselineInherited: binding.baselineCount || 0 });
  } catch (error) {
    addError(String(error?.message || error));
    job.state = 'failed';
    job.pending = Object.keys(pending).length;
    job.finishedAt = now();
    try {
      await saveIndex(state, index);
      await savePending(state, pending);
      await saveJob(state, job, true);
    } catch {}
    throw error;
  } finally {
    await releaseLock(state, job.job_id);
  }
}

const STATUS_JOB_LIMIT = 8;

function statusJob(job, lock) {
  if (!job) return null;
  let state = job.state || 'unknown';
  const errors = Array.isArray(job.errors) ? [...job.errors] : [];
  if (ACTIVE.has(state)) {
    const live = Boolean(lock && lock.job_id === job.job_id && !lockStale(lock, job));
    if (!live) {
      if (state === 'prepared') {
        const age = Date.now() - epoch(job.updatedAt || job.createdAt);
        if (!(Number.isFinite(age) && age >= 0 && age < PREPARED_STALE_MS)) state = 'interrupted';
      } else {
        state = 'interrupted';
      }
      if (state === 'interrupted' && job.state !== 'interrupted' && !errors.length) {
        errors.push('job has no live worker process');
      }
    }
  }
  return {
    job_id: job.job_id,
    state,
    submitted: job.submitted || 0,
    ingested: job.ingested || 0,
    failed: job.failed || 0,
    deleted: job.deleted || 0,
    skipped: job.skipped || 0,
    total: job.total || 0,
    remaining: job.remaining || 0,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    error: errors[0] || null,
    errors,
  };
}

export async function syncStatus(request = {}, root) {
  const cache = cacheFor(request);
  const requested = jobIdOf(request);
  let cfg = null;
  try {
    cfg = await loadConfig(root, cache, { required: false });
  } catch {
    cfg = null;
  }
  const configured = Boolean(cfg && cfg.apiUrl && cfg.bankId);
  const empty = {
    configured,
    endpoint: cfg?.apiUrl || null,
    bank: cfg?.bankId || null,
    hasApiKey: Boolean(cfg?.apiKey),
    configSource: cfg?.source || null,
    scope: {
      include: cfg?.include || [],
      exclude: cfg?.exclude || [],
      filters: cfg?.filters || { allow: [], deny: [] },
      prefixDocId: cfg ? cfg.prefix : true,
      budget: cfg?.budget || null,
      syncOnEdit: cfg?.syncOnEdit === true,
      observationScopes: cfg?.observationScopes ?? null,
    },
    baselineInherited: 0,
    referenceLastSyncAt: cfg?.referenceLastSyncAt ?? null,
    tracked: 0,
    inherited: 0,
    lastSyncAt: null,
    job: null,
    jobs: [],
  };
  if (!configured) return empty;

  const dir = bindingDir(cfg.root, cfg);
  const binding = await readJson(path.join(dir, BINDING_FILE), null);
  const index = await readJson(path.join(dir, INDEX_FILE), null);
  const lock = await readLock({ local: path.join(cache, 'hindsight', String(keyFor(cfg))) });
  const files = Object.values(index?.files || {});
  const baseline = cfg.baseline && typeof cfg.baseline === 'object' ? cfg.baseline : {};
  const pointer = await readJson(path.join(dir, JOB_FILE), null);
  // The pointer carries lifecycle state; the job file carries the latest
  // per-outcome counters. Prefer the job file for the primary record.
  const primary = requested
    ? await readJson(path.join(dir, JOBS_DIR, safeName(requested) + '.json'), null)
    : pointer
      ? (await readJson(path.join(dir, JOBS_DIR, safeName(pointer.job_id) + '.json'), null)) || pointer
      : null;

  const names = (await readdir(path.join(dir, JOBS_DIR)).catch(() => []))
    .filter(name => name.endsWith('.json'))
    .sort()
    .slice(-STATUS_JOB_LIMIT);
  const jobs = [];
  for (const name of names.reverse()) {
    const job = await readJson(path.join(dir, JOBS_DIR, name), null);
    if (job) jobs.push(statusJob(job, lock));
  }

  return {
    configured: true,
    endpoint: cfg.apiUrl,
    bank: cfg.bankId,
    hasApiKey: Boolean(cfg.apiKey),
    configSource: cfg.source,
    scope: {
      include: cfg.include,
      exclude: cfg.exclude,
      filters: cfg.filters,
      prefixDocId: cfg.prefix,
      budget: cfg.budget,
      syncOnEdit: cfg.syncOnEdit,
      observationScopes: cfg.observationScopes ?? null,
    },
    baselineInherited: binding?.baselineCount ?? Object.keys(baseline).length,
    referenceLastSyncAt: cfg.referenceLastSyncAt ?? binding?.referenceLastSyncAt ?? null,
    tracked: files.filter(file => file.owner === 'tern').length,
    inherited: files.filter(file => file.owner === 'obsidian').length,
    lastSyncAt: index?.lastSyncAt || null,
    job: statusJob(primary, lock),
    jobs,
  };
}

const watchers = new Map();

function schedule(record, delay = DEBOUNCE_MS) {
  if (record.closed) return;
  clearTimeout(record.timer);
  record.timer = setTimeout(() => {
    record.timer = null;
    flush(record).catch(error => {
      record.lastError = String(error?.message || error);
    });
  }, delay);
  record.timer.unref?.();
}

function insideCache(record, name) {
  const rel = path.relative(record.root, record.cache);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return name === rel || name.startsWith(rel + '/') || name.startsWith(rel + path.sep);
}

async function refreshTracked(record) {
  const index = await readJson(path.join(record.dir, INDEX_FILE), null);
  record.tracked = new Set(Object.keys(index?.files || {}));
}

async function flush(record) {
  if (record.closed) return;
  if (record.running) {
    record.again = true;
    return;
  }
  record.running = true;
  try {
    if (!(await watchConfig(record))) return;
    const prepared = await prepareSync({ cache: record.cache, force: false }, record.root);
    if (prepared.launch && prepared.job_id) {
      const result = await runSync({ cache: record.cache, job_id: prepared.job_id }, record.root);
      record.lastJob = {
        job_id: result.job_id,
        state: result.state,
        failed: result.failed,
        remaining: result.remaining,
      };
      record.flushes++;
      record.lastFlushAt = now();
      if (result.state === 'failed' && result.errors?.length) record.lastError = result.errors[0];
      else record.lastError = null;
      if (result.state === 'incomplete') {
        // Operations still processing: poll again later instead of waiting for
        // another filesystem event.
        record.again = true;
        record.retryDelay = 30_000;
      }
    } else if (prepared.job_id) {
      // Another job is active; retry after the debounce instead of racing it.
      record.again = true;
    }
    await refreshTracked(record);
  } catch (error) {
    record.lastError = String(error?.message || error);
  } finally {
    record.running = false;
    record.dirty.clear();
    if (record.again) {
      record.again = false;
      const delay = record.retryDelay || DEBOUNCE_MS;
      record.retryDelay = 0;
      schedule(record, delay);
    }
  }
}

async function claimWatchLock(state, meta) {
  const file = lockPath(state, WATCH_LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    const record = { token: randomUUID(), pid: process.pid, startedAt: now(), heartbeatAt: now(), ...meta };
    try {
      await mkdir(state.local, { recursive: true });
      await writeFile(file, JSON.stringify(record), { flag: 'wx' });
      return { acquired: true, record };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const existing = await readJson(file, null);
    if (existing && alive(existing.pid) && Date.now() - epoch(existing.heartbeatAt) <= WATCH_HEARTBEAT_MS * 3) {
      return { acquired: false, record: existing };
    }
    try { await unlink(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { acquired: false, record: null };
}

function watchLockTask(record, task) {
  const next = record.lockChain.then(task);
  record.lockChain = next.catch(() => {});
  return next;
}

async function releaseWatchLock(record) {
  return watchLockTask(record, async () => {
    const file = path.join(record.lockDir, WATCH_LOCK_FILE);
    const queued = writeChains.get(file);
    if (queued) await queued.catch(() => {});
    const lock = await readJson(file, null);
    if (!lock || lock.token !== record.watchToken) return;
    try { await unlink(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    writeChains.delete(file);
  });
}

async function touchWatchLock(record) {
  return watchLockTask(record, async () => {
    if (record.closed) return;
    const file = path.join(record.lockDir, WATCH_LOCK_FILE);
    const lock = await readJson(file, null);
    if (!lock || lock.token !== record.watchToken) {
      record.lastError = 'watcher lock lost';
      record.lost = true;
      return;
    }
    lock.heartbeatAt = now();
    await persist(file, lock);
  });
}

async function watchConfig(record) {
  if (record.closed) return false;
  let cfg;
  try {
    cfg = await loadConfig(record.root, record.cache, { required: false });
  } catch (error) {
    record.lastError = String(error?.message || error);
    return false;
  }
  if (!cfg || !cfg.syncOnEdit) {
    record.stopReason = 'syncOnEdit is disabled';
    await record.stop();
    return false;
  }
  if (String(keyFor(cfg)) !== record.key) {
    record.stopReason = 'binding changed';
    await record.stop();
    return false;
  }
  record.cfg = cfg;
  return true;
}

export async function watchVault(request = {}, root) {
  const cache = cacheFor(request);
  let cfg;
  try {
    cfg = await loadConfig(root, cache, { required: false });
  } catch (error) {
    return {
      root: root || null,
      state: 'disabled',
      watching: false,
      syncOnEdit: false,
      debounceMs: DEBOUNCE_MS,
      reason: String(error?.message || error),
    };
  }
  if (!cfg || !cfg.apiUrl || !cfg.bankId) {
    return {
      root: cfg?.root || root || null,
      state: 'disabled',
      watching: false,
      syncOnEdit: cfg?.syncOnEdit === true,
      debounceMs: DEBOUNCE_MS,
      reason: 'Hindsight is not configured for this vault',
    };
  }
  const state = await openState(cfg, cache);
  const key = state.key;
  const stopping = String(request.mode || '').toLowerCase() === 'stop';

  if (stopping) {
    const record = watchers.get(key);
    if (record) {
      await record.stop();
      return {
        root: cfg.root,
        state: 'stopped',
        watching: false,
        stopped: true,
        syncOnEdit: cfg.syncOnEdit,
        debounceMs: DEBOUNCE_MS,
      };
    }
    const lock = await readJson(lockPath(state, WATCH_LOCK_FILE), null);
    let stopped = false;
    if (lock && lock.pid === process.pid) {
      try {
        await unlink(lockPath(state, WATCH_LOCK_FILE));
        stopped = true;
      } catch {}
    }
    return {
      root: cfg.root,
      state: 'stopped',
      watching: false,
      stopped,
      syncOnEdit: cfg.syncOnEdit,
      debounceMs: DEBOUNCE_MS,
      owner_pid: stopped ? null : lock?.pid ?? null,
    };
  }

  if (!cfg.syncOnEdit) {
    const record = watchers.get(key);
    if (record) await record.stop();
    return {
      root: cfg.root,
      state: 'disabled',
      watching: false,
      syncOnEdit: false,
      debounceMs: DEBOUNCE_MS,
      reason: 'syncOnEdit is disabled for this vault',
    };
  }

  const existing = watchers.get(key);
  if (existing) return existing.snapshot();

  const meta = { root: cfg.root, bank: cfg.bankId, key };
  let claimed = await claimWatchLock(state, meta);
  // A previous VM may be releasing the same binding's watcher; give it a
  // bounded window to finish instead of starting a duplicate.
  for (let attempt = 0; !claimed.acquired && attempt < WATCH_TAKEOVER_TRIES; attempt++) {
    await sleep(500);
    claimed = await claimWatchLock(state, meta);
  }
  if (!claimed.acquired) {
    return {
      root: cfg.root,
      state: 'watching',
      watching: true,
      owned: false,
      syncOnEdit: true,
      debounceMs: DEBOUNCE_MS,
      owner_pid: claimed.record?.pid ?? null,
      reason: 'another watcher process holds this binding',
    };
  }

  const record = {
    key,
    cfg,
    cache,
    dir: state.dir,
    lockDir: state.local,
    watchToken: claimed.record.token,
    root: cfg.root,
    watcher: null,
    timer: null,
    heartbeatTimer: null,
    checkTimer: null,
    running: false,
    again: false,
    retryDelay: 0,
    closed: false,
    lost: false,
    lockChain: Promise.resolve(),
    dirty: new Set(),
    tracked: new Set(),
    lastError: null,
    lastJob: null,
    stopReason: null,
    flushes: 0,
    startedAt: now(),
    lastFlushAt: null,
    snapshot() {
      return {
        root: record.root,
        state: record.closed ? 'stopped' : 'watching',
        watching: !record.closed,
        owned: true,
        syncOnEdit: record.cfg.syncOnEdit,
        debounceMs: DEBOUNCE_MS,
        dirty: record.dirty.size,
        running: record.running,
        flushes: record.flushes,
        lastFlushAt: record.lastFlushAt,
        lastJob: record.lastJob,
        lastError: record.lastError,
        stopReason: record.stopReason,
        tracked: record.tracked.size,
        startedAt: record.startedAt,
      };
    },
    async stop() {
      if (record.closed) return;
      record.closed = true;
      clearTimeout(record.timer);
      clearInterval(record.heartbeatTimer);
      clearInterval(record.checkTimer);
      record.timer = null;
      record.heartbeatTimer = null;
      record.checkTimer = null;
      try { record.watcher?.close(); } catch {}
      watchers.delete(record.key);
      await releaseWatchLock(record);
    },
  };

  await refreshTracked(record);

  try {
    record.watcher = watch(cfg.root, { recursive: true }, (event, filename) => {
      if (record.closed) return;
      const name = filename ? String(filename) : '';
      if (name) {
        if (insideCache(record, name)) return;
        let relevant = record.tracked.has(name);
        if (!relevant && name.toLowerCase().endsWith('.md')) {
          try { relevant = isSelected(name, record.cfg); } catch { relevant = true; }
        }
        if (!relevant) return;
      }
      record.dirty.add(name || '*');
      schedule(record);
    });
    record.watcher.on('error', error => {
      record.lastError = String(error?.message || error);
      process.exitCode = 1;
      record.stop().catch(() => {});
    });
  } catch (error) {
    await record.stop();
    throw error;
  }

  record.heartbeatTimer = setInterval(() => {
    touchWatchLock(record)
      .then(() => {
        if (record.lost && !record.closed) return record.stop();
      })
      .catch(error => {
        record.lastError = String(error?.message || error);
      });
  }, WATCH_HEARTBEAT_MS);
  record.checkTimer = setInterval(() => {
    watchConfig(record).catch(error => {
      record.lastError = String(error?.message || error);
    });
  }, WATCH_CHECK_MS);

  watchers.set(key, record);
  // No initial upload: a watcher starts idle and only reacts to later events.
  return record.snapshot();
}
