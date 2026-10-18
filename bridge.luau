--!strict
local bridge = {}

local function bun_path(): string
	local home = tern.getenv("HOME") or ""
	for _, candidate in { home .. "/.bun/bin/bun", "/opt/homebrew/bin/bun", "/usr/local/bin/bun" } do
		if tern.fs.exists(candidate) then
			return candidate
		end
	end
	return "bun"
end

function bridge.run(request: any, callback: (any?, string?, WindowCx?) -> ())
	request.cache = tern.plugin.data
	tern.process.run({ bun_path(), tern.plugin.dir .. "/helper.mjs" }, {
		cwd = tern.plugin.dir,
		stdin = tern.json.encode(request),
		timeout_ms = 120000,
	}, function(result, cx)
		if result.status ~= 0 then
			callback(nil, result.stderr, cx)
			return
		end
		local ok, data = pcall(tern.json.decode, result.stdout)
		if ok then
			callback(data, nil, cx)
		else
			callback(nil, tostring(data), cx)
		end
	end)
end

function bridge.encode(value: string): string
	local encoded = value:gsub("([^%w%-%._~])", function(char)
		return string.format("%%%02X", string.byte(char))
	end)
	return encoded
end

function bridge.decode(value: string): string
	local decoded = value:gsub("+", " "):gsub("%%(%x%x)", function(hex)
		return string.char(tonumber(hex, 16) :: number)
	end)
	return decoded
end

function bridge.query(url: string): { [string]: string }
	local params: { [string]: string } = {}
	local query = url:match("%?(.*)$") or ""
	for key, value in query:gmatch("([^&=]+)=([^&]*)") do
		params[bridge.decode(key)] = bridge.decode(value or "")
	end
	return params
end

function bridge.find(dir: string): string?
	local home = tern.getenv("HOME") or ""
	if dir:sub(1, 2) == "~/" then
		dir = home .. dir:sub(2)
	end
	local at = dir:gsub("/+$", "")
	while at ~= "" do
		if tern.fs.exists(at .. "/.obsidian") then
			return at
		end
		at = at:match("^(.*)/[^/]*$") or ""
	end
	return nil
end

return bridge
