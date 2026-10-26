--!strict
-- carly.luau: read-only vault exports for Carly's lua tool.
-- Carly calls them as await(plugins.obsidian.<name>(...)); each one runs the
-- Bun helper and answers from its callback, because a window plugin call has
-- a 50 ms budget and an index read takes longer than that.
local bridge = require("./bridge")

local carly = {}

local function answer(call: any, request: any, timeout: number): any
	bridge.run(request, function(result, err)
		if result then
			call:reply(result)
		else
			call:fail(err or "Vault read failed")
		end
	end)
	return call:wait(timeout)
end

-- An explicit root wins; otherwise the vault of the focused pane.
local function resolve(root_of: (WindowCx) -> string?, cx: any, root: string?): (string?, string?)
	local at = root
	if at == nil or at == "" then
		at = root_of(cx)
	end
	if at == nil then
		return nil, "No Obsidian vault for the focused pane; pass root, as listed by vaults()"
	end
	return at, nil
end

function carly.register(root_of: (WindowCx) -> string?)
	-- tern.carly exists in desktop window VMs only.
	if tern.carly == nil then
		return
	end

	tern.carly.export("vaults", {
		sig = "() -> {focused: string?, known: {string}}",
		doc = "The Obsidian vault of the focused pane, when it has one, and every vault Obsidian knows about. Pass a known root to the other exports to read outside the focused vault.",
	}, function(cx, call)
		return answer(call, { op = "vaults", root = root_of(cx) }, 20000)
	end)

	tern.carly.export("vault", {
		sig = "(root: string?) -> {root: string, count: number, warnings: {string}}",
		doc = "A vault's root path, note count and first 20 index warnings. root defaults to the focused pane's vault.",
	}, function(root, cx, call)
		local at, why = resolve(root_of, cx, root)
		if at == nil then
			call:fail(why)
			return nil
		end
		return answer(call, { op = "vault", root = at }, 90000)
	end)

	tern.carly.export("find", {
		sig = "(query: string, limit: number?, root: string?) -> {root: string, total: number, matches: {{rel: string, name: string, ext: string, tags: {string}, aliases: {string}}}}",
		doc = "Case-insensitive substring match over vault paths, file names, aliases and tags; an empty query lists files. limit defaults to 20, at most 50; total counts every match. Files skipped by the vault's ignore filters are not listed; read() still opens them.",
	}, function(query, limit, root, cx, call)
		local at, why = resolve(root_of, cx, root)
		if at == nil then
			call:fail(why)
			return nil
		end
		return answer(call, { op = "find", root = at, query = query, limit = limit }, 90000)
	end)

	tern.carly.export("read", {
		sig = "(rel: string, from: number?, lines: number?, root: string?) -> {root: string, rel: string, total_lines: number, from: number, lines: number, next: number?, text: string}",
		doc = "Reads a vault file as text; rel is vault-relative or absolute inside the vault. from is the first line (default 1) and lines the page size (default 200, at most 2000); a page also stops at 12 KB. next is the line to ask for next, nil at the end.",
	}, function(rel, from, lines, root, cx, call)
		local at, why = resolve(root_of, cx, root)
		if at == nil then
			call:fail(why)
			return nil
		end
		return answer(call, { op = "read", root = at, rel = rel, from = from, lines = lines }, 20000)
	end)

	tern.carly.export("links", {
		sig = "(rel: string, root: string?) -> {root: string, rel: string, excluded: boolean, out: {string}, back: {string}}",
		doc = "Outgoing wikilinks and backlinks of a vault file, as vault-relative paths, at most 80 each. An unresolved link keeps its target text. excluded is true for a file the vault's ignore filters skip, whose own links are not parsed.",
	}, function(rel, root, cx, call)
		local at, why = resolve(root_of, cx, root)
		if at == nil then
			call:fail(why)
			return nil
		end
		return answer(call, { op = "links", root = at, rel = rel }, 90000)
	end)

	tern.carly.context(function(cx)
		local root = root_of(cx)
		return if root then "Obsidian vault: " .. root else nil
	end)
end

-- Hindsight: the vault's twin knowledge base. root/bank/endpoint come from the
-- vault binding, never from opts.
local function pick(opts: any, keys: { string }): { [string]: any }
	local out: { [string]: any } = {}
	if opts == nil then
		return out
	end
	if type(opts) ~= "table" then error("Options must be a table") end
	for key in opts do
		if table.find(keys, key) == nil then error("Unknown option: " .. tostring(key)) end
	end
	for _, key in keys do
		if opts[key] ~= nil then
			out[key] = opts[key]
		end
	end
	return out
end

local RECALL_KEYS = { "types", "max_tokens", "tags", "tags_match", "tag_groups", "scope", "folder", "prefer_observations", "include_chunks", "include_entities", "include_source_facts", "min_scores", "budget", "limit", "offset" }
local REFLECT_KEYS = { "max_tokens", "tags", "tags_match", "tag_groups", "scope", "folder", "fact_types", "response_schema", "exclude_mental_models", "exclude_mental_model_ids", "budget", "trace" }
local MODEL_KEYS = { "id", "name", "source_query", "query", "tags", "tags_match", "trigger", "max_tokens", "limit", "offset", "detail", "operation_id", "budget", "scope" }
local KNOWLEDGE_KEYS = { "id", "name", "source_query", "query", "tags", "tags_match", "tag_groups", "trigger", "max_tokens", "parent_id", "limit", "scope", "operation_id" }

