--!strict
local bridge = require("./bridge")
local ui = tern.ui

type State = {
	path: string,
	anchor: string,
	title: string,
	view: Node?,
	error: string?,
	loading: boolean,
}

local function hydrate(node: any): Node
	if node.k == "table" and node.p then
		return ui.table(node.p.cols or {}, node.p.rows or {})
	end
	if node.c then
		for i, child in node.c do
			node.c[i] = hydrate(child)
		end
	end
	return node
end

local MIME: { [string]: string } = {
	png = "image/png", jpg = "image/jpeg", jpeg = "image/jpeg", gif = "image/gif",
	webp = "image/webp", svg = "image/svg+xml", bmp = "image/bmp", avif = "image/avif",
}

-- `tern.ui.md` cannot load a local image, so a marker becomes an image node
-- backed by bytes sent through cx:blob.
local function inline_images(node: any, blobs: { [string]: string }): any
	if type(node) ~= "table" then
		return node
	end
	if node.k == "md" and node.p and type(node.p.text) == "string" then
		local text = node.p.text
		if not text:find("![[tern-image:", 1, true) then
			return node
		end
		local rows: { Node } = {}
		local rest = text
		while true do
			local from, to, index = rest:find("!%[%[tern%-image:(%d+)%]%]")
			if from == nil then
				if rest ~= "" then
					table.insert(rows, tern.ui.md(rest))
				end
				break
			end
			if from > 1 then
				table.insert(rows, tern.ui.md(rest:sub(1, from - 1)))
			end
			local blob = blobs[index :: string]
			if blob then
				table.insert(rows, tern.ui.node("image", { blob = blob, alt = "Obsidian image", max = { h = "40lines" } }))
			end
			rest = rest:sub((to :: number) + 1)
		end
		return tern.ui.col(rows)
	end
	if node.c then
		for i, child in node.c do
			node.c[i] = inline_images(child, blobs)
		end
	end
	return node
end

local function load(state: State, cx: BlockCx)
	state.loading = true
	state.error = nil
	bridge.run({ op = "render", path = state.path, anchor = state.anchor }, function(result, err)
		local alive = false
		for _, pane in tern.pane.list() do
			if pane.pane == cx.pane then
				alive = true
				break
			end
		end
		if not alive then
			return
		end
		state.loading = false
		state.error = err
		if result then
			local blobs: { [string]: string } = {}
			for _, image in result.images or {} do
				local ok, bytes = pcall(tern.fs.read, image.path)
				local mime = MIME[(image.rel:match("%.([%w]+)$") or ""):lower()]
				if ok and mime then
					-- The helper numbers the markers; send them under that number.
					blobs[image.key:gsub("^img", "")] = cx:blob(bytes, mime)
				end
			end
			state.view = inline_images(hydrate(result.view), blobs)
			state.title = result.title
		end
		cx:render()
	end)
end

tern.block.define("note", {
	init = function(cx: BlockCx, args: { string }, saved: any): State
		local path = args[1] or (saved and saved.path) or ""
		local anchor = args[2] or (saved and saved.anchor) or ""
		local state: State = { path = path, anchor = anchor, title = path:match("([^/]+)$") or "Obsidian", loading = false }
		if path == "" then
			state.error = "Open an Obsidian note or .base file."
		else
			load(state, cx)
		end
		return state
	end,
	title = function(state: State)
		return state.title
	end,
	view = function(state: State)
		local children: { Node } = {}
		if state.loading then
			table.insert(children, ui.text("Loading Obsidian note…"))
		end
		if state.error then
			table.insert(children, ui.text({ ui.span(state.error, "error") }))
		end
		if state.view then
			table.insert(children, state.view)
		end
		local source = ui.badge("Edit source", "accent")
		source.p = { text = "Edit source", tone = "accent", actions = { click = "source" } }
		local refresh = ui.badge("Refresh", "neutral")
		refresh.p = { text = "Refresh", tone = "neutral", actions = { click = "refresh" } }
		return { main = ui.col(children), dock = ui.row({ source, refresh }) }
	end,
	event = function(state: State, event: UiEvent, cx: BlockCx)
		if event.act == "refresh" then
			load(state, cx)
		elseif event.act == "source" then
			cx:open("obsidian://source?path=" .. bridge.encode(state.path))
		end
	end,
	key = function(state: State, key: Key, cx: BlockCx)
		if key.name == "r" and not key.ctrl and not key.meta then
			load(state, cx)
			return true
		elseif key.name == "e" and not key.ctrl and not key.meta then
			cx:open("obsidian://source?path=" .. bridge.encode(state.path))
			return true
		end
		return false
	end,
	save = function(state: State)
		return { path = state.path, anchor = state.anchor }
	end,
})

