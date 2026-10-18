// bases.mjs — render Obsidian .base documents as native Tern nodes.
//
// renderBase(data, ctx) -> { k: 'col', c: [...] }
//   data: object parsed from the .base YAML by the host (Bun.YAML.parse).
//   ctx:  { root, index, source, href(rel, anchor?), renderNote? }
//     index.notes: [{ rel, name, ext, props, tags, aliases, size, mtime, ctime, links, embeds }]
//
// Supported subset of https://help.obsidian.md/bases/syntax:
//   - global + view `filters` (and/or/not trees and single statement strings)
//   - table views rendered as sections; other view types report unsupported visibly
//   - `order` as COLUMN order, `properties.<key>.displayName`, `limit`, `sort`
//   - `groupBy`/`groupOrder` (grouped tables inside the view section)
//   - `formulas` (arithmetic, if(), toFixed/round, formula cross references)
//   - filter/formula expressions: && || !, == != > >= < <=, + - * / %, parens,
//     string/number/bool/null literals, note.x / bare property, file.* fields,
//     formula.x, this.file.*, file.hasTag/inFolder/hasLink, prop.contains,
//     string lower/upper/contains/startsWith/endsWith/isEmpty, list length/contains,
//     today()/now()/date(), duration strings ("1w") in date arithmetic.
// Unsupported constructs throw a readable error that is rendered in the view
// section — results are never silently emptied.

const VISIBLE_ROW_CAP = 200;

// ---------------------------------------------------------------------------
// Errors

class BaseError extends Error {}

function fail(msg) {
	throw new BaseError(msg);
}

// ---------------------------------------------------------------------------
// Tokenizer

const TOKEN_RE = new RegExp(
	[ '\\s+', '(\\d+\\.\\d+|\\d+)', '("(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\')',
		'([A-Za-z_][A-Za-z0-9_]*)', '(==|!=|>=|<=|&&|\\|\\||[><+\\-*/%!()\\[\\].,])' ].join('|'),
	'y');

function tokenize(src) {
	const toks = [];
	let pos = 0;
	while (pos < src.length) {
		TOKEN_RE.lastIndex = pos;
		const m = TOKEN_RE.exec(src);
		if (!m) fail(`Cannot tokenize expression at: …${src.slice(pos, pos + 20)}`);
		pos = TOKEN_RE.lastIndex;
		if (m[1] === undefined && m[2] === undefined && m[3] === undefined && m[4] === undefined) continue;
		if (m[1] !== undefined) toks.push({ t: 'num', v: parseFloat(m[1]) });
		else if (m[2] !== undefined) toks.push({ t: 'str', v: m[2].slice(1, -1).replace(/\\(.)/g, '$1') });
		else if (m[3] !== undefined) toks.push({ t: 'id', v: m[3] });
		else toks.push({ t: m[4] });
	}
	return toks;
}

// ---------------------------------------------------------------------------
// Parser (recursive descent, no eval)

