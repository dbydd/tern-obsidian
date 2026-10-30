import { readdir, readFile, stat, realpath, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkWikiLink from 'remark-wiki-link';
import { toString } from 'mdast-util-to-string';
import { visit } from 'unist-util-visit';
import { renderBase } from './bases.mjs';
import * as hindsight from './hindsight.mjs';
import { matchesFilter } from './vault-filters.mjs';

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkWikiLink, { aliasDivider: '|' });
const skipped = new Set(['.obsidian', '.git', '.trash', 'node_modules', '.smart-env', '.space', '.copilot', '.pi', '.pi-subagents', '.agents', '.claude', '.opencode']);

export async function loadVaultConfig(root) {
  const configPath = path.join(root, '.obsidian', 'app.json');
  let config = {};
  try {
    config = JSON.parse(await readFile(configPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const filters = [];
  for (const raw of config.userIgnoreFilters || []) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const pat = raw.trim();
    // Regex pattern: starts and ends with /
    if (pat.length >= 2 && pat.startsWith('/') && pat.endsWith('/')) {
      try {
        filters.push(new RegExp(pat.slice(1, -1)));
        continue;
      } catch {}
    }
    // Normal path / prefix / filename filter:
    const clean = pat.replace(/^\/+/, '').replace(/\/+$/, '');
    filters.push({
      raw: pat,
      isFolder: pat.endsWith('/'),
      test(rel) {
        // Match exact segment, prefix or filename
        if (rel === clean || rel.startsWith(clean + '/')) return true;
        const base = path.posix.basename(rel);
        if (base === clean) return true;
        // Substring inside path segments
        const segments = rel.split('/');
        if (segments.includes(clean)) return true;
        return false;
      }
    });
  }
  return {
    userIgnoreFilters: filters,
    attachmentFolderPath: config.attachmentFolderPath,
    isIgnored(rel) {
      for (const filter of filters) {
        if (filter instanceof RegExp) {
          if (filter.test(rel) || filter.test('/' + rel) || filter.test(path.posix.basename(rel))) return true;
        } else if (filter && typeof filter.test === 'function') {
          if (filter.test(rel)) return true;
        }
      }
      return false;
    }
  };
}
const node = (k, p, c) => ({ k, ...(p ? { p } : {}), ...(c ? { c } : {}) });
const section = (head, c) => node('section', { head }, c);
const md = text => node('md', { text });
const text = value => node('text', { text: value });
const linkText = (label, href) => node('text', { spans: [{ t: label, href }] });
const norm = value => value.normalize('NFC').toLocaleLowerCase();
const asList = value => value == null ? [] : Array.isArray(value) ? value : [value];
const unique = values => [...new Set(values)];
const slash = value => value.split(path.sep).join('/');

export function splitFrontmatter(source) {
  source = source.replace(/^\uFEFF/, '');
  if (!source.startsWith('---\n') && !source.startsWith('---\r\n')) return { props: {}, body: source, offset: 0 };
  const match = source.match(/^---\r?\n([\s\S]*?)(?:^|\r?\n)(?:---|\.\.\.)(?:\r?\n|$)/m);
  if (!match) return { props: {}, body: source, offset: 0 };
  const props = match[1].trim() ? Bun.YAML.parse(match[1]) : null;
  if (props !== null && (typeof props !== 'object' || Array.isArray(props))) throw new Error('Frontmatter must be a YAML mapping');
  return { props: props ?? {}, body: source.slice(match[0].length), offset: match[0].split('\n').length - 1 };
}

export function metadata(body) {
  const ast = parser.parse(body);
  const tags = [], links = [], embeds = [], headings = [];
  visit(ast, (item, _index, parent) => {
    if (item.type === 'heading') headings.push({ title: toString(item), level: item.depth, line: item.position.start.line });
    if (item.type === 'link' || item.type === 'image') {
      if (!/^[a-z][\w+.-]*:/i.test(item.url)) (item.type === 'image' ? embeds : links).push(item.url);
    }
    if (item.type !== 'text' && item.type !== 'wikiLink') return;
    if (['link', 'image', 'definition', 'linkReference'].includes(parent?.type)) return;
    const start = item.position.start.offset, end = item.position.end.offset;
    const raw = body.slice(start, end);
    const ranges = [];
    const pattern = /!?\[\[([^\[\]\n]+)\]\]/g;
    for (const match of raw.matchAll(pattern)) {
      if (escaped(body, start + match.index)) continue;
      const embedded = match[0].startsWith('!') || (start + match.index > 0 && body[start + match.index - 1] === '!');
      (embedded ? embeds : links).push(match[1].split('|')[0]);
      ranges.push([match.index, match.index + match[0].length]);
    }
    if (item.type === 'wikiLink' && ranges.length === 0) links.push(item.value);
    for (const match of raw.matchAll(/(^|[\s([{>])#([\p{L}\p{N}_\-/]+)/gu)) {
      const at = match.index + match[1].length;
      if (escaped(body, start + at) || ranges.some(([a, b]) => at >= a && at < b)) continue;
      const tag = match[2].replace(/\/+$/, '');
      if (/[\p{L}_-]/u.test(tag)) tags.push(tag);
    }
  });
  return { ast, tags: unique(tags), links: unique(links), embeds: unique(embeds), headings };
}

function escaped(source, at) {
  let count = 0;
  for (let i = at - 1; i >= 0 && source[i] === '\\'; i--) count++;
  return count % 2 === 1;
}

export async function findVault(start) {
  let current = path.resolve(start || process.cwd());
  try { if (!(await stat(current)).isDirectory()) current = path.dirname(current); } catch { current = path.dirname(current); }
  for (;;) {
    try { if ((await stat(path.join(current, '.obsidian'))).isDirectory()) return await realpath(current); } catch {}
    const up = path.dirname(current);
    if (up === current) return null;
    current = up;
  }
}

async function filesIn(root, vaultConfig) {
  const files = [];
  const excluded = [];
  async function walk(dir) {
    for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
      if (entry.name.startsWith('.') || skipped.has(entry.name)) continue;
      const rel = dir ? dir + '/' + entry.name : entry.name;
      // Excluded files stay out of the picker and Bases, but Obsidian still
      // resolves links that point at them, so they are listed separately.
      if (vaultConfig && vaultConfig.isIgnored(rel)) {
        if (entry.isDirectory()) await walk(rel);
        else if (entry.isFile()) excluded.push(rel);
        continue;
      }
      if (entry.isDirectory()) await walk(rel);
      else if (entry.isFile()) files.push(rel);
    }
  }
  await walk('');
  return { files: files.sort(), excluded: excluded.sort() };
}

async function mapLimit(values, limit, fn) {
  let at = 0;
  const result = new Array(values.length);
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    for (;;) {
      const i = at++;
      if (i >= values.length) break;
      result[i] = await fn(values[i], i);
    }
  }));
  return result;
}

// The `filters` block keeps these in the vault's own settings file.
async function vaultFilters(cacheDir, root) {
  let store;
  try { store = JSON.parse(await readFile(path.join(root, '.obsidian/tern-obsidian/settings.json'), 'utf8')); } catch { return null; }
  const entry = store?.filters;
  if (!entry) return null;
  const allow = asList(entry.allow).filter(value => typeof value === 'string' && value.trim() !== '');
  const deny = asList(entry.deny).filter(value => typeof value === 'string' && value.trim() !== '');
  return allow.length || deny.length ? { allow, deny } : null;
}

export async function indexVault(root, cacheDir, refresh = false) {
  const vaultConfig = await loadVaultConfig(root);
  const cachePath = cacheDir && path.join(cacheDir, 'vault-' + createHash('sha256').update(root).digest('hex').slice(0, 16) + '.json');
  let previous = { entries: {} };
  if (cachePath && !refresh) {
    try { previous = JSON.parse(await readFile(cachePath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  }
  const entries = {}, warnings = [];
  let reread = 0;
  const listing = await filesIn(root, vaultConfig);
  // A denied path, or one outside a non-empty allow list, stays linkable but
  // is not parsed, exactly like Obsidian's own ignore filters.
  const filters = await vaultFilters(cacheDir, root);
  const parsed = [], ignored = [...listing.excluded];
  for (const rel of listing.files) {
    const denied = filters && filters.deny.some(pattern => matchesFilter(pattern, rel));
    const allowed = !filters || filters.allow.length === 0 || filters.allow.some(pattern => matchesFilter(pattern, rel));
    if (denied || !allowed) ignored.push(rel);
    else parsed.push(rel);
  }
  const notes = await mapLimit(parsed, 16, async rel => {
    const absolute = path.join(root, rel);
    let info;
    try { info = await stat(absolute); } catch { return null; }
    const fingerprint = [info.size, info.mtimeMs, info.ctimeMs].join(':');
    const old = previous.entries?.[rel];
    if (old?.fingerprint === fingerprint && !old.note.error) {
      entries[rel] = old;
      return old.note;
    }
    const ext = path.extname(rel).slice(1).toLowerCase();
    const note = { rel, name: path.basename(rel, path.extname(rel)), ext, props: {}, tags: [], aliases: [], links: [], embeds: [], headings: [], size: info.size, mtime: info.mtimeMs, ctime: info.birthtimeMs || info.ctimeMs };
    if (ext === 'md') {
      try {
        const source = await readFile(absolute, 'utf8');
        const { props, body, offset } = splitFrontmatter(source);
        const meta = metadata(body);
        note.props = props;
        note.aliases = asList(props.aliases ?? props.alias).filter(v => typeof v === 'string');
        note.tags = unique([...asList(props.tags ?? props.tag).flatMap(v => String(v).split(/[\s,]+/)).map(v => v.replace(/^#/, '')).filter(Boolean), ...meta.tags]);
        const propertyLinks = [];
        const collectLinks = value => {
          if (typeof value === 'string') for (const match of value.matchAll(/\[\[([^\[\]]+)\]\]/g)) propertyLinks.push(match[1].split('|')[0]);
          else if (value && typeof value === 'object') for (const child of Object.values(value)) collectLinks(child);
        };
        collectLinks(props);
        note.links = unique([...meta.links, ...propertyLinks]);
        note.embeds = meta.embeds;
        note.headings = meta.headings.map(h => ({ ...h, line: h.line + offset }));
        note.blocks = {};
        const lines = body.split(/\r?\n/);
        visit(meta.ast, item => {
          if (['code', 'inlineCode'].includes(item.type)) return;
          if (item.type === 'paragraph') {
            const id = toString(item).match(/(?:^|\s)\^([\w-]+)\s*$/);
            if (id) note.blocks[id[1]] = item.position.start.line + offset;
          }
        });
        note.lineCount = lines.length + offset;
        reread++;
      } catch (error) {
        note.error = error.message;
        warnings.push(rel + ': ' + error.message);
      }
    }
    entries[rel] = { fingerprint, note };
    return note;
  });
  const found = notes.filter(Boolean);
  // Excluded files stay linkable but carry no parsed metadata, so a link into
  // `raw/` still resolves without paying to parse thousands of archives.
  for (const rel of ignored) {
    const name = path.basename(rel, path.extname(rel));
    found.push({
      rel, name, ext: path.extname(rel).slice(1).toLowerCase(),
      props: {}, tags: [], aliases: [], links: [], embeds: [], headings: [],
      excluded: true,
    });
  }
  if (cachePath) {
    await mkdir(cacheDir, { recursive: true });
    const temporary = cachePath + '.' + process.pid;
    await writeFile(temporary, JSON.stringify({ version: 1, entries }));
    await rename(temporary, cachePath);
  }
  for (const note of found) if (note.error && !warnings.some(w => w.startsWith(note.rel + ':'))) warnings.push(note.rel + ': ' + note.error);
  return { root, notes: found, reread, warnings };
}

const lookups = new WeakMap();
function lookupFor(index) {
  if (lookups.has(index)) return lookups.get(index);
  const paths = new Map(), names = new Map(), aliases = new Map();
  const add = (map, key, note) => {
    const candidates = map.get(key);
    if (!candidates) map.set(key, [note]);
    else if (!candidates.some(candidate => candidate.rel === note.rel)) candidates.push(note);
  };
  for (const note of index.notes) {
    add(paths, norm(note.rel), note);
    const basename = norm(path.posix.basename(note.rel));
    add(names, basename, note);
    const stem = basename.slice(0, basename.length - note.ext.length - (note.ext ? 1 : 0));
    if (stem) add(names, stem, note);
    if (note.ext === 'md') add(names, norm(note.name), note);
    for (const alias of note.aliases) add(aliases, norm(alias), note);
  }
  const result = { paths, names, aliases };
  lookups.set(index, result);
  return result;
}

export function resolveTarget(index, target, from = '') {
  let value = target.split('|')[0];
  try { value = decodeURIComponent(value); } catch {}
  const hash = value.indexOf('#');
  const anchor = hash < 0 ? '' : value.slice(hash + 1);
  value = (hash < 0 ? value : value.slice(0, hash)).replace(/\\/g, '/');
  if (!value) return { note: index.notes.find(n => n.rel === from), anchor };
  if (value.startsWith('/')) value = value.slice(1);
  const lookup = lookupFor(index);
  const match = candidate => {
    const key = norm(path.posix.normalize(candidate));
    return lookup.paths.get(key) || (!path.posix.extname(candidate) ? lookup.paths.get(key + '.md') : null) || [];
  };
  let candidates = [];
  if (value.includes('/')) {
    candidates = match(value);
    if (!candidates.length) candidates = match(path.posix.join(path.posix.dirname(from), value));
    if (!candidates.length) {
      const suffix = norm(value);
      candidates = index.notes.filter(n => norm(n.rel).endsWith('/' + suffix) || norm(n.rel).endsWith('/' + suffix + '.md') || (!path.posix.extname(suffix) && norm(n.rel).endsWith('/' + suffix + '.')));
    }
  } else {
    candidates = match(path.posix.join(path.posix.dirname(from), value));
    if (!candidates.length) candidates = lookup.names.get(norm(value)) || [];
    if (!candidates.length) candidates = lookup.aliases.get(norm(value)) || [];
  }
  return { note: candidates.length === 1 ? candidates[0] : null, candidates: candidates.map(n => n.rel), anchor };
}

export function noteHref(root, rel, anchor = '') {
  return 'obsidian://tern?' + new URLSearchParams({ root, file: rel, ...(anchor ? { anchor } : {}) });
}
const escapeLabel = value => String(value).replace(/[\\[\]]/g, '\\$&');

const IMAGE_EXT = /^(png|jpg|jpeg|gif|webp|svg|bmp|avif|tiff|heic)$/i;

async function convertMarkdown(body, ctx, stack = []) {
  const ast = parser.parse(body), edits = [], wikiRanges = [], refs = [], images = [];
  const snippets = [];
  visit(ast, (item, _index, parent) => {
    if (item.type === 'code' && item.lang === 'base') {
      snippets.push({ start: item.position.start.offset, end: item.position.end.offset, data: item.value });
      return;
    }
    if (item.type === 'wikiLink' || (item.type === 'text' && !['link', 'image', 'linkReference'].includes(parent?.type))) {
      const start = item.position.start.offset, end = item.position.end.offset;
      const raw = body.slice(start, end);
      for (const match of raw.matchAll(/!?\[\[([^\[\]\n]+)\]\]/g)) {
        let a = start + match.index, b = a + match[0].length;
        if (escaped(body, a)) continue;
        const embedded = match[0].startsWith('!') || (body[a - 1] === '!' && !escaped(body, a - 1));
        if (embedded && body[a] !== '!') a--;
        const [target, alias] = match[1].split('|');
        wikiRanges.push([a, b]);
        refs.push({ a, b, target, alias, embedded });
      }
    }
    if (item.type === 'link' || item.type === 'image') {
      if (/^[a-z][\w+.-]*:/i.test(item.url)) return;
      const resolved = resolveTarget(ctx.index, item.url, ctx.source);
      if (!resolved.note) return;
      const href = ctx.href(resolved.note.rel, resolved.anchor);
      const label = item.type === 'image' ? item.alt || resolved.note.name : toString(item);
      // `tern.ui.md` never loads a local image, so image references are
      // gathered for the host to send as blobs and replaced by a marker.
      if (item.type === 'image' && IMAGE_EXT.test(resolved.note.ext)) {
        images.push({ key: 'img' + images.length, rel: resolved.note.rel, alt: label });
        edits.push({ a: item.position.start.offset, b: item.position.end.offset, value: `![[tern-image:${images.length - 1}]]` });
      } else {
        edits.push({ a: item.position.start.offset, b: item.position.end.offset, value: `${item.type === 'image' ? '!' : ''}[${escapeLabel(label)}](${href})` });
      }
    }
  });
  for (const ref of refs) {
    const resolved = resolveTarget(ctx.index, ref.target, ctx.source);
    let replacement;
    if (!resolved.note) replacement = `${escapeLabel(ref.alias || ref.target)} ⚠ ${resolved.candidates?.length ? '(ambiguous link)' : '(missing link)'}`;
    else if (ref.embedded && resolved.note.ext === 'md') {
      if (stack.includes(resolved.note.rel)) replacement = `> Circular embed: ${escapeLabel(resolved.note.rel)}`;
      else {
        const source = await readFile(path.join(ctx.root, resolved.note.rel), 'utf8');
        const embeddedBody = selectAnchor(splitFrontmatter(source).body, resolved.anchor);
        const inner = await convertMarkdown(embeddedBody, { ...ctx, source: resolved.note.rel }, [...stack, resolved.note.rel]);
        // Nested embeds keep the outer image numbering, so offsets stay unique.
        for (const image of inner.images) {
          const index = images.length;
          images.push(image);
          inner.body = inner.body.replaceAll(`![[tern-image:${image.key}]]`, `![[tern-image:${index}]]`);
        }
        replacement = '\n\n' + inner.body + '\n\n';
      }
    } else if (ref.embedded && IMAGE_EXT.test(resolved.note.ext)) {
      images.push({ key: 'img' + images.length, rel: resolved.note.rel, alt: ref.alias || resolved.note.name });
      replacement = `![[tern-image:${images.length - 1}]]`;
    } else replacement = `[${escapeLabel(ref.alias || ref.target)}](${ctx.href(resolved.note.rel, resolved.anchor)})`;
    edits.push({ a: ref.a, b: ref.b, value: replacement });
  }
  visit(ast, (item, _i, parent) => {
    if (item.type !== 'text' || ['link', 'linkReference', 'image'].includes(parent?.type)) return;
    const start = item.position.start.offset, raw = body.slice(start, item.position.end.offset);
    for (const match of raw.matchAll(/(^|[\s([{>])#([\p{L}\p{N}_\-/]+)/gu)) {
      const a = start + match.index + match[1].length, tag = match[2].replace(/\/+$/, '');
      if (!/[\p{L}_-]/u.test(tag) || escaped(body, a) || wikiRanges.some(([x, y]) => a >= x && a < y)) continue;
      const url = 'obsidian://tern?' + new URLSearchParams({ root: ctx.root, tag });
      edits.push({ a, b: a + 1 + tag.length, value: `[${escapeLabel('#' + tag)}](${url})` });
    }
  });
  for (const snippet of snippets) {
    const view = renderBase(Bun.YAML.parse(snippet.data), ctx);
    edits.push({ a: snippet.start, b: snippet.end, value: nativeToMarkdown(view) });
  }
  edits.sort((a, b) => b.a - a.a);
  let last = body.length;
  for (const edit of edits) {
    if (edit.b > last) continue;
    body = body.slice(0, edit.a) + edit.value + body.slice(edit.b);
    last = edit.a;
  }
  return { body, images };
}

// Tern's Markdown dialect knows five callout kinds; Obsidian defines about
// twenty. Map each Obsidian kind onto the closest supported one, and turn
// the rest into plain quotes. Also drop `%%comments%%` and turn `==text==`
// into bold, since the renderer has no highlight span.
const CALLOUTS = {
  note: 'NOTE', info: 'NOTE', todo: 'NOTE', abstract: 'NOTE', summary: 'NOTE', tldr: 'NOTE', quote: 'NOTE', cite: 'NOTE',
  tip: 'TIP', hint: 'TIP', success: 'TIP', check: 'TIP', done: 'TIP',
  important: 'IMPORTANT',
  warning: 'WARNING', caution: 'WARNING', attention: 'WARNING',
  danger: 'CAUTION', error: 'CAUTION', bug: 'CAUTION', failure: 'CAUTION', fail: 'CAUTION', missing: 'CAUTION',
};

function normalizeObsidian(text) {
  const lines = text.split('\n');
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      if (fence == null) fence = fenceMatch[1][0];
      else if (fenceMatch[1][0] === fence) fence = null;
      continue;
    }
    if (fence != null) continue;
    const callout = line.match(/^(\s*>\s*)\[!([\w-]+)\]([+-]?)\s*(.*)$/);
    if (callout) {
      const mapped = CALLOUTS[callout[2].toLowerCase()];
      // Tern only opens a callout when the marker is alone on its line, so an
      // Obsidian inline title moves to the next body line.
      if (mapped) {
        lines[i] = `${callout[1]}[!${mapped}]`;
        if (callout[4]) {
          lines.splice(i + 1, 0, `${callout[1]}${callout[4]}`);
          i++;
        }
      } else {
        lines[i] = callout[1] + callout[4];
      }
      continue;
    }
    lines[i] = stripInlineObsidian(line);
  }
  return lines.join('\n');
}

// Handles `%%hidden%%` and `==marked==` outside inline code spans.
function stripInlineObsidian(line) {
  const parts = line.split(/(`+[^`]*`+)/);
  return parts.map((part, i) => {
    if (i % 2 === 1) return part;
    return part
      .replace(/%%[\s\S]*?%%/g, '')
      .replace(/==([^=\n]+)==/g, '**$1**');
  }).join('');
}

export function selectAnchor(body, anchor) {
  if (!anchor) return body;
  const ast = parser.parse(body), parts = anchor.split(/#| > /).map(norm);
  if (anchor.startsWith('^')) {
    let found;
    visit(ast, item => {
      if (item.type === 'paragraph' && new RegExp('(?:^|\\s)\\^' + anchor.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$').test(toString(item))) found = item;
    });
    if (!found) throw new Error('Block not found: #' + anchor);
    return body.slice(found.position.start.offset, found.position.end.offset).replace(/\s*\^[\w-]+\s*$/, '');
  }
  const headings = ast.children.filter(n => n.type === 'heading');
  let found, position = 0;
  for (const title of parts) {
    found = headings.find((h, i) => i >= position && norm(toString(h)) === title);
    if (!found) throw new Error('Heading not found: #' + anchor);
    position = headings.indexOf(found) + 1;
  }
  const next = headings.slice(position).find(h => h.depth <= found.depth);
  return body.slice(found.position.start.offset, next?.position.start.offset ?? body.length);
}

function nativeToMarkdown(view) {
  if (!view) return '';
  const p = view.p || {}, c = view.c || [];
  const spans = v => typeof v === 'string' ? v : Array.isArray(v) ? v.map(spans).join('') : v?.href ? `[${v.t}](${v.href})` : v?.t || '';
  if (view.k === 'md') return p.text || '';
  if (view.k === 'text') return p.spans ? spans(p.spans) : p.text || '';
  if (view.k === 'table') return '| ' + p.cols.map(x => x.head).join(' | ') + ' |\n| ' + p.cols.map(() => '---').join(' | ') + ' |\n' + p.rows.map(row => '| ' + row.map(x => spans(x).replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ') + ' |').join('\n');
  return (p.head ? '### ' + spans(p.head) + '\n\n' : '') + c.map(nativeToMarkdown).join('\n\n');
}

export async function renderNote(index, rel, anchor = '') {
  const note = index.notes.find(n => n.rel === rel);
  if (!note) throw new Error('Note missing: ' + rel);
  const { props, body } = splitFrontmatter(await readFile(path.join(index.root, rel), 'utf8'));
  const href = (target, mark = '') => noteHref(index.root, target, mark);
  const ctx = { root: index.root, index, source: rel, href };
  const sections = [];
  if (Object.keys(props).length) {
    // One property value as a span list. `kv` renders a span list inline, so
    // separate values explicitly instead of letting them run together.
    const valueSpans = value => {
      const one = item => {
        if (typeof item === 'string' && /^\[\[.*\]\]$/.test(item)) {
          const inner = item.slice(2, -2);
          const target = resolveTarget(index, inner, rel);
          return [{ t: inner, href: target.note ? href(target.note.rel, target.anchor) : '#', s: 'accent' }];
        }
        // A property may hold a Markdown link, as `resource` does in this vault.
        if (typeof item === 'string') {
          const markdownLink = item.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
          if (markdownLink) {
            const target = resolveTarget(index, markdownLink[2], rel);
            // An unresolved vault path still names a real directory, so link
            // the absolute location rather than echoing the raw target.
            return [{ t: markdownLink[1], href: target.note ? href(target.note.rel, target.anchor) : path.join(index.root, markdownLink[2]), s: 'accent' }];
          }
        }
        if (typeof item === 'string') return [{ t: item }];
        if (item === null || typeof item !== 'object') return [{ t: String(item) }];
        return [{ t: JSON.stringify(item) }];
      };
      if (!Array.isArray(value)) return one(value);
      const spans = [];
      for (const item of value) {
        if (spans.length) spans.push({ t: ', ', s: 'dim' });
        spans.push(...one(item));
      }
      return spans.length ? spans : [{ t: '', s: 'dim' }];
    };
    const items = Object.entries(props).map(([key, value]) => {
      return { k: [{ t: key, s: 'muted' }], v: valueSpans(value) };
    });
    sections.push(section('Properties', [node('kv', { items })]));
  }
  if (note.tags.length) {
    const tags = section('Tags', note.tags.map(tag => linkText('#' + tag, 'obsidian://tern?' + new URLSearchParams({ root: index.root, tag }))));
    tags.p = { head: 'Tags', role: 'tags' };
    sections.push(tags);
  }
  const selected = selectAnchor(body, anchor);
  const convertedResult = await convertMarkdown(selected, ctx, [rel]);
  const converted = normalizeObsidian(convertedResult.body);
  const marks = [];
  visit(parser.parse(converted), item => {
    if (item.type === 'link' && item.url.startsWith('obsidian://')) marks.push({ t: toString(item), href: item.url });
  });
  sections.push(node('md', { text: converted, marks }));
  const outgoing = unique(note.links.map(target => resolveTarget(index, target, rel)).filter(r => r.note).map(r => JSON.stringify([r.note.rel, r.anchor]))).map(v => JSON.parse(v));
  if (outgoing.length) sections.push(section('Links', outgoing.map(([target, mark]) => linkText(target + (mark ? '#' + mark : ''), href(target, mark)))));
  if (!anchor && note.headings.length) sections.push(section('Outline', note.headings.map(h => linkText('  '.repeat(h.level - 1) + h.title, href(rel, h.title)))));
  const backlinks = index.notes.filter(n => !n.excluded && n.links.some(target => resolveTarget(index, target, n.rel).note?.rel === rel));
  if (backlinks.length) sections.push(section('Backlinks', backlinks.map(n => linkText(n.rel, href(n.rel)))));
  return {
    title: note.name,
    view: node('col', null, sections),
    root: index.root,
    rel,
    tags: note.tags,
    warnings: index.warnings,
    images: convertedResult.images.map(image => ({ ...image, path: path.join(index.root, image.rel) })),
  };
}

async function knownVaults() {
  const result = [];
  const location = process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Application Support/obsidian/obsidian.json') : path.join(os.homedir(), '.config/obsidian/obsidian.json');
  try {
    const data = JSON.parse(await readFile(location, 'utf8'));
    for (const value of Object.values(data.vaults || {})) if (value.path) result.push(value.path);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return result;
}

export async function dispatch(request) {
  if (request.op === 'save') {
    const root = await findVault(request.root);
    if (!root) throw new Error('No Obsidian vault at ' + request.root);
    const dir = path.join(root, 'Tern Notes');
    await mkdir(dir, { recursive: true });
    const name = String(request.title || 'Tern Canvas').replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').trim() || 'Tern Canvas';
    let filename, suffix = 0;
    for (;;) {
      filename = path.join(dir, name + (suffix ? ' ' + suffix : '') + '.md');
      try { await writeFile(filename, request.markdown, { flag: 'wx' }); break; } catch (error) { if (error.code !== 'EEXIST') throw error; suffix++; }
    }
    return { path: filename, root };
  }
  if (request.op === 'vaults') {
    return { focused: request.root ? await findVault(request.root) : null, known: await knownVaults() };
  }
  const start = request.path || request.root || request.cwd;
  let root = request.vault && !request.root ? null : await findVault(start);
  if (request.vault && !request.root) {
    for (const candidate of await knownVaults()) if (path.basename(candidate) === request.vault || candidate === request.vault) { root = await findVault(candidate); if (root) break; }
  }
  if (!root) throw new Error('No .obsidian directory above ' + (start || 'current directory'));
  if (request.op.startsWith('hindsight-')) return hindsight.dispatch(request, root);
  // Paged text read: the index is not needed, so this stays cheap on a cold cache.
  if (request.op === 'read') {
    const given = String(request.rel || '');
    const rel = path.isAbsolute(given) ? slash(path.relative(root, path.resolve(given))) : slash(given).replace(/^\/+/, '');
    const absolute = path.resolve(root, rel);
    if (!absolute.startsWith(root + path.sep)) throw new Error('Path is outside the vault: ' + rel);
    let source;
    try { source = await readFile(absolute, 'utf8'); } catch (error) { throw new Error('Cannot read ' + rel + ': ' + error.message); }
    if (source.includes('\u0000')) throw new Error('Not a text file: ' + rel);
    const all = source.split(/\r?\n/);
    const from = Math.max(1, Math.trunc(Number(request.from) || 1));
    const want = Math.min(2000, Math.max(1, Math.trunc(Number(request.lines) || 200)));
    const chunk = [];
    let bytes = 0, at = from - 1;
    while (at < all.length && chunk.length < want) {
      const size = Buffer.byteLength(all[at], 'utf8') + 1;
      if (bytes + size > 12000 && chunk.length > 0) break;
      chunk.push(all[at]);
      bytes += size;
      at++;
    }
    return { root, rel, total_lines: all.length, from, lines: chunk.length, next: at < all.length ? at + 1 : null, text: chunk.join('\n') };
  }
  const index = await indexVault(root, request.cache, request.refresh);
  if (request.op === 'index') return { root, count: index.notes.filter(n => !n.excluded).length, notes: index.notes.filter(n => !n.excluded && ['md', 'base', 'canvas'].includes(n.ext)).map(n => ({ rel: n.rel, name: n.name, ext: n.ext, tags: n.tags, aliases: n.aliases })), warnings: index.warnings, reread: index.reread };
  if (request.op === 'vault') return { root, count: index.notes.filter(n => !n.excluded).length, warnings: index.warnings.slice(0, 20) };
  if (request.op === 'find') {
    const query = norm(String(request.query || ''));
    const limit = Math.min(50, Math.max(1, Math.trunc(Number(request.limit) || 20)));
    const matches = [];
    let total = 0;
    for (const note of index.notes) {
      if (note.excluded) continue;
      if (query && ![note.rel, note.name, ...note.aliases, ...note.tags].some(value => norm(value).includes(query))) continue;
      total++;
      if (matches.length < limit) matches.push({ rel: note.rel, name: note.name, ext: note.ext, tags: note.tags.slice(0, 8), aliases: note.aliases.slice(0, 4) });
    }
    return { root, total, matches };
  }
  if (request.op === 'links') {
    const given = String(request.rel || '');
    const rel = path.isAbsolute(given) ? slash(path.relative(root, path.resolve(given))) : slash(given).replace(/^\/+/, '');
    const note = index.notes.find(n => n.rel === rel);
    if (!note) throw new Error('Not a vault file: ' + rel);
    const out = note.links.map(target => resolveTarget(index, target, rel).note?.rel || target + ' (unresolved)');
    const back = [];
    for (const other of index.notes) {
      if (other.excluded || other.rel === rel) continue;
      if (other.links.some(target => resolveTarget(index, target, other.rel).note?.rel === rel)) back.push(other.rel);
    }
    // An ignored file keeps its place in the link graph but has no parsed links of its own.
    return { root, rel, excluded: Boolean(note.excluded), out: unique(out).slice(0, 80), back: unique(back).slice(0, 80) };
  }
  if (request.op === 'resolve') {
    const resolved = resolveTarget(index, request.target, request.from || '');
    if (!resolved.note) throw new Error((resolved.candidates?.length ? 'Ambiguous link: ' + resolved.candidates.join(', ') : 'Missing link: ' + request.target));
    let line;
    if (resolved.anchor.startsWith('^')) line = resolved.note.blocks?.[resolved.anchor.slice(1)];
    else if (resolved.anchor) line = resolved.note.headings.find(h => norm(h.title) === norm(resolved.anchor.split(/#| > /).at(-1)))?.line;
    if (resolved.anchor && !line) throw new Error('Anchor not found: #' + resolved.anchor);
    return { root, rel: resolved.note.rel, path: path.join(root, resolved.note.rel), line, anchor: resolved.anchor, ext: resolved.note.ext };
  }
  if (request.op === 'tag') return { root, view: node('col', null, [section('#' + request.tag, index.notes.filter(n => !n.excluded && n.tags.some(t => norm(t) === norm(request.tag) || norm(t).startsWith(norm(request.tag) + '/'))).map(n => linkText(n.rel, noteHref(root, n.rel))))]), title: '#' + request.tag };
  const rel = request.rel || slash(path.relative(root, request.path));
  if (!index.notes.some(n => n.rel === rel)) throw new Error('File is outside the vault or unavailable: ' + rel);
  if (rel.toLowerCase().endsWith('.base')) {
    const visible = { ...index, notes: index.notes.filter(n => !n.excluded) };
    return { root, rel, title: path.basename(rel), view: node('col', null, [renderBase(Bun.YAML.parse(await readFile(path.join(root, rel), 'utf8')), { root, index: visible, source: rel, href: (r, a) => noteHref(root, r, a) })]) };
  }
  if (rel.toLowerCase().endsWith('.canvas')) {
    const doc = JSON.parse(await readFile(path.join(root, rel), 'utf8'));
    const children = [];
    const images = [];
    for (const n of doc.nodes || []) {
      const label = n.label || n.file || n.url || n.id;
      let content;
      if (n.type === 'text') {
        const inner = await convertMarkdown(n.text || '', { root, index, source: rel, href: (r, a) => noteHref(root, r, a) }, [rel]);
        for (const image of inner.images) images.push(image);
        content = md(normalizeObsidian(inner.body));
      } else if (n.type === 'file') {
        content = linkText(n.file, noteHref(root, n.file, (n.subpath || '').replace(/^#/, '')));
      } else if (n.type === 'link') {
        content = linkText(n.url, n.url);
      } else {
        content = text(n.label || 'Group');
      }
      children.push(section(label, [text(`Position ${n.x}, ${n.y} · ${n.width} × ${n.height}`), content]));
    }
    if (doc.edges?.length) children.push(section('Connections', doc.edges.map(e => text(`${e.fromNode} → ${e.toNode}${e.label ? ': ' + e.label : ''}`))));
    return { root, rel, title: path.basename(rel), view: node('col', null, children), canvas: doc, images: images.map(image => ({ ...image, path: path.join(root, image.rel) })) };
  }
  return renderNote(index, rel, request.anchor || '');
}

if (import.meta.main) {
  try { console.log(JSON.stringify(await dispatch(await Bun.stdin.json()))); }
  catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}