-- Per-vault allow/deny globs, stored in tern.kv under "vault-filters" keyed by
-- vault root. helper.mjs applies them when it builds the index, so the picker,
-- Bases, tags, and Carly's find/links/vault all see the filtered set.
type FilterState = {
	root: string?,
	allow: { string },
	deny: { string },
	target: string,
	draft: string,
	cursor: number,
	editing: boolean,
	focus: string?,
	count: number?,
	error: string?,
}

local function strings(value: any): { string }
	local out: { string } = {}
	if type(value) == "table" then
		for _, item in value do
			if type(item) == "string" and item ~= "" then
				table.insert(out, item)
			end
		end
	end
	return out
end

local function chars(text: string): { string }
	local out: { string } = {}
	for _, code in utf8.codes(text) do
		table.insert(out, utf8.char(code))
	end
	return out
end

-- The field's cursor prop counts UTF-16 code units; state counts characters.
local function units(parts: { string }, upto: number): number
	local total = 0
	for i = 1, upto do
		local ch = parts[i]
		if ch then
			total += if #ch == 4 then 2 else 1
		end
	end
	return total
end

local function running(pane: number): boolean
	for _, info in tern.pane.list() do
		if info.pane == pane then
			return true
		end
	end
	return false
end

-- Vault-bound settings live in the vault, so they travel with the notes and
-- stay out of Tern's global kv store.
local SETTINGS_FILE = ".obsidian/tern-obsidian/settings.json"

local function settings_read(root: string): { [string]: any }
	local ok, source = pcall(tern.fs.read, root .. "/" .. SETTINGS_FILE)
	if not ok or type(source) ~= "string" then
		return {}
	end
	local decoded, value = pcall(tern.json.decode, source)
	return if decoded and type(value) == "table" then value else {}
end

local function settings_write(root: string, value: { [string]: any })
	tern.fs.mkdir(root .. "/.obsidian/tern-obsidian")
	tern.fs.write(root .. "/" .. SETTINGS_FILE, tern.json.encode(value, true))
end

local function store(state: FilterState)
	if state.root == nil then
		return
	end
	local all = settings_read(state.root)
	all.filters = { allow = state.allow, deny = state.deny }
	settings_write(state.root, all)
end

local function count_files(state: FilterState, cx: BlockCx)
	if state.root == nil then
		return
	end
	bridge.run({ op = "vault", root = state.root }, function(result, err)
		if not running(cx.pane) then
			return
		end
		state.count = if result then result.count else nil
		state.error = err
		cx:render()
	end)
end

local function add_pattern(state: FilterState): boolean
	local pattern = (state.draft:gsub("^%s+", ""):gsub("%s+$", ""))
	if pattern == "" then
		return false
	end
	local list: { string }
	if state.target == "allow" then
		list = state.allow
	else
		list = state.deny
	end
	for _, existing in list do
		if existing == pattern then
			state.draft, state.cursor = "", 0
			return false
		end
	end
	table.insert(list, pattern)
	state.draft, state.cursor = "", 0
	return true
end