class Parser {
	constructor(src) {
		this.src = src;
		this.toks = tokenize(src);
		this.i = 0;
	}
	peek() { return this.toks[this.i]; }
	next() { return this.toks[this.i++]; }
	expect(t) {
		const tok = this.next();
		if (!tok || tok.t !== t) fail(`Expected "${t}" in expression: ${this.src}`);
		return tok;
	}
	parse() {
		const node = this.parseOr();
		if (this.i !== this.toks.length) fail(`Unexpected trailing input in expression: ${this.src}`);
		return node;
	}
	parseOr() {
		let left = this.parseAnd();
		while (this.peek()?.t === '||') { this.next(); left = { k: '||', l: left, r: this.parseAnd() }; }
		return left;
	}
	parseAnd() {
		let left = this.parseNot();
		while (this.peek()?.t === '&&') { this.next(); left = { k: '&&', l: left, r: this.parseNot() }; }
		return left;
	}
	parseNot() {
		if (this.peek()?.t === '!') { this.next(); return { k: '!', e: this.parseNot() }; }
		return this.parseCmp();
	}
	parseCmp() {
		const left = this.parseAdd();
		const t = this.peek()?.t;
		if (t === '==' || t === '!=' || t === '>' || t === '<' || t === '>=' || t === '<=') {
			this.next();
			return { k: t, l: left, r: this.parseAdd() };
		}
		return left;
	}
	parseAdd() {
		let left = this.parseMul();
		for (;;) {
			const t = this.peek()?.t;
			if (t === '+' || t === '-') { this.next(); left = { k: t, l: left, r: this.parseMul() }; }
			else return left;
		}
	}
	parseMul() {
		let left = this.parseUnary();
		for (;;) {
			const t = this.peek()?.t;
			if (t === '*' || t === '/' || t === '%') { this.next(); left = { k: t, l: left, r: this.parseUnary() }; }
			else return left;
		}
	}
	parseUnary() {
		if (this.peek()?.t === '-') { this.next(); return { k: 'neg', e: this.parseUnary() }; }
		return this.parsePrimary();
	}
	parsePrimary() {
		const tok = this.next();
		if (!tok) fail(`Unexpected end of expression: ${this.src}`);
		if (tok.t === 'num') return { k: 'lit', v: tok.v };
		if (tok.t === 'str') return { k: 'lit', v: tok.v };
		if (tok.t === '(') {
			const e = this.parseOr();
			this.expect(')');
			return this.parsePostfix(e);
		}
		if (tok.t !== 'id') fail(`Unexpected token in expression: ${this.src}`);
		if (tok.v === 'true') return { k: 'lit', v: true };
		if (tok.v === 'false') return { k: 'lit', v: false };
		if (tok.v === 'null') return { k: 'lit', v: null };
		let node = { k: 'id', name: tok.v };
		return this.parsePostfix(node);
	}
	parsePostfix(node) {
		for (;;) {
			const t = this.peek()?.t;
			if (t === '.') {
				this.next();
				const name = this.next();
				if (!name || name.t !== 'id') fail(`Expected property name after "." in: ${this.src}`);
				node = { k: 'member', obj: node, name: name.v };
			} else if (t === '[') {
				this.next();
				const idx = this.parseOr();
				this.expect(']');
				node = { k: 'index', obj: node, idx };
			} else if (t === '(') {
				this.next();
				const args = [];
				if (this.peek()?.t !== ')') {
					args.push(this.parseOr());
					while (this.peek()?.t === ',') { this.next(); args.push(this.parseOr()); }
				}
				this.expect(')');
				node = { k: 'call', callee: node, args };
			} else return node;
		}
	}
}

const parseCache = new Map();
function parseExpr(src) {
	if (typeof src !== 'string') fail(`Filter statement must be a string, got: ${JSON.stringify(src)}`);
	let p = parseCache.get(src);
	if (!p) { p = new Parser(src).parse(); parseCache.set(src, p); }
	return p;
}

// ---------------------------------------------------------------------------
// Values

const DURATION_RE = /^(\d+(?:\.\d+)?)\s*(y|year|years|M|month|months|w|week|weeks|d|day|days|h|hour|hours|m|minute|minutes|s|second|seconds)$/;
const UNIT_MS = { y: 365.25 * 864e5, M: 30.44 * 864e5, w: 7 * 864e5, d: 864e5, h: 36e5, m: 6e4, s: 1e3 };

function parseDuration(s) {
	const m = DURATION_RE.exec(s);
	if (!m) return null;
	const unit = m[2][0] === 'y' ? 'y' : (m[2][0] === 'M' || m[2][0] === 'm') && m[2].length > 1 ? m[2][0] : m[2][0];
	return parseFloat(m[1]) * (UNIT_MS[unit] ?? UNIT_MS.d);
}

function isDateLike(v) { return typeof v === 'number' && v > 1e11; }