function carly.register_hindsight(root_of: (WindowCx) -> string?)
	if tern.carly == nil then
		return
	end

	tern.carly.export("hindsight_status", {
		sig = "(root: string?, job_id: string?) -> any",
		doc = "The vault's Hindsight binding: endpoint, bank, scope, tracked and inherited document counts, last sync, and recent jobs. The API key is never returned.",
	}, function(root, job_id, cx, call)
		local at, why = resolve(root_of, cx, root)
		if at == nil then
			call:fail(why)
			return nil
		end
		return answer(call, { op = "hindsight-status", root = at, job_id = job_id }, 20000)
	end)

	tern.carly.export("hindsight_sync", {
		sig = "(opts: {force: boolean?, job_id: string?}?, root: string?) -> any",
		doc = "Starts a Tern-owned background sync and immediately returns job_id. opts.force resends selected notes, never deletes the bank. Poll hindsight_status(root, job_id) for submitted versus server-completed ingested counts. opts.job_id retries an interrupted or failed job.",
	}, function(opts, root, cx, call)
		local at, why = resolve(root_of, cx, root)
		if at == nil then
			call:fail(why)
			return nil
		end
		local options = pick(opts, { "force", "job_id" })
		bridge.sync(at, options, function(job, err)
			if job then call:reply(job) else call:fail(err or "Cannot start Hindsight sync") end
		end)
		return call:wait(20000)
	end)

	tern.carly.export("hindsight_recall", {
		sig = "(query: string, opts: any?, root: string?) -> {root: string, bank: string, query: string, results: {any}, total: number, entities: {string}}",
		doc = "Recalls vault-scoped facts with citation IDs and note sources (current/stale/excluded/unresolved). Observation evidence expands source facts. opts: types, budget, max_tokens, tags/tags_match/tag_groups, scope='vault'|'bank', folder, prefer_observations, include_chunks/entities/source_facts, min_scores, offset, limit. Results expose next_offset; use read(rel) to check original text.",
	}, function(query, opts, root, cx, call)
		local at, why = resolve(root_of, cx, root)
		if at == nil then
			call:fail(why)
			return nil
		end
		local request = pick(opts, RECALL_KEYS)
		request.op, request.root, request.query = "hindsight-recall", at, query
		return answer(call, request, 90000)
	end)

	tern.carly.export("hindsight_reflect", {
		sig = "(question: string, opts: any?, root: string?) -> {root: string, bank: string, text: string, sources: {any}, mentalModels: {any}}",
		doc = "Reflects over vault knowledge and preserves cited fact IDs and original note sources. opts: budget, max_tokens, tags/tags_match/tag_groups, scope, folder, fact_types, response_schema, exclude_mental_models/ids, trace. Does not retain conversations.",
	}, function(question, opts, root, cx, call)
		local at, why = resolve(root_of, cx, root)
		if at == nil then
			call:fail(why)
			return nil
		end
		local request = pick(opts, REFLECT_KEYS)
		request.op, request.root, request.query = "hindsight-reflect", at, question
		return answer(call, request, 90000)
	end)

	tern.carly.export("mental_model", {
		sig = "(action: string, opts: any?, root: string?) -> any",
		doc = "Reads: list, get(id), query(id,query), operation(operation_id). Writes: create(name,source_query), update(id), refresh(id), delete(id). opts also accepts tags, tags_match, trigger, max_tokens, limit, offset, detail, budget, scope. query uses cached model content as reflection context, without refreshing it. Writes return service errors or operation receipts.",
	}, function(action, opts, root, cx, call)
		local at, why = resolve(root_of, cx, root)
		if at == nil then
			call:fail(why)
			return nil
		end
		local request = pick(opts, MODEL_KEYS)
		request.op, request.root, request.action = "hindsight-models", at, action
		return answer(call, request, 110000)
	end)

	tern.carly.export("knowledge", {
		sig = "(action: string, opts: any?, root: string?) -> any",
		doc = "Reads: tree, search(query), get(id), operation(operation_id). Writes: create(name,source_query), update(id), delete(id), folder(name,parent_id?), refresh(id). opts also accepts tags/tags_match/tag_groups, trigger, max_tokens, parent_id (null moves to root), limit, scope. Reading never creates or updates a page.",
	}, function(action, opts, root, cx, call)
		local at, why = resolve(root_of, cx, root)
		if at == nil then
			call:fail(why)
			return nil
		end
		local request = pick(opts, KNOWLEDGE_KEYS)
		request.op, request.root, request.action = "hindsight-knowledge", at, action
		return answer(call, request, 90000)
	end)

	tern.carly.export("hindsight_config", {
		sig = "(patch: any?, root: string?) -> any",
		doc = "Reads effective vault Hindsight settings with no secrets. A patch explicitly changes Tern overrides: apiUrl, bankId, apiKey, includeFolders, excludeFolders, prefixDocId, defaultBudget, syncOnEdit, observationScopes. null clears an override. The vault's Obsidian settings file remains the inherited baseline.",
	}, function(patch, root, cx, call)
		local at, why = resolve(root_of, cx, root)
		if at == nil then call:fail(why); return nil end
		bridge.run({ op = "hindsight-config", root = at, patch = patch }, function(result, err)
			if not result then call:fail(err or "Cannot configure Hindsight"); return end
			if patch and result.scope.syncOnEdit then
				bridge.background({ op = "hindsight-watch", root = at }, function(_, watch_err)
					if watch_err then tern.log.error("Hindsight watcher", watch_err) end
				end)
			end
			call:reply(result)
		end)
		return call:wait(20000)
	end)
end

return carly