-- basis = "content" keeps a badge a pill inside a row; without it the flex
-- child stretches and the tone chrome paints a full-width bar.
local function list_rows(list: { string }, name: string): { any }
	local rows: { any } = {}
	for i, pattern in list do
		table.insert(rows, {
			id = name .. ":" .. tostring(i),
			label = pattern,
			control = { k = "action", act = "remove", label = "Remove" },
		})
	end
	if #rows == 0 then
		table.insert(rows, {
			id = name .. ":none",
			label = "No patterns",
			hint = if name == "allow" then "Every file is listed." else "Nothing is hidden.",
			disabled = "Nothing to remove",
			control = { k = "action", act = "noop", label = "—" },
		})
	end
	return rows
end

tern.block.define("filters", {
	init = function(cx: BlockCx, args: { string }, saved: any): FilterState
		local root: string? = args[1]
		if root == nil or root == "" then
			root = if type(saved) == "table" and type(saved.root) == "string" then saved.root else bridge.find(cx.cwd or "")
		end
		if root == nil then
			local kept = tern.kv.get("last-vault")
			if type(kept) == "string" and kept ~= "" and tern.fs.exists(kept .. "/.obsidian") then
				root = kept
			end
		end
		local state: FilterState = {
			root = root,
			allow = {},
			deny = {},
			target = "allow",
			draft = "",
			cursor = 0,
			editing = false,
			focus = nil,
			count = nil,
			error = nil,
		}
		if root then
			local all = settings_read(root)
			local entry = all.filters
			if type(entry) == "table" then
				state.allow = strings(entry.allow)
				state.deny = strings(entry.deny)
			end
			count_files(state, cx)
		end
		return state
	end,
	title = function(_state: FilterState)
		return "Vault filters"
	end,
	view = function(state: FilterState, _cx: BlockCx)
		if state.root == nil then
			return {
				main = ui.col({
					ui.text({ ui.span("This block needs an Obsidian vault.", "error") }),
					ui.text({ ui.span("Run Obsidian: Edit vault filters from any pane to choose one.", "muted") }),
				}),
			}
		end
		local lead = state.root:match("([^/]+)$") or state.root
		if state.count then
			lead = lead .. "  ·  " .. tostring(state.count) .. " files listed"
		end
		if state.error then
			lead = lead .. "  ·  " .. state.error
		end
		local add_rows: { any } = {
			{
				id = "target",
				label = "Add to",
				hint = "Enter puts the pattern in this list.",
				control = {
					k = "choice",
					value = state.target,
					style = "segmented",
					options = {
						{ value = "allow", label = "Allow" },
						{ value = "deny", label = "Deny" },
					},
				},
			},
			{
				id = "draft",
				label = "Pattern",
				hint = "Glob over vault paths: raw/**, *.canvas, attachments.",
				control = { k = "text", value = state.draft, mono = true },
			},
		}
		-- A region's root is never drawn, only its children, so the page has to
		-- sit inside a container.
		return {
			main = ui.col({ ui.node("prefs", {
				title = "Obsidian",
				lead = lead,
				pages = { { id = "filters", label = "Vault filters", icon = "funnel" } },
				page = "filters",
				sections = {
					{ id = "add", title = "Add a pattern", rows = add_rows },
					{ id = "allow", title = "Allow · " .. tostring(#state.allow), rows = list_rows(state.allow, "allow") },
					{ id = "deny", title = "Deny · " .. tostring(#state.deny), rows = list_rows(state.deny, "deny") },
				},
				focus = state.focus,
				editing = if state.editing then {
					row = "draft",
					draft = state.draft,
					cursor = units(chars(state.draft), state.cursor),
				} else nil,
			}) }),
		}
	end,
	event = function(state: FilterState, event: UiEvent, cx: BlockCx)
		if event.ev == "change" then
			if event.item == "target" and (event.value == "allow" or event.value == "deny") then
				state.target = event.value
			end
			return
		end
		if event.ev == "activate" then
			if event.item == "draft" then
				state.editing = true
				state.focus = "draft"
			end
			return
		end
		if event.ev ~= "action" then
			return
		end
		if event.act == "close" then
			cx:exit(0)
			return
		end
		if event.act ~= "remove" then
			return
		end
		local name, index = (event.value or ""):match("^(%a+):(%d+)$")
		local at = tonumber(index)
		local list = if name == "allow" then state.allow elseif name == "deny" then state.deny else nil
		if list and at and list[at] then
			table.remove(list, at)
			store(state)
			count_files(state, cx)
		end
	end,
	key = function(state: FilterState, key: Key, cx: BlockCx): boolean
		if not state.editing then
			if key.name == "escape" then
				cx:exit(0)
				return true
			end
			return false
		end
		if key.name == "enter" then
			if add_pattern(state) then
				store(state)
				count_files(state, cx)
			end
			return true
		elseif key.name == "escape" then
			state.editing = false
			state.focus = nil
			return true
		elseif key.name == "backspace" then
			if state.cursor == 0 then
				return false
			end
			local parts = chars(state.draft)
			table.remove(parts, state.cursor)
			state.cursor -= 1
			state.draft = table.concat(parts)
			return true
		elseif key.name == "left" then
			if state.cursor == 0 then
				return false
			end
			state.cursor -= 1
			return true
		elseif key.name == "right" then
			if state.cursor >= #chars(state.draft) then
				return false
			end
			state.cursor += 1
			return true
		elseif key.name == "home" then
			state.cursor = 0
			return true
		elseif key.name == "end" then
			state.cursor = #chars(state.draft)
			return true
		elseif key.text and key.text ~= "" and not key.ctrl and not key.meta then
			local parts = chars(state.draft)
			local typed = chars(key.text)
			for i = #typed, 1, -1 do
				table.insert(parts, state.cursor + 1, typed[i])
			end
			state.cursor += #typed
			state.draft = table.concat(parts)
			return true
		end
		return false
	end,
	save = function(state: FilterState)
		return { root = state.root }
	end,
})

-- Hindsight binding for one vault: endpoint, bank and sync scope. Values start
-- from the vault's own Hindsight plugin and are overridden by this page.
type HsState = {
	root: string?,
	endpoint: string,
	bank: string,
	include: string,
	exclude: string,
	budget: string,
	prefix: boolean,
	autoSync: boolean,
	hasKey: boolean,
	observationScopes: string,
	draft: string,
	cursor: number,
	field: string?,
	focus: string?,
	tracked: number?,
	inherited: number?,
	lastSync: string?,
	job: string?,
	error: string?,
}

local function csv(values: { string }): string
	return table.concat(values, ", ")
end

local function split_csv(text: string): { string }
	local out: { string } = {}
	for piece in text:gmatch("[^,]+") do
		local clean = piece:gsub("^%s+", ""):gsub("%s+$", "")
		if clean ~= "" then
			table.insert(out, clean)
		end
	end
	return out
end

local function hs_patch(state: HsState, patch: { [string]: any }, cx: BlockCx)
	if state.root == nil then
		return
	end
	bridge.run({ op = "hindsight-config", root = state.root, patch = patch }, function(result, err)
		if not running(cx.pane) then
			return
		end
		state.error = err
		if result then
			state.endpoint = result.endpoint or state.endpoint
			state.bank = result.bank or state.bank
			state.hasKey = result.hasApiKey == true
			local scope = result.scope or {}
			state.include = csv(scope.include or {})
			state.exclude = csv(scope.exclude or {})
			state.budget = tostring(scope.budget or state.budget)
			state.prefix = scope.prefixDocId ~= false
			state.autoSync = scope.syncOnEdit == true
			if scope.observationScopes ~= nil then
				state.observationScopes = if type(scope.observationScopes) == "table" then tern.json.encode(scope.observationScopes) else tostring(scope.observationScopes)
			end
		end
		cx:render()
	end)
end

local function hs_status(state: HsState, cx: BlockCx)
	if state.root == nil then
		return
	end
	bridge.run({ op = "hindsight-status", root = state.root }, function(result, err)
		if not running(cx.pane) then
			return
		end
		state.error = err
		if result then
			state.endpoint = result.endpoint or state.endpoint
			state.bank = result.bank or state.bank
			state.include = csv(result.scope and result.scope.include or {})
			state.exclude = csv(result.scope and result.scope.exclude or {})
			state.budget = result.scope and result.scope.budget or state.budget
			state.prefix = if result.scope then result.scope.prefixDocId ~= false else state.prefix
			state.autoSync = result.scope and result.scope.syncOnEdit == true
			state.hasKey = result.hasApiKey == true
			state.tracked = result.tracked
			state.inherited = result.inherited
			state.lastSync = result.lastSyncAt
			local jobs = result.jobs or {}
			local job = result.job or jobs[#jobs]
			state.job = if job then tostring(job.job_id) .. " · " .. tostring(job.state) .. " · " .. tostring(job.ingested or 0) .. "/" .. tostring(job.submitted or 0) .. " ingested" else nil
		end
		cx:render()
	end)
end

local function hs_commit(state: HsState, cx: BlockCx)
	local field = state.field
	if field == nil then
		return
	end
	local value = (state.draft:gsub("^%s+", ""):gsub("%s+$", ""))
	local patch: { [string]: any } = {}
	if field == "endpoint" then
		patch.apiUrl = value
	elseif field == "bank" then
		patch.bankId = value
	elseif field == "include" then
		patch.includeFolders = split_csv(value)
	elseif field == "exclude" then
		patch.excludeFolders = split_csv(value)
	elseif field == "apiKey" or field == "observationScopes" then
		if field == "apiKey" then
			patch.apiKey = value
		else
			local ok, decoded = pcall(tern.json.decode, value)
			patch.observationScopes = if ok then decoded else value
		end
	end
	state.draft, state.cursor, state.field = "", 0, nil
	hs_patch(state, patch, cx)
end

local function hs_field(id: string, label: string, hint: string, value: string): any
	return { id = id, label = label, hint = hint, control = { k = "text", value = value, mono = true } }
end

local function hs_row(id: string, label: string, hint: string, value: string): any
	return { id = id, label = label, hint = hint, disabled = "Read only", control = { k = "text", value = value } }
end

tern.block.define("hindsight", {
	init = function(cx: BlockCx, args: { string }, saved: any): HsState
		local root: string? = args[1]
		if root == nil or root == "" then
			root = if type(saved) == "table" and type(saved.root) == "string" then saved.root else bridge.find(cx.cwd or "")
		end
		if root == nil then
			local kept = tern.kv.get("last-vault")
			if type(kept) == "string" and kept ~= "" and tern.fs.exists(kept .. "/.obsidian") then
				root = kept
			end
		end
		local state: HsState = {
			root = root, endpoint = "", bank = "", include = "", exclude = "", budget = "low",
			prefix = true, autoSync = false, hasKey = false, observationScopes = "combined",
			draft = "", cursor = 0, field = nil, focus = nil,
			tracked = nil, inherited = nil, lastSync = nil, job = nil, error = nil,
		}
		if root then
			local ok, source = pcall(tern.fs.read, root .. "/.obsidian/plugins/hindsight/data.json")
			if ok and type(source) == "string" then
				local decoded, settings = pcall(tern.json.decode, source)
				if decoded and type(settings) == "table" then
					local values = settings.settings or {}
					state.endpoint = tostring(values.apiUrl or "")
					state.bank = tostring(values.bankId or "")
					state.include = csv(strings(values.includeFolders))
					state.exclude = csv(strings(values.excludeFolders))
					state.budget = tostring(values.defaultBudget or "low")
					state.prefix = values.prefixDocId ~= false
					state.autoSync = values.syncOnEdit == true
					state.hasKey = type(values.apiKey) == "string" and values.apiKey ~= ""
					state.observationScopes = if type(values.observationScopes) == "table" then tern.json.encode(values.observationScopes) else tostring(values.observationScopes or "combined")
				end
			end
			local over: { [string]: any } = settings_read(root).hindsight or {}
			state.endpoint = tostring(over.apiUrl or state.endpoint)
			state.bank = tostring(over.bankId or state.bank)
			if over.includeFolders ~= nil then
				state.include = csv(strings(over.includeFolders))
			end
			if over.excludeFolders ~= nil then
				state.exclude = csv(strings(over.excludeFolders))
			end
			state.budget = tostring(over.defaultBudget or state.budget)
			if over.prefixDocId ~= nil then state.prefix = over.prefixDocId end
			if over.syncOnEdit ~= nil then state.autoSync = over.syncOnEdit end
			if over.apiKey ~= nil then state.hasKey = over.apiKey ~= "" end
			if over.observationScopes ~= nil then state.observationScopes = if type(over.observationScopes) == "table" then tern.json.encode(over.observationScopes) else tostring(over.observationScopes) end
			hs_status(state, cx)
		end
		return state
	end,
	title = function(_state: HsState)
		return "Hindsight"
	end,
	view = function(state: HsState, _cx: BlockCx)
		if state.root == nil then
			return {
				main = ui.col({
					ui.text({ ui.span("This block needs an Obsidian vault.", "error") }),
					ui.text({ ui.span("Run Obsidian: Edit vault filters from any pane to choose one.", "muted") }),
				}),
			}
		end
		local lead = (state.root:match("([^/]+)$") or state.root) .. "  ·  " .. (if state.bank ~= "" then state.bank else "not configured")
		if state.error then
			lead = lead .. "  ·  " .. state.error
		end
		local binding: { any } = {
			hs_field("endpoint", "API URL", "Hindsight service base URL.", state.endpoint),
			hs_field("bank", "Bank", "Bank holding this vault's documents.", state.bank),
			{ id = "apiKey", label = "API key", hint = "Set a replacement key. The inherited key stays hidden.", control = { k = "text", value = if state.hasKey then "configured" else "", secret = true } },
		}
		local scope: { any } = {
			hs_field("include", "Include folders", "Comma separated. Empty syncs the whole vault.", state.include),
			hs_field("exclude", "Exclude folders", "Comma separated folders to skip.", state.exclude),
			{ id = "prefix", label = "Prefix document IDs", hint = "Use vault-name/path to identify notes, as in Obsidian.", control = { k = "switch", on = state.prefix } },
			{ id = "autoSync", label = "Sync on edit", hint = "Watch file changes and synchronize after 4 seconds. No initial upload.", control = { k = "switch", on = state.autoSync } },
			hs_field("observationScopes", "Observation scopes", "per_tag, combined, all_combinations, shared, or a JSON array of tag arrays.", state.observationScopes),
			{
				id = "budget",
				label = "Default budget",
				hint = "Depth used by recall and reflect.",
				control = {
					k = "choice", value = state.budget, style = "segmented",
					options = {
						{ value = "low", label = "Low" },
						{ value = "mid", label = "Mid" },
						{ value = "high", label = "High" },
					},
				},
			},
		}
		local sync: { any } = {
			hs_row("tracked", "Tracked documents", "Documents this plugin retained and may delete.", if state.tracked then tostring(state.tracked) else "—"),
			hs_row("inherited", "Inherited documents", "Already in the bank from the Obsidian plugin; never deleted here.", if state.inherited then tostring(state.inherited) else "—"),
			hs_row("last", "Last sync", state.job or "No job yet.", state.lastSync or "never"),
			{ id = "sync", label = "Sync now", hint = "Submits a background job. Completion means extraction finished on the server.", control = { k = "action", act = "sync", label = "Sync" } },
			{ id = "refresh", label = "Refresh status", hint = "Read progress for the current background job.", control = { k = "action", act = "refresh", label = "Refresh" } },
		}
		return {
			main = ui.col({ ui.node("prefs", {
				title = "Obsidian",
				lead = lead,
				pages = { { id = "hindsight", label = "Hindsight", icon = "database" } },
				page = "hindsight",
				sections = {
					{ id = "binding", title = "Binding", rows = binding },
					{ id = "scope", title = "Sync scope", rows = scope },
					{ id = "sync", title = "Sync", rows = sync },
				},
				focus = state.focus,
				editing = if state.field then {
					row = state.field,
					draft = state.draft,
					cursor = units(chars(state.draft), state.cursor),
				} else nil,
			}) }),
		}
	end,
	event = function(state: HsState, event: UiEvent, cx: BlockCx)
		if event.ev == "change" then
			if event.item == "budget" and type(event.value) == "string" then
				hs_patch(state, { defaultBudget = event.value }, cx)
			elseif event.item == "prefix" and type(event.value) == "boolean" then
				hs_patch(state, { prefixDocId = event.value }, cx)
			elseif event.item == "autoSync" and type(event.value) == "boolean" then
				hs_patch(state, { syncOnEdit = event.value }, cx)
				if event.value then
					bridge.background({ op = "hindsight-watch", root = state.root }, function(_, err)
						if err then tern.log.error("Hindsight watcher", err) end
					end)
				end
			end
			return
		end
		if event.ev == "activate" then
			local id = event.item
			if id == "endpoint" then
				state.field, state.focus, state.draft = id, id, state.endpoint
			elseif id == "bank" then
				state.field, state.focus, state.draft = id, id, state.bank
			elseif id == "include" then
				state.field, state.focus, state.draft = id, id, state.include
			elseif id == "exclude" then
				state.field, state.focus, state.draft = id, id, state.exclude
			elseif id == "apiKey" then
				state.field, state.focus, state.draft = id, id, ""
			elseif id == "observationScopes" then
				state.field, state.focus, state.draft = id, id, state.observationScopes
			else
				return
			end
			state.cursor = #chars(state.draft)
			return
		end
		if event.ev ~= "action" then
			return
		end
		if event.act == "close" then
			cx:exit(0)
			return
		end
		if event.act == "sync" then
			bridge.sync(state.root :: string, {}, function(result, err)
				if not running(cx.pane) then
					return
				end
				state.error = err
				state.job = if result then result.job_id .. " · " .. tostring(result.state) else nil
				cx:render()
			end)
		elseif event.act == "refresh" then
			hs_status(state, cx)
		end
	end,
	key = function(state: HsState, key: Key, cx: BlockCx): boolean
		if state.field == nil then
			if key.name == "escape" then
				cx:exit(0)
				return true
			end
			return false
		end
		if key.name == "enter" then
			hs_commit(state, cx)
			return true
		elseif key.name == "escape" then
			state.field, state.focus = nil, nil
			return true
		elseif key.name == "backspace" then
			if state.cursor == 0 then
				return false
			end
			local parts = chars(state.draft)
			table.remove(parts, state.cursor)
			state.cursor -= 1
			state.draft = table.concat(parts)
			return true
		elseif key.name == "left" then
			if state.cursor == 0 then
				return false
			end
			state.cursor -= 1
			return true
		elseif key.name == "right" then
			if state.cursor >= #chars(state.draft) then
				return false
			end
			state.cursor += 1
			return true
		elseif key.text and key.text ~= "" and not key.ctrl and not key.meta then
			local parts = chars(state.draft)
			local typed = chars(key.text)
			for i = #typed, 1, -1 do
				table.insert(parts, state.cursor + 1, typed[i])
			end
			state.cursor += #typed
			state.draft = table.concat(parts)
			return true
		end
		return false
	end,
	save = function(state: HsState)
		return { root = state.root }
	end,
})

bridge.run({ op = "vaults" }, function(result, err)
	if err then tern.log.error("Hindsight vault discovery", err); return end
	for _, root in result.known or {} do
		bridge.background({ op = "hindsight-watch", root = root }, function(_, watch_err)
			if watch_err then tern.log.error("Hindsight watcher", watch_err) end
		end)
	end
end)
