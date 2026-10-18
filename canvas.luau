--!strict
-- canvas.luau: conversion between Obsidian .canvas (JSON Canvas 1.0,
-- jsoncanvas.org) and Tern whiteboard shapes.
--
-- Pure data functions: JSON in/out as decoded/encoded tables, whiteboard
-- shapes as tern.d.luau's WhiteboardEdit/WhiteboardShape shapes.

local canvas = {}

-- JSON Canvas preset colors "1"-"6" and their whiteboard palette names.
local PRESET: { [string]: string } = {
	["1"] = "red", ["2"] = "orange", ["3"] = "yellow",
	["4"] = "green", ["5"] = "cyan", ["6"] = "purple",
}
local REVERSE: { [string]: string } = {
	red = "1", orange = "2", yellow = "3",
	green = "4", cyan = "5", purple = "6",
}

-- Node color: presets map to palette names, #rrggbb passes through, others drop.
local function node_color(color: string?): string?
	if color == nil then return nil end
	return if string.sub(color, 1, 1) == "#" then color else PRESET[color]
end

-- Whiteboard palette name back to a JSON Canvas preset, if it is one.
local function preset_of(color: string?): string?
	if color == nil then return nil end
	return REVERSE[color]
end

-- The last path segment of a vault path.
local function basename(path: string): string
	return (string.gsub(path, "^.*/", ""))
end

-- A canvas text-like node for `shape`, carrying color through.
local function text_node(shape: any): CanvasNode
	return {
		id = shape.id,
		type = "text",
		x = shape.x, y = shape.y,
		width = shape.w, height = shape.h,
		text = shape.text or "",
		color = preset_of(shape.color),
	}
end

-- A JSON Canvas node as decoded from a .canvas file.
export type CanvasNode = {
	id: string,
	type: string, -- text | file | link | group
	x: number, y: number,
	width: number, height: number,
	color: string?,
	text: string?,
	file: string?,
	subpath: string?,
	url: string?,
	label: string?,
}
export type CanvasEdge = {
	id: string,
	fromNode: string, toNode: string,
	fromSide: string?, toSide: string?,
	fromEnd: string?, toEnd: string?,
	color: string?,
	label: string?,
}

-- Adds (whiteboard edits, per-shape refs) that recreate `nodes`/`edges`
-- on a Tern whiteboard. Text nodes become text shapes; file nodes show
-- "name ↗" text with the vault path noted; link nodes show the URL;
-- groups become labelled rects; edges become arrows between refs.
-- Returns the edit list and the node-id -> ref map used for arrows.
function canvas.to_whiteboard(nodes: { CanvasNode }, edges: { CanvasEdge }): ({ { any } }, { [string]: string })
	local edits: { { any } } = {}
	local refs: { [string]: string } = {}

	for i, node in nodes do
		local ref = "n" .. i
		if node.id ~= nil then
			refs[node.id] = ref
		end
		local color = node_color(node.color)
		if node.type == "group" then
			table.insert(edits, {
				op = "add", type = "rect", ref = ref,
				x = node.x, y = node.y, w = node.width, h = node.height,
				fill = "none",
			})
			if node.label ~= nil and node.label ~= "" then
				table.insert(edits, {
					op = "add", type = "text", ref = ref .. "label",
					x = node.x, y = node.y, w = node.width,
					text = node.label, color = "gray",
				})
			end
		else
			local text = if node.type == "text" then node.text
				elseif node.type == "file" then basename(node.file or "") .. (node.subpath or "")
				elseif node.type == "link" then node.url
				else nil
			table.insert(edits, {
				op = "add", type = "rect", ref = ref,
				x = node.x, y = node.y, w = node.width, h = node.height,
				text = text, color = color,
			})
		end
	end

	for _, edge in edges do
		local from = refs[edge.fromNode]
		local to = refs[edge.toNode]
		if from == nil or to == nil then
			continue
		end
		table.insert(edits, {
			op = "add", type = "arrow",
			from_shape = from, to_shape = to,
			text = edge.label,
			color = node_color(edge.color),
			start_head = if edge.fromEnd == "arrow" then "arrow" elseif edge.fromEnd == "none" then "none" else nil,
			end_head = if edge.toEnd == "arrow" then "arrow" elseif edge.toEnd == "none" then "none" else nil,
		})
	end

	return edits, refs
end

-- Converts whiteboard shapes (as cx.whiteboard:read returns) back into
-- JSON Canvas nodes/edges tables, ready for tern.json.encode.
function canvas.from_whiteboard(shapes: { any }): ({ CanvasNode }, { CanvasEdge })
	local nodes: { CanvasNode } = {}
	local edges: { CanvasEdge } = {}

	for _, shape in shapes do
		if shape.type == "arrow" then
			if shape.from_shape ~= nil and shape.to_shape ~= nil then
				table.insert(edges, {
					id = shape.id,
					type = "edge",
					fromNode = shape.from_shape,
					toNode = shape.to_shape,
					fromEnd = if shape.start_head == "arrow" then "arrow" else "none",
					toEnd = if shape.end_head == "arrow" then "arrow" else "none",
					label = shape.text,
					color = preset_of(shape.color),
				})
			end
		elseif shape.type == "line" and shape.from_shape ~= nil and shape.to_shape ~= nil then
			table.insert(edges, {
				id = shape.id,
				type = "edge",
				fromNode = shape.from_shape,
				toNode = shape.to_shape,
				fromEnd = if shape.start_head == "arrow" then "arrow" else "none",
				toEnd = if shape.end_head == "arrow" then "arrow" else "none",
				label = shape.text,
				color = preset_of(shape.color),
			})
		elseif shape.type == "text" then
			table.insert(nodes, text_node(shape))
		elseif shape.type == "rect" or shape.type == "ellipse"
			or shape.type == "diamond" or shape.type == "triangle" then
			table.insert(nodes, text_node(shape))
		else
			-- image, ink, highlight, curve, polygon and free lines only get a
			-- placeholder text node; canvas has no counterpart for them.
			local node = text_node(shape)
			if node.text == "" then
				node.text = shape.type
			end
			table.insert(nodes, node)
		end
	end

	return nodes, edges
end

return canvas
