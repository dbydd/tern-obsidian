--!strict
local bridge = require("./bridge")
local exporter = require("./export")
local canvasmod = require("./canvas")
local carly = require("./carly")

local roots: { [number]: string } = {}

local function focused(cx: WindowCx): PaneInfo?
	local id = cx.session:focused()
	return if id then cx.session:pane(id) else nil
end

-- The vault a pane's cwd sits in, else the last vault this machine opened.
-- A focused agent or file pane has a cwd outside any vault, and refusing to
-- open the panel there would be surprising.
local function remembered(): string?
	local root = tern.kv.get("last-vault")
	if type(root) == "string" and root ~= "" and tern.fs.exists(root .. "/.obsidian") then
		return root
	end
	return nil
end

local function root_of(cx: WindowCx): string?
	if cx.hosts:current().kind ~= "local" then
		return nil
	end
	local pane = focused(cx)
	local root = if pane then roots[pane.pane] or bridge.find(pane.cwd or "") else nil
	return root or remembered()
end

carly.register(root_of)
carly.register_hindsight(root_of)

local function failure(cx: WindowCx?, err: string?)
	if cx and err then
		cx:toast("error", "Obsidian", err)
	end
end

local function open_note(cx: WindowCx, root: string, rel: string, anchor: string?)
	tern.kv.set("last-vault", root)
	local path = root .. "/" .. rel
	if rel:lower():match("%.md$") or rel:lower():match("%.base$") or rel:lower():match("%.canvas$") then
		local pane = cx:new_block("obsidian.note", { path, anchor or "" })
		if pane then
			roots[pane] = root
		end
	else
		cx:open(path)
	end
end

local function pick_note(cx: WindowCx, root: string, ext: string?)
	cx:new_block("obsidian.note-picker", { root, ext or "" }, "over")
end

tern.override("open_file", function(cx)
	local root = root_of(cx)
	if root == nil then
		return false
	end
	pick_note(cx, root)
	return true
end)

