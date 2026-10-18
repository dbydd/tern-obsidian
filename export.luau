--!nonstrict
-- export.luau: serialize a Tern CanvasInfo view (native UI nodes) into
-- Obsidian Markdown. Pure except tern.json.encode used for JSON escaping
-- in the unsupported-node fallback.
--
-- Node/shapes follow https://docs.stencil.so/tern/reference/ui.md:
-- {k, p?, c?} with Spans props; CanvasInfo = {title, about, view, dock?}.

local M = {}

local function is_span(v: any): boolean
	return type(v) == "table" and type(v.t) == "string"
end

-- Renders one Span or plain string as inline Markdown text.
local function render_span(v: any): string
	if type(v) == "string" then
		return v
	end
	if not is_span(v) then
		return ""
	end
	local t = v.t
	if v.href ~= nil and v.href ~= "" then
		return "[" .. t .. "](" .. v.href .. ")"
	end
	return t
end

-- Renders a Spans value (string, one span, or a list of either).
local function render_spans(spans: any): string
	if spans == nil then
		return ""
	end
	local t = type(spans)
	if t == "string" then
		return spans
	end
	if t ~= "table" then
		return ""
	end
	if is_span(spans) then
		return render_span(spans)
	end
	local out = {}
	for i, v in spans do
		out[i] = render_span(v)
	end
	return table.concat(out)
end

local function esc_cell(s: string): string
	-- Pipe tables: escape pipes; newlines become <br> to stay one row.
	local out = string.gsub(s, "|", "\\|")
	out = string.gsub(out, "\r\n", "<br>")
	return (string.gsub(out, "\n", "<br>"))
end

-- Collects the props.text of text kinds (md/code/diff/ansi/math/input/…)
-- that must be copied exactly.
local function prop_text(p: any): string
	if type(p) == "table" and type(p.text) == "string" then
		return p.text
	end
	return ""
end

-- A fence longer than any line of `body` and any run of backticks in it.
local function fence_for(body: string, base: string): string
	local run = 0
	local maxrun = 0
	for i = 1, #body do
		if string.sub(body, i, i) == "`" then
			run += 1
			if run > maxrun then maxrun = run end
		else
			run = 0
		end
	end
	local min = maxrun + 1
	if min < #base then min = #base end
	return string.rep("`", min)
end

local function escape_json(s: string): string
	local ok, enc = pcall(function()
		return tern.json.encode(s)
	end)
	if ok and type(enc) == "string" then
		return enc
	end
	-- Only reachable if tern.json is absent; keep data intact with a
	-- minimal escape rather than dropping the node.
	return '"' .. (string.gsub(string.gsub(s, "\\", "\\\\"), '"', '\\"')) .. '"'
end

