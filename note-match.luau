--!strict
local M = {}

local function characters(text: string): { any }
	local out = {}
	local offset = 0
	for _, code in utf8.codes(text) do
		local value = utf8.char(code)
		local width = if code > 0xffff then 2 else 1
		table.insert(out, { value = string.lower(value), from = offset, to = offset + width })
		offset += width
	end
	return out
end

function M.prepare(text: string): { any }
	return characters(text)
end

function M.match(label: { any }, query: { any }): any
	local n, m = #label, #query
	if m == 0 then return { length = 0, hits = {} } end
	local prefix, suffix = { [0] = 0 }, { [m + 1] = n + 1 }
	local at = 1
	for i = 1, m do
		while at <= n and label[at].value ~= query[i].value do at += 1 end
		if at > n then return nil end
		prefix[i] = at
		at += 1
	end
	at = n
	for i = m, 1, -1 do
		while label[at].value ~= query[i].value do at -= 1 end
		suffix[i] = at
		at -= 1
	end
	local longest, queryStart, labelStart = 0, 1, 1
	for q = 1, m do
		for l = prefix[q - 1] + 1, suffix[q] do
			local length = 0
			while q + length <= m and l + length <= n and label[l + length].value == query[q + length].value do
				length += 1
				if length > longest and l + length - 1 < suffix[q + length] then
					longest, queryStart, labelStart = length, q, l
				end
			end
		end
	end
	local positions = {}
	at = 1
	for q = 1, queryStart - 1 do
		while label[at].value ~= query[q].value do at += 1 end
		table.insert(positions, at)
		at += 1
	end
	for l = labelStart, labelStart + longest - 1 do table.insert(positions, l) end
	at = labelStart + longest
	for q = queryStart + longest, m do
		while label[at].value ~= query[q].value do at += 1 end
		table.insert(positions, at)
		at += 1
	end
	local hits = {}
	for _, position in positions do
		local char = label[position]
		local last = hits[#hits]
		if last and last[2] == char.from then last[2] = char.to
		else table.insert(hits, { char.from, char.to }) end
	end
	return { length = longest, hits = hits }
end

function M.rank(items: { any }, text: string): ({ string }, { [string]: any })
	local query = characters(text:match("^%s*(.-)%s*$") or "")
	local matches, hits = {}, {}
	for index, item in items do
		local match = M.match(item.characters, query)
		if match then
			table.insert(matches, { id = item.id, length = match.length, index = index })
			hits[item.id] = match.hits
		end
	end
	table.sort(matches, function(a, b)
		return if a.length == b.length then a.index < b.index else a.length > b.length
	end)
	local order = {}
	for _, match in matches do table.insert(order, match.id) end
	return order, hits
end

return M
