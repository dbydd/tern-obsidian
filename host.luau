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
			state.view = hydrate(result.view)
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