-- Renders a heading level without colliding with the document title (#).
local function head_prefix(level: number): string
	return string.rep("#", level + 1) .. " "
end

-- Serializes one node as `lines` Markdown lines. Nesting depth only
-- affects heading levels and list indentation.
local function render_node(node: any, depth: number, lines: { string })
	if type(node) ~= "table" or type(node.k) ~= "string" then
		-- Not a node we can interpret; preserve it rather than drop it.
		local ok, enc = pcall(function()
			return tern.json.encode(node)
		end)
		table.insert(lines, "```tern-json" .. (ok and enc or escape_json(tostring(node))) .. "\n```")
		return
	end
	local k = node.k :: string
	local p = node.p
	local c = node.c

	if k == "md" or k == "ansi" then
		table.insert(lines, prop_text(p))
	elseif k == "code" or k == "diff" then
		local body = prop_text(p)
		local fence = fence_for(body, "```")
		local lang = ""
		if type(p) == "table" and type(p.lang) == "string" then
			lang = p.lang
		end
		table.insert(lines, fence .. lang .. "\n" .. body .. "\n" .. fence)
	elseif k == "text" then
		local spans = if type(p) == "table" then p.spans else nil
		table.insert(lines, if spans == nil then prop_text(p) else render_spans(spans))
	elseif k == "col" or k == "row" or k == "lines" then
		for _, ch in c or {} do
			render_node(ch, depth, lines)
		end
	elseif k == "card" or k == "section" then
		local head = if type(p) == "table" then p.head else nil
		table.insert(lines, head_prefix(depth) .. render_spans(head))
		for _, ch in c or {} do
			render_node(ch, depth + 1, lines)
		end
	elseif k == "rule" then
		local label = if type(p) == "table" then p.label else nil
		if label ~= nil and render_spans(label) ~= "" then
			table.insert(lines, "--- " .. render_spans(label))
		else
			table.insert(lines, "---")
		end
	elseif k == "badge" then
		table.insert(lines, "`" .. render_spans(if type(p) == "table" then p.text else nil) .. "`")
	elseif k == "kv" then
		local items = if type(p) == "table" then p.items else nil
		for _, item in items or {} do
			if type(item) == "table" then
				table.insert(lines, "- " .. render_spans(item.k) .. ": " .. render_spans(item.v))
			end
		end
	elseif k == "meter" or k == "progress" then
		if type(p) == "table" then
			local label = render_spans(p.label)
			local value = type(p.value) == "number" and math.floor(p.value * 100 + 0.5) or nil
			local text = if label ~= "" then label else k
			if value then
				table.insert(lines, text .. ": " .. value .. "%")
			else
				table.insert(lines, text .. ": —")
			end
		end
	elseif k == "test_summary" then
		if type(p) == "table" then
			table.insert(lines, string.format(
				"test summary: %s passed · %s failed · %s skipped",
				tostring(p.passed), tostring(p.failed), tostring(p.skipped)))
		end
	elseif k == "overflow" then
		if type(p) == "table" then
			table.insert(lines, string.format("… %s more", tostring(p.hidden)))
		end
	elseif k == "table" then
		local cols = if type(p) == "table" then p.cols else nil
		local rows = if type(p) == "table" then p.rows else nil
		cols = cols or {}
		local function cell_text(cell: any): string
			if cell == nil then
				return ""
			end
			if type(cell) == "table" and type(cell.meter) == "table" then
				-- Meter cell: keep the value; parts/thresholds are visual only.
				local m = cell.meter
				if type(m.value) == "number" then
					return tostring(math.floor(m.value * 100 + 0.5) .. "%")
				end
				return ""
			end
			local s = render_spans(cell)
			if s == "" and type(cell) == "table" and type(cell.t) ~= "string" then
				return ""
			end
			return esc_cell(s)
		end
		local head = {}
		for i, col in cols do
			head[i] = esc_cell(type(col) == "table" and tostring(col.head) or tostring(col))
		end
		table.insert(lines, "| " .. table.concat(head, " | ") .. " |")
		local sep = {}
		for i = 1, #head do
			sep[i] = "---"
		end
		table.insert(lines, "| " .. table.concat(sep, " | ") .. " |")
		for _, row in rows or {} do
			local cells: { string } = {}
			-- Rows carry cells keyed by column id; fall back to positional lists.
			local source = if type(row) == "table" and type(row.cells) == "table" then row.cells else row
			for i, col in cols do
				local id = if type(col) == "table" and col.id ~= nil then tostring(col.id) else tostring(i - 1)
				cells[i] = cell_text(source[id])
				if cells[i] == "" and source[id] == nil then
					cells[i] = cell_text(source[i])
				end
			end
			table.insert(lines, "| " .. table.concat(cells, " | ") .. " |")
		end
	elseif k == "tree" then
		local nodes = if type(p) == "table" then p.nodes else nil
		local function walk(list: any, level: number)
			for _, tn in list or {} do
				if type(tn) == "table" then
					table.insert(lines, string.rep("  ", level) .. "- " .. render_spans(tn.label))
					walk(tn.children, level + 1)
				end
			end
		end
		walk(nodes, depth)
	elseif k == "list" then
		for _, item in c or {} do
			if type(item) == "table" and type(item.p) == "table" then
				local ip = item.p
				local line = "- " .. render_spans(ip.label)
				local detail = render_spans(ip.detail)
				if detail ~= "" then
					line ..= " — " .. detail
				end
				local value = render_spans(ip.value)
				if value ~= "" then
					line ..= ": " .. value
				end
				table.insert(lines, line)
			end
		end
	elseif k == "chart" then
		local series = if type(p) == "table" then p.series else nil
		local kind = if type(p) == "table" then p.kind else nil
		for _, pt in series or {} do
			if type(pt) == "table" then
				table.insert(lines, string.format("- %s: %s",
					tostring(pt.label), tostring(pt.value)))
			end
		end
		if series == nil then
			table.insert(lines, string.format("(chart %s: series not convertible)", tostring(kind)))
		end
	elseif k == "diagnostic" then
		if type(p) == "table" then
			local d = p
			local loc = ""
			if type(d.path) == "string" then
				loc = d.path
				if type(d.line) == "number" then
					loc ..= ":" .. tostring(d.line)
					if type(d.col) == "number" then
						loc ..= ":" .. tostring(d.col)
					end
				end
			end
			table.insert(lines, "> [!WARNING] " .. (type(d.code) == "string" and d.code or "diagnostic")
				.. "\n> " .. (type(d.message) == "string" and d.message or "")
				.. (loc ~= "" and ("\n> at `" .. loc .. "`") or ""))
		end
	else
		-- Unsupported visual node: preserve the full data, visibly.
		local ok, enc = pcall(function()
			return tern.json.encode(node)
		end)
		if ok then
			table.insert(lines, "[unsupported canvas node: " .. k .. "]"
				.. "\n```tern-json\n" .. enc .. "\n```")
		else
			table.insert(lines, string.format("> unsupported canvas node: %s", k))
		end
	end
end

-- Serializes the whole CanvasInfo into a Markdown document.
function M.markdown(info: any): string
	local lines: { string } = {}

	local title = "Canvas"
	if type(info) == "table" and type(info.title) == "string" and info.title ~= "" then
		title = info.title
	end

	table.insert(lines, "---")
	table.insert(lines, "tags:")
	table.insert(lines, "  - tern/canvas")
	table.insert(lines, "title: " .. tern.json.encode(title))
	table.insert(lines, "source: tern")
	table.insert(lines, "---")
	table.insert(lines, "")
	table.insert(lines, "# " .. title)
	table.insert(lines, "")

	if type(info) == "table" and type(info.about) == "string" and info.about ~= "" then
		table.insert(lines, info.about)
		table.insert(lines, "")
	end

	local view = if type(info) == "table" then info.view else nil
	render_node(view, 1, lines)

	return table.concat(lines, "\n") .. "\n"
end

return M
