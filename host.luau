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