tern.command({
	id = "open_note", title = "Obsidian: Open note", icon = "file",
	run = function(cx)
		local root = root_of(cx)
		if root then
			pick_note(cx, root)
		else
			cx:prompt({ placeholder = "Obsidian vault folder (absolute path)" }):next(function(value, err, next_cx)
				if value and next_cx then
					pick_note(next_cx, value)
				else
					failure(next_cx, err)
				end
			end)
		end
	end,
})
tern.command({
	id = "open_base", title = "Obsidian: Open base", icon = "table",
	run = function(cx)
		local root = root_of(cx)
		if root then pick_note(cx, root, "base") else cx:toast("error", "No Obsidian vault for this pane") end
	end,
})
tern.command({
	id = "refresh_index", title = "Obsidian: Refresh vault index", icon = "folder",
	run = function(cx)
		local root = root_of(cx)
		if root == nil then
			cx:toast("error", "No Obsidian vault for this pane")
			return
		end
		bridge.run({ op = "index", root = root, refresh = true }, function(result, err, next_cx)
			if result and next_cx then
				next_cx:toast("success", "Vault indexed", tostring(result.count) .. " files · " .. tostring(#result.warnings) .. " metadata errors")
			else failure(next_cx, err) end
		end)
	end,
})

local function open_panel(cx: WindowCx, kind: string, root: string)
	tern.kv.set("last-vault", root)
	local over = cx.session:focused()
	local pane: number?
	for _, info in cx.session:panes() do
		if info.block == kind then
			pane = info.pane
			break
		end
	end
	if pane == nil then
		pane = cx:new_block(kind, { root }, "beside")
	end
	-- An explicit owner needs a split sibling; without one the float takes the
	-- block that absorbed the new pane's space, which is the pane here.
	if pane and pane ~= over then
		cx.layout:float(pane, nil, "br")
	end
	if pane then
		cx.layout:focus(pane)
	end
end

local function open_filters(cx: WindowCx, root: string)
	open_panel(cx, "obsidian.filters", root)
end

-- Focused pane, then the remembered vault, then Obsidian's own vault list.
local function pick_vault(cx: WindowCx, done: (WindowCx, string) -> ())
	bridge.run({ op = "vaults" }, function(result, err, next_cx)
		if next_cx == nil then
			return
		end
		if result == nil then
			failure(next_cx, err)
			return
		end
		local known: { string } = result.known or {}
		if #known == 0 then
			next_cx:toast("error", "Obsidian", "No Obsidian vault found on this machine")
			return
		end
		if #known == 1 then
			done(next_cx, known[1])
			return
		end
		local items: { PickItem } = {}
		for _, path in known do
			table.insert(items, { label = path:match("([^/]+)$") or path, detail = path, value = path })
		end
		next_cx:pick({ items = items, placeholder = "Obsidian vault" }):next(function(item, pick_err, pick_cx)
			if item and pick_cx then
				done(pick_cx, item.value :: string)
			else
				failure(pick_cx, pick_err)
			end
		end)
	end)
end

tern.command({
	id = "filters", title = "Obsidian: Edit vault filters", icon = "funnel",
	run = function(cx)
		local root = root_of(cx)
		if root then
			open_filters(cx, root)
		else
			pick_vault(cx, open_filters)
		end
	end,
})

tern.command({
	id = "hindsight", title = "Obsidian: Hindsight settings", icon = "database",
	run = function(cx)
		local root = root_of(cx)
		if root then
			open_panel(cx, "obsidian.hindsight", root)
		else
			pick_vault(cx, function(next_cx, at)
				open_panel(next_cx, "obsidian.hindsight", at)
			end)
		end
	end,
})

tern.route.open(function(req, cx)
	for _, host in cx.hosts:list() do
		if host.name == req.host and host.kind ~= "local" then return nil end
	end
	local extension = req.path:lower():match("%.([^./]+)$")
	if extension ~= "md" and extension ~= "base" and extension ~= "canvas" then return nil end
	-- CLI opens must remain usable by EDITOR and --wait.
	if req.origin == "cli" or req.line then return nil end
	local root = bridge.find(req.path)
	if root == nil then return nil end
	-- The block decision keeps `tern open`/`file open` waiting on the new
	-- block; the root is registered once the block exists.
	tern.timer(800, function(next_cx)
		if next_cx == nil then return end
		for _, pane in next_cx.session:panes() do
			if pane.block == "obsidian.note" and pane.path == req.path then
				roots[pane.pane] = root
				return
			end
		end
	end)
	return { block = "obsidian.note", args = { req.path } }
end)

tern.route.link(function(link, cx)
	if link.url:match("^obsidian://picker%?") then
		local query = bridge.query(link.url)
		local id = tonumber(query.pane)
		local pane = if id then cx.session:pane(id) else nil
		if pane and pane.block == "obsidian.note-picker" then
			cx.layout:close(id :: number)
			if query.root and query.file then open_note(cx, query.root, query.file) end
		end
		return { handled = true }
	end
	if link.url:match("^obsidian://source%?") then
		local query = bridge.query(link.url)
		if query.path then cx.docs:open(query.path) end
		return { handled = true }
	end
	if not link.url:match("^obsidian://") then return nil end
	local query = bridge.query(link.url)
	local root = if query.root and query.root ~= "" then query.root elseif query.vault then nil else root_of(cx)
	if query.tag and root then
		bridge.run({ op = "tag", root = root, tag = query.tag }, function(result, err, next_cx)
			if result and next_cx then
				local pane, open_err = next_cx.canvas:open({ title = result.title, view = result.view })
				if pane then roots[pane] = result.root else failure(next_cx, open_err) end
			else failure(next_cx, err) end
		end)
		return { handled = true }
	end
	if query.file == nil then return nil end
	local pane = focused(cx)
	bridge.run({ op = "resolve", root = root, cwd = if pane then pane.cwd else nil, vault = query.vault, target = query.file .. (if query.anchor then "#" .. query.anchor else "") }, function(result, err, next_cx)
		if result and next_cx then
			if result.anchor and result.anchor ~= "" then
				next_cx.docs:open(result.path, { line = result.line })
			else
				open_note(next_cx, result.root, result.rel)
			end
		else failure(next_cx, err) end
	end)
	return { handled = true }
end)

local function save_canvas(cx: WindowCx, pane: number, root: string)
	local info = cx.canvas:get(pane)
	if info == nil then
		cx:toast("error", "Canvas is no longer open")
		return
	end
	local markdown = exporter.markdown(info)
	bridge.run({ op = "save", root = root, title = info.title, markdown = markdown }, function(result, err, next_cx)
		if result and next_cx then
			next_cx:toast("success", "Canvas saved as Obsidian note", result.path)
		else failure(next_cx, err) end
	end)
end

tern.command({
	id = "save_whiteboard", title = "Obsidian: Save whiteboard as note", icon = "file",
	run = function(cx)
		local state = cx.whiteboard:read(nil, { max_shapes = 2000 })
		if state.more > 0 then
			cx:toast("error", "Whiteboard exceeds export limit", "Select a board with at most 2000 shapes")
			return
		end
		local children: { Node } = {}
		for _, shape in state.shapes do
			if shape.text and shape.text ~= "" then
				table.insert(children, tern.ui.md(shape.text))
			elseif shape.type == "arrow" or shape.type == "line" then
				table.insert(children, tern.ui.text((shape.from_shape or "point") .. " → " .. (shape.to_shape or "point")))
			end
		end
		local markdown = exporter.markdown({ title = "Tern Whiteboard", view = tern.ui.col(children) })
		local function save(root: string)
			bridge.run({ op = "save", root = root, title = "Tern Whiteboard", markdown = markdown }, function(result, err, next_cx)
				if result and next_cx then next_cx:toast("success", "Whiteboard saved as note", result.path) else failure(next_cx, err) end
			end)
		end
		local root = root_of(cx)
		if root then save(root) else
			cx:prompt({ placeholder = "Destination Obsidian vault folder" }):next(function(value, err, next_cx)
				if value then save(value) else failure(next_cx, err) end
			end)
		end
	end,
})

tern.command({
	id = "save_canvas", title = "Obsidian: Save Tern canvas as note", icon = "file",
	run = function(cx)
		local pane = cx.session:focused()
		local canvases = cx.canvas:list()
		local choices: { PickItem } = {}
		for _, info in canvases do table.insert(choices, { label = info.title, pane = info.pane, current = pane == info.pane }) end
		if #choices == 0 then
			cx:toast("error", "No Tern canvas panels are open")
			return
		end
		cx:pick({ items = choices, placeholder = "Canvas to save" }):next(function(item, err, pick_cx)
			if item == nil or pick_cx == nil then
				failure(pick_cx, err)
				return
			end
			local root = root_of(pick_cx)
			if root then save_canvas(pick_cx, item.pane :: number, root) else
				pick_cx:prompt({ placeholder = "Destination Obsidian vault folder" }):next(function(value, prompt_err, prompt_cx)
					if value and prompt_cx then save_canvas(prompt_cx, item.pane :: number, value) else failure(prompt_cx, prompt_err) end
				end)
			end
		end)
	end,
})

tern.command({
	id = "import_whiteboard", title = "Obsidian: Import canvas as whiteboard", icon = "layout",
	run = function(cx)
		cx:prompt({ placeholder = "Absolute path to .canvas file" }):next(function(value, err, next_cx)
			if value == nil or next_cx == nil then
				failure(next_cx, err)
				return
			end
			local ok, doc = pcall(function() return tern.json.decode(tern.fs.read(value, 4 * 1024 * 1024)) end)
			if not ok then
				next_cx:toast("error", "Invalid JSON Canvas", tostring(doc))
				return
			end
			local edits = canvasmod.to_whiteboard(doc.nodes or {}, doc.edges or {})
			next_cx.whiteboard:open():next(function(id, open_err, board_cx)
				if id and board_cx then board_cx.whiteboard:edit(id, edits :: any) else failure(board_cx, open_err) end
			end)
		end)
	end,
})