function fmtDate(ms) {
	const d = new Date(ms);
	const p = (n) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function isTruthy(v) { return !!v; }

function compare(a, b) {
	if (a == null && b == null) return 0;
	if (a == null) return -1;
	if (b == null) return 1;
	if (typeof a === 'number' && typeof b === 'number') return a - b;
	if (typeof a === 'boolean' && typeof b === 'boolean') return (a ? 1 : 0) - (b ? 1 : 0);
	const sa = String(a);
	const sb = String(b);
	return sa < sb ? -1 : sa > sb ? 1 : 0;
}

// ---------------------------------------------------------------------------
// File environment (the `file` / `this` receiver)

class FileEnv {
	constructor(note, ctx) {
		this._note = note;
		this._ctx = ctx;
	}
	get name() { return this._note.name; }
	get ext() { return this._note.ext; }
	get folder() {
		const i = this._note.rel.lastIndexOf('/');
		return i === -1 ? '' : this._note.rel.slice(0, i);
	}
	get path() { return this._note.rel; }
	get size() { return this._note.size; }
	get mtime() { return this._note.mtime; }
	get ctime() { return this._note.ctime; }
	get tags() { return this._note.tags ?? []; }
	get links() { return this._note.links ?? []; }
	get embeds() { return this._note.embeds ?? []; }
	get properties() { return this._note.props ?? {}; }
	hasTag(tag) {
		const t = String(tag).replace(/^#/, '');
		return (this._note.tags ?? []).some((x) => x === t || x.startsWith(t + '/'));
	}
	inFolder(folder) {
		const f = String(folder).replace(/\/+$/, '');
		if (f === '') return true;
		return this.folder === f || this.folder.startsWith(f + '/');
	}
	hasLink(target) {
		const name = typeof target === 'object' && target?._isFileEnv ? target._note.name : String(target);
		const base = name.replace(/\.md$/, '');
		return (this._note.links ?? []).some((l) => {
			const lbase = String(l).replace(/\.md$/, '').split('#')[0];
			return lbase === name || lbase === base;
		});
	}
}

// ---------------------------------------------------------------------------
// Property resolution

function propsPath(obj, segments) {
	let cur = obj;
	for (const seg of segments) {
		if (cur == null || typeof cur !== 'object') return null;
		cur = cur[seg];
	}
	return cur === undefined ? null : cur;
}

// Resolve a dotted property string like "file.name" / "note.age" / "price"
// against one note. Returns a plain value.
function resolvePropPath(path, note, ctx, formulas) {
	const segs = path.split('.');
	if (segs[0] === 'file' || segs[0] === 'this') {
		const fe = new FileEnv(note, ctx);
		if (segs.length === 1) return fe;
		return getMemberValue(fe, segs[1]);
	}
	if (segs[0] === 'note') return propsPath(note.props ?? {}, segs.slice(1));
	if (segs[0] === 'formula') {
		if (segs.length !== 2) fail(`Unsupported formula reference: ${path}`);
		return evalFormula(segs[1], note, ctx, formulas);
	}
	if (segs[0] === 'tags' && segs.length === 1) return note.tags ?? [];
	return propsPath(note.props ?? {}, segs);
}

// ---------------------------------------------------------------------------
// Expression evaluation

function evalFormula(name, note, ctx, formulas, seen = new Set()) {
	if (!formulas || !(name in formulas)) fail(`Unknown formula property: formula.${name}`);
	if (seen.has(name)) fail(`Circular formula reference: ${[...seen, name].join(' -> ')}`);
	seen.add(name);
	const cached = note._formulaCache?.get(name);
	if (cached !== undefined) return cached;
	const ast = parseExpr(String(formulas[name]));
	const v = evalNode(ast, note, ctx, formulas, seen);
	(note._formulaCache ??= new Map()).set(name, v);
	return v;
}

function evalNode(node, note, ctx, formulas, seen) {
	switch (node.k) {
		case 'lit': return node.v;
		case 'id': return evalIdentifier(node.name, note, ctx, formulas, seen);
		case 'member': {
			const obj = evalNode(node.obj, note, ctx, formulas, seen);
			return getMemberValue(obj, node.name);
		}
		case 'index': {
			const obj = evalNode(node.obj, note, ctx, formulas, seen);
			const idx = evalNode(node.idx, note, ctx, formulas, seen);
			if (obj == null) return null;
			if (typeof obj === 'object') return obj?.[idx] ?? null;
			fail(`Cannot index into ${typeof obj} with [${idx}]`);
		}
		case 'call': return evalCall(node, note, ctx, formulas, seen);
		case 'neg': {
			const v = evalNode(node.e, note, ctx, formulas, seen);
			if (typeof v !== 'number') fail(`Unary "-" needs a number, got: ${JSON.stringify(v)}`);
			return -v;
		}
		case '!': return !isTruthy(evalNode(node.e, note, ctx, formulas, seen));
		case '&&': {
			const l = evalNode(node.l, note, ctx, formulas, seen);
			return isTruthy(l) ? evalNode(node.r, note, ctx, formulas, seen) : l;
		}
		case '||': {
			const l = evalNode(node.l, note, ctx, formulas, seen);
			return isTruthy(l) ? l : evalNode(node.r, note, ctx, formulas, seen);
		}
		case '==': case '!=': {
			const l = evalNode(node.l, note, ctx, formulas, seen);
			const r = evalNode(node.r, note, ctx, formulas, seen);
			const eq = (l === r) || (l instanceof FileEnv && r instanceof FileEnv && l._note.rel === r._note.rel)
				|| (l != null && r != null && !(l instanceof FileEnv) && !(r instanceof FileEnv)
					&& typeof l !== 'object' && typeof r !== 'object' && compare(l, r) === 0);
			return node.k === '==' ? eq : !eq;
		}
		case '>': case '<': case '>=': case '<=': {
			const l = evalNode(node.l, note, ctx, formulas, seen);
			const r = evalNode(node.r, note, ctx, formulas, seen);
			if (l == null || r == null) return false;
			if (typeof l === 'object' || typeof r === 'object') {
				fail(`Cannot order-compare non-primitive values with "${node.k}"`);
			}
			const c = compare(l, r);
			return node.k === '>' ? c > 0 : node.k === '<' ? c < 0 : node.k === '>=' ? c >= 0 : c <= 0;
		}
		case '+': case '-': case '*': case '/': case '%': {
			const l = evalNode(node.l, note, ctx, formulas, seen);
			const r = evalNode(node.r, note, ctx, formulas, seen);
			return applyArith(node.k, l, r);
		}
		default:
			fail(`Unsupported expression node: ${node.k}`);
	}
}

function applyArith(op, l, r) {
	if (op === '+' && (typeof l === 'string' || typeof r === 'string')) {
		// date arithmetic: date + "1w" / duration strings
		const dl = typeof l === 'string' ? parseDuration(l) : null;
		const dr = typeof r === 'string' ? parseDuration(r) : null;
		if (dl !== null && typeof r === 'number') return r + dl;
		if (dr !== null && typeof l === 'number') return l + dr;
		if (typeof l === 'string' && dr === null && dl === null && typeof r !== 'number') return l + String(r);
		fail(`Cannot add ${JSON.stringify(l)} and ${JSON.stringify(r)}`);
	}
	if (op === '-' && typeof l === 'string') {
		const dl = parseDuration(l);
		if (dl !== null && typeof r === 'number') return r - dl;
	}
	if (op === '-' && typeof r === 'string') {
		const dr = parseDuration(r);
		if (dr !== null && typeof l === 'number') return l - dr;
	}
	if (typeof l !== 'number' || typeof r !== 'number') {
		fail(`Arithmetic "${op}" needs numbers, got ${JSON.stringify(l)} and ${JSON.stringify(r)}`);
	}
	switch (op) {
		case '+': return l + r;
		case '-': return l - r;
		case '*': return l * r;
		case '/': return r === 0 ? null : l / r;
		case '%': return r === 0 ? null : l % r;
	}
}

function evalIdentifier(name, note, ctx, formulas, seen) {
	if (name === 'file') return new FileEnv(note, ctx);
	if (name === 'this') {
		const src = ctx.source && ctx.index?.notes?.find((n) => n.rel === ctx.source);
		return src ? new FileEnv(src, ctx) : new FileEnv(note, ctx);
	}
	if (name === 'note') return note.props ?? {};
	if (name === 'tags') return note.tags ?? [];
	if (name === 'meta' || name === 'values') {
		fail(`"${name}" is not supported in this context`);
	}
	const v = propsPath(note.props ?? {}, [name]);
	if (v !== null) return v;
	return null;
}

function getMemberValue(obj, name) {
	if (obj instanceof FileEnv) return obj[name];
	if (obj == null) return null;
	if (Array.isArray(obj)) {
		if (name === 'length') return obj.length;
		fail(`Unsupported list member: .${name}`);
	}
	if (typeof obj === 'string') {
		if (name === 'length') return obj.length;
		fail(`Unsupported string member: .${name} (use methods like .lower(), .contains())`);
	}
	if (typeof obj === 'object') return obj[name] ?? null;
	fail(`Cannot access .${name} on ${typeof obj}`);
}

function evalCall(node, note, ctx, formulas, seen) {
	const { callee, args } = node;
	const evalArgs = () => args.map((a) => evalNode(a, note, ctx, formulas, seen));

	if (callee.k === 'id') {
		const name = callee.name;
		switch (name) {
			case 'if': {
				if (args.length !== 3) fail('if() takes (condition, then, else)');
				const c = evalNode(args[0], note, ctx, formulas, seen);
				return isTruthy(c) ? evalNode(args[1], note, ctx, formulas, seen) : evalNode(args[2], note, ctx, formulas, seen);
			}
			case 'today': return (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();
			case 'now': return Date.now();
			case 'date': {
				const [v] = evalArgs();
				if (typeof v !== 'string') fail('date() takes a string');
				const t = Date.parse(v);
				if (Number.isNaN(t)) fail(`Cannot parse date: ${v}`);
				return t;
			}
			case 'list': return evalArgs();
			case 'link': {
				const [target, display] = evalArgs();
				return `[[${target}${display != null ? '|' + display : ''}]]`;
			}
			case 'file': {
				const [v] = evalArgs();
				if (v instanceof FileEnv) return v;
				const rel = resolveNoteName(String(v), ctx);
				return rel ? new FileEnv(ctx.index.notes.find((n) => n.rel === rel), ctx) : null;
			}
			default:
				fail(`Unsupported function: ${name}()`);
		}
	}

	if (callee.k === 'member') {
		const obj = evalNode(callee.obj, note, ctx, formulas, seen);
		const name = callee.name;
		return callMethod(obj, name, evalArgs, note, ctx);
	}

	fail(`Unsupported call target in expression`);
}

function callMethod(obj, name, evalArgs, note, ctx) {
	if (obj instanceof FileEnv) {
		switch (name) {
			case 'hasTag': return obj.hasTag(evalArgs()[0]);
			case 'inFolder': return obj.inFolder(evalArgs()[0]);
			case 'hasLink': return obj.hasLink(evalArgs()[0]);
			case 'asLink': {
				const [display] = evalArgs();
				const rel = obj._note.rel;
				return { __cellLink: true, t: display ?? obj._note.name, rel };
			}
			default:
				fail(`Unsupported file function: .${name}()`);
		}
	}
	if (typeof obj === 'string') {
		switch (name) {
			case 'lower': return obj.toLowerCase();
			case 'upper': return obj.toUpperCase();
			case 'contains': return obj.includes(String(evalArgs()[0]));
			case 'startsWith': return obj.startsWith(String(evalArgs()[0]));
			case 'endsWith': return obj.endsWith(String(evalArgs()[0]));
			case 'isEmpty': return obj === '';
			case 'toString': return obj;
			default:
				fail(`Unsupported string function: .${name}()`);
		}
	}
	if (typeof obj === 'number') {
		switch (name) {
			case 'toFixed': {
				const [d] = evalArgs();
				return obj.toFixed(typeof d === 'number' ? d : 0);
			}
			case 'round': {
				const [d] = evalArgs();
				const f = typeof d === 'number' ? 10 ** d : 1;
				return Math.round(obj * f) / f;
			}
			case 'toString': return String(obj);
			default:
				fail(`Unsupported number function: .${name}()`);
		}
	}
	if (Array.isArray(obj)) {
		switch (name) {
			case 'contains': {
				const [x] = evalArgs();
				return obj.some((v) => v === x || compare(v, x) === 0);
			}
			case 'length': return obj.length;
			case 'isEmpty': return obj.length === 0;
			default:
				fail(`Unsupported list function: .${name}()`);
		}
	}
	if (obj == null) {
		switch (name) {
			case 'isEmpty': return true;
			default:
				fail(`Cannot call .${name}() on an empty value`);
		}
	}
	fail(`Unsupported receiver type for .${name}()`);
}

// ---------------------------------------------------------------------------
// Filter trees

function evalFilterTree(tree, note, ctx, formulas) {
	if (typeof tree === 'string') {
		return isTruthy(evalNode(parseExpr(tree), note, ctx, formulas, new Set()));
	}
	if (tree && typeof tree === 'object') {
		const keys = Object.keys(tree);
		if (keys.length !== 1) fail(`Filter object must have exactly one of and/or/not, got: ${keys.join(', ')}`);
		const key = keys[0];
		const list = tree[key];
		if (key === 'not') {
			// Obsidian NOT: true when NONE of the listed statements match (!some).
			const stmts = Array.isArray(list) ? list : [list];
			return !stmts.some((f) => evalFilterTree(f, note, ctx, formulas));
		}
		if (key === 'and') {
			return (Array.isArray(list) ? list : [list]).every((f) => evalFilterTree(f, note, ctx, formulas));
		}
		if (key === 'or') {
			return (Array.isArray(list) ? list : [list]).some((f) => evalFilterTree(f, note, ctx, formulas));
		}
		fail(`Unknown filter key: ${key}`);
	}
	fail(`Unsupported filter: ${JSON.stringify(tree)}`);
}

// ---------------------------------------------------------------------------
// Cell rendering

const WIKILINK_RE = /^\[\[([^\]#|]+)(#[^\]|]*)?(?:\|([^\]]+))?\]\]$/;

function resolveNoteName(name, ctx) {
	const notes = ctx.index?.notes ?? [];
	const clean = String(name).replace(/\.md$/, '');
	return notes.find((n) => n.name === clean || n.rel === clean || n.rel === clean + '.md')?.rel
		?? notes.find((n) => n.name.toLowerCase() === clean.toLowerCase())?.rel
		?? null;
}

function renderCell(value, note, ctx, isFileColumn) {
	if (value && value.__cellLink) {
		return [{ t: value.t, href: ctx.href(value.rel) }];
	}
	if (value instanceof FileEnv) return isFileColumn ? [{ t: value.name, href: ctx.href(value._note.rel) }] : value.name;
	if (value == null) return '';
	if (typeof value === 'boolean') return value ? 'true' : 'false';
	if (typeof value === 'number') return String(value);
	if (Array.isArray(value)) {
		return value.map((v) => (typeof v === 'string' || typeof v === 'number' ? String(v) : JSON.stringify(v))).join(', ');
	}
	if (typeof value === 'string') {
		const m = WIKILINK_RE.exec(value.trim());
		if (m) {
			const target = m[1].trim();
			const rel = resolveNoteName(target, ctx);
			if (rel) return { t: m[3]?.trim() || target, href: ctx.href(rel) };
			return m[3]?.trim() || target;
		}
		return value;
	}
	return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// View rendering helpers

function md(text) { return { k: 'md', p: { text } }; }

function section(head, children) { return { k: 'section', p: { head }, c: children }; }

function table(cols, rows) { return { k: 'table', p: { cols, rows } }; }

function displayName(key, data) {
	const dn = data?.properties?.[key]?.displayName;
	return typeof dn === 'string' ? dn : key;
}

// `order` lists the columns; a trailing sort config may exist separately.
function buildColumns(view, data) {
	if (Array.isArray(view.order) && view.order.length) {
		return view.order.map((key) => ({ id: String(key), head: displayName(String(key), data) }));
	}
	// No order given: fall back to file.name plus the properties used in sort.
	const cols = ['file.name'];
	if (Array.isArray(view.sort)) {
		for (const s of view.sort) {
			const p = s?.property;
			if (typeof p === 'string' && !cols.includes(p)) cols.push(p);
		}
	}
	return cols.map((key) => ({ id: key, head: displayName(key, data) }));
}

function sortNotes(notes, sort, ctx, formulas) {
	if (!Array.isArray(sort) || !sort.length) return notes;
	const sorted = [...notes];
	sorted.sort((a, b) => {
		for (const s of sort) {
			if (!s || typeof s.property !== 'string') continue;
			const av = resolvePropPath(s.property, a, ctx, formulas);
			const bv = resolvePropPath(s.property, b, ctx, formulas);
			let c = compare(av, bv);
			if (String(s.direction).toUpperCase() === 'DESC') c = -c;
			if (c !== 0) return c;
		}
		return 0;
	});
	// nulls always last regardless of direction
	return sorted;
}

function renderGroupedTable(rowsByGroup, cols, ctx) {
	const out = [];
	for (const [label, notes] of rowsByGroup) {
		const rows = notes.map((n) => n.cells);
		out.push(section(String(label), [table(cols, rows)]));
	}
	return out;
}

function groupNotes(notes, groupBy, groupOrder, ctx, formulas, buildCells) {
	const prop = groupBy?.property;
	if (typeof prop !== 'string') fail('groupBy requires a "property"');
	const desc = String(groupBy?.direction ?? 'ASC').toUpperCase() === 'DESC';
	const map = new Map();
	for (const n of notes) {
		const v = resolvePropPath(prop, n, ctx, formulas);
		const label = v == null ? '(empty)' : Array.isArray(v) ? v.join(', ') : String(v);
		if (!map.has(label)) map.set(label, []);
		map.get(label).push(n);
	}
	let entries = [...map.entries()];
	if (Array.isArray(groupOrder)) {
		const wanted = groupOrder.map((g) => (g == null ? '(empty)' : String(g)));
		entries = wanted.flatMap((label) => entries.filter(([l]) => l === label));
	} else {
		entries.sort((a, b) => (desc ? -compare(a[0], b[0]) : compare(a[0], b[0])));
	}
	return entries.map(([label, ns]) => ({
		label,
		rows: ns.map((n) => buildCells(n)),
	}));
}

// ---------------------------------------------------------------------------

function renderView(view, data, ctx, formulas, idx) {
	const name = typeof view?.name === 'string' && view.name ? view.name : `View ${idx + 1}`;
	const children = [];
	if (view?.summaries) children.push(md('Summaries are not supported by this reader.'));

	if (view?.type !== 'table') {
		return section(name, [md(`⚠ Unsupported view type: "${view?.type}". Only "table" views are rendered.`)]);
	}

	let notes = ctx.index?.notes ?? [];
	if (!Array.isArray(notes)) fail('ctx.index.notes must be an array');

	// Global AND view filters.
	const globalFilters = data?.filters;
	const viewFilters = view?.filters;
	if (globalFilters != null || viewFilters != null) {
		notes = notes.filter((n) => {
			if (globalFilters != null && !evalFilterTree(globalFilters, n, ctx, formulas)) return false;
			if (viewFilters != null && !evalFilterTree(viewFilters, n, ctx, formulas)) return false;
			return true;
		});
	}

	notes = sortNotes(notes, view?.sort, ctx, formulas);

	const limit = typeof view?.limit === 'number' && view.limit >= 0 ? view.limit : Infinity;
	const cols = buildColumns(view, data);
	const isFileCol = (id) => id === 'file.name' || id === 'file';

	const buildCells = (n) => cols.map((c) => {
		// file.name links to the note only when the column really is file.name.
		if (c.id === 'file.name') return [{ t: n.name, href: ctx.href(n.rel) }];
		return renderCell(resolvePropPath(c.id, n, ctx, formulas), n, ctx, isFileCol(c.id));
	});

	if (view?.groupBy) {
		const groups = groupNotes(notes, view.groupBy, view.groupOrder, ctx, formulas, buildCells);
		let shown = 0;
		const visibleLimit = Math.min(limit, VISIBLE_ROW_CAP);
		for (const g of groups) {
			if (shown >= visibleLimit) break;
			const rows = g.rows.slice(0, visibleLimit - shown);
			shown += rows.length;
			children.push(section(g.label, [table(cols, rows)]));
		}
		children.push(md(`${notes.length} note${notes.length === 1 ? '' : 's'} in ${groups.length} group${groups.length === 1 ? '' : 's'}`
			+ (shown < notes.length ? ` · showing first ${shown} of ${notes.length}` : '')));
	} else {
		const shown = notes.slice(0, limit === Infinity ? VISIBLE_ROW_CAP : limit);
		if (shown.length > VISIBLE_ROW_CAP) shown.length = VISIBLE_ROW_CAP;
		children.push(table(cols, shown.map(buildCells)));
		const total = notes.length;
		let msg = `${total} note${total === 1 ? '' : 's'}`;
		if (shown.length < total) msg += ` · showing first ${shown.length} of ${total}`;
		else if (limit !== Infinity && total > limit) msg += ` · limited to ${limit}`;
		children.push(md(msg));
	}

	return section(name, children);
}

// ---------------------------------------------------------------------------

// data: parsed .base YAML object. ctx: { root, index, source, href, renderNote? }.
export function renderBase(data, ctx) {
	if (!data || typeof data !== 'object') {
		return section('Base', [md('Invalid .base document: expected a YAML mapping.')]);
	}
	if (!ctx || typeof ctx.href !== 'function' || !ctx.index) {
		return section('Base', [md('renderBase requires ctx with index and href(rel).')]);
	}
	const formulas = data.formulas && typeof data.formulas === 'object' ? data.formulas : {};
	const views = Array.isArray(data.views) ? data.views : [];
	if (!views.length) {
		return section('Base', [md('This .base file defines no views.')]);
	}
	const children = views.map((v, i) => {
		try {
			return renderView(v, data, ctx, formulas, i);
		} catch (e) {
			const name = typeof v?.name === 'string' && v.name ? v.name : `View ${i + 1}`;
			return section(name, [md(`⚠ Error: ${e instanceof BaseError ? e.message : String(e?.message ?? e)}`)]);
		}
	});
	return { k: 'col', c: children };
}

export default renderBase;
