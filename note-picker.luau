--!strict
local bridge = require("./bridge")
local matching = require("./note-match")
local ui = tern.ui

local function update(state: any)
	state.order, state.hits = matching.rank(state.search, state.query)
	state.selected = state.order[1]
end

local function close(state: any, cx: BlockCx, file: string?)
	local target = "obsidian://picker?pane=" .. tostring(cx.pane)
	if file then target ..= "&root=" .. bridge.encode(state.root) .. "&file=" .. bridge.encode(file) end
	cx:open(target)
end

return function()
	tern.block.define("note-picker", {
		init = function(cx: BlockCx, args: { string }, saved: any): any
			local state = { root = args[1], ext = args[2], query = "", cursor = 0, items = {}, search = {}, order = {}, hits = {}, loading = true }
			bridge.run({ op = "index", root = state.root }, function(result, err)
				state.loading = false
				state.error = err
				if result then
					table.sort(result.notes, function(a, b) return a.rel < b.rel end)
					for _, note in result.notes do
						if state.ext == nil or state.ext == "" or state.ext == note.ext then
							local aliases = table.concat(note.aliases or {}, " · ")
							local tags = table.concat(note.tags or {}, " #")
							local label = note.name .. (if aliases ~= "" then " · " .. aliases else "") .. (if tags ~= "" then " #" .. tags else "")
							table.insert(state.items, { id = note.rel, label = label, detail = note.rel, icon = "file" })
							table.insert(state.search, { id = note.rel, characters = matching.prepare(label) })
						end
					end
					update(state)
				end
				cx:render()
			end)
			return state
		end,
		title = function() return "Open note" end,
		view = function(state: any)
			local cursor = 0
			for _, code in utf8.codes(state.query:sub(1, state.cursor)) do cursor += if code > 0xffff then 2 else 1 end
			return { layer = ui.col({ ui.node("picker", {
				key = "notes", role = "obsidian.note-picker", size = "md", preview = "none",
				title = "Open note", subtitle = state.root, placeholder = "Search notes…", noun = "notes", icon = "file",
				query = state.query, cursor = cursor, items = state.items, order = state.order, hits = state.hits,
				selected = state.selected, total = #state.items, focus = "list",
				state = if state.loading then "loading" elseif state.error then "error" else "ready", message = state.error,
				actions = {
					{ id = "close", label = "Cancel", keys = { "esc" } },
					{ id = "open", label = "Open", keys = { "enter" }, primary = true, disabled = if state.selected == nil then true else nil },
				},
			}) }) }
		end,
		event = function(state: any, event: UiEvent, cx: BlockCx)
			state.replaceAll = false
			if event.ev == "select" then state.selected = event.item
			elseif event.ev == "activate" then close(state, cx, event.item)
			elseif event.act == "open" then close(state, cx, state.selected)
			elseif event.act == "close" then close(state, cx)
			elseif event.act == "clear" then state.query = ""; state.cursor = 0; update(state) end
		end,
		key = function(state: any, key: Key, cx: BlockCx)
			if key.name == "tab" then return false end
			if key.name == "escape" then close(state, cx); return true end
			if key.name == "enter" then
				state.replaceAll = false
				if state.selected then close(state, cx, state.selected) end
				return true
			end
			if key.name == "up" or key.name == "down" then
				state.replaceAll = false
				local index = table.find(state.order, state.selected) or 1
				state.selected = state.order[math.clamp(index + (if key.name == "up" then -1 else 1), 1, math.max(1, #state.order))]
				return true
			end
			local q, cursor = state.query, state.cursor
			if key.meta and key.name == "a" then state.replaceAll = true; return true end
			if state.replaceAll and (key.name == "paste" or key.name == "backspace" or key.name == "delete" or key.text and not key.meta and not key.ctrl and not key.alt) then
				q, cursor = "", 0
				state.query, state.cursor = q, cursor
			end
			state.replaceAll = false
			if key.name == "left" then state.cursor = if cursor > 0 then (utf8.offset(q, -1, cursor + 1) or 1) - 1 else 0; return true end
			if key.name == "right" then state.cursor = if cursor < #q then (utf8.offset(q, 2, cursor + 1) or (#q + 1)) - 1 else #q; return true end
			if key.name == "home" then state.cursor = 0; return true end
			if key.name == "end" then state.cursor = #q; return true end
			if key.name == "backspace" then
				local previous = if cursor > 0 then (utf8.offset(q, -1, cursor + 1) or 1) - 1 else 0
				state.query = q:sub(1, previous) .. q:sub(cursor + 1)
				state.cursor = previous
			elseif key.name == "delete" then
				local following = if cursor < #q then utf8.offset(q, 2, cursor + 1) or (#q + 1) else #q + 1
				state.query = q:sub(1, cursor) .. q:sub(following)
			elseif key.text and (key.name == "paste" or not key.ctrl and not key.meta and not key.alt) then
				local text = key.text:gsub("[\r\n]", " ")
				state.query = q:sub(1, cursor) .. text .. q:sub(cursor + 1)
				state.cursor = cursor + #text
			else return false end
			update(state)
			return true
		end,
	})
end
