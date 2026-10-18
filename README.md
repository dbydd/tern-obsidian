# Tern Obsidian

这个插件让 Tern 识别包含 `.obsidian/` 的 Obsidian 仓库，并用原生阅读块打开笔记、Bases 和 JSON Canvas 文件。正文解析复用 remark、remark-gfm 和 remark-wiki-link。YAML 解析复用 Bun 内置的 `Bun.YAML.parse`。

## 安装

环境要求：Tern 0.9.4 或兼容 SDK 版本、提供 `Bun.YAML` 的 Bun 版本。本机验证使用 Bun 1.4.2。

```sh
cd tern-obsidian
bun install --frozen-lockfile
tern plugin link "$PWD"
tern plugin list
```

列表中应出现 `obsidian … ready`。Tern 会监视插件目录，修改 Luau 文件后自动重载。

## 使用

在仓库目录下打开 Tern，或从 Files 打开仓库内的 `.md`、`.base`、`.canvas` 文件。

| 入口 | 行为 |
| --- | --- |
| Open file… | 在当前仓库中搜索文件名、别名和标签，选择后打开笔记。末尾的 Open another file… 返回 Tern 原生选择器。 |
| Obsidian: Open note | 打开仓库文件选择器。当前块不属于仓库时，可以输入仓库绝对路径。 |
| Obsidian: Open base | 选择并显示 `.base` 文件。 |
| Obsidian: Refresh vault index | 重建当前仓库索引。 |
| Obsidian: Save Tern canvas as note | 选择 Tern UI canvas，将文字、Markdown、表格和代码保存到仓库 `Tern Notes/`。同名文件自动加数字后缀。 |
| Obsidian: Save whiteboard as note | 将当前白板的文字和连接保存为 Markdown 笔记。 |
| Obsidian: Import canvas as whiteboard | 将 JSON Canvas 节点和连接导入 Tern 白板。 |

阅读块底部的 **Edit source** 打开原始文件，**Refresh** 重新读取笔记。键盘 `e`、`r` 对应这两个操作。源码编辑后的刷新会读取新内容。`tern open` 的 CLI 打开保留 Tern 原生文件编辑行为，适合 `EDITOR='tern open --wait'`。

## 格式支持

- 链接：`[[Note]]`、`[[folder/Note]]`、`[[Note|显示名]]`、别名、相对 Markdown 链接、标题引用、`#^block` 引用。
- 嵌入：Markdown 笔记、标题范围、段落块、图片。循环笔记嵌入显示提示。附件提供文件链接。
- 属性：读取 YAML frontmatter，显示文本、数字、布尔值、列表和对象。属性内的 wikilink 参与反向链接索引。
- 标签：frontmatter `tags` 和正文 `#tag`，支持中文和嵌套标签。代码、转义文本、wikilink 内部和纯数字标签不参与标签索引。点击标签显示相关笔记。
- 索引：显示目录、出链和反向链接。异步扫描在独立 Bun 进程执行，缓存以文件大小、修改时间和状态变化时间判断更新。删除文件会在下一次扫描时移出索引。
- Bases：表格视图、全局和视图筛选、`and/or/not`、比较与算术表达式、常用文件/字符串/列表函数、公式、列顺序、列名、排序、分组和数量限制。每个表格最多显示 200 行，并显示总数。内嵌 `base` 代码块也可渲染。
- Canvas：JSON Canvas 的文字、文件、链接、分组及连接以原生卡片显示。白板导入保留位置和连接，文件节点显示文件名。

## 边界

阅读块提供预览，原始文件由 Tern 文件编辑器编辑。标题和块引用跳转到原始文件的对应行。重名链接无法唯一确定目标时，阅读块显示歧义提示。

Bases 目前提供读取视图。汇总、完整 Obsidian 公式函数集、第三方视图和 Dataview 查询不在实现中。不支持的表达式会在对应视图显示错误。JSON Canvas 卡片阅读不提供空间编辑，白板导入不保留全部视觉样式。白板转 Markdown 保留文字与连接，不保留图形几何。

窗口命令和文件选择增强用于本地仓库。远程文件打开沿用 Tern 的原生处理。OneDrive 等云盘尚未下载的文件可能读取失败，阅读块会显示具体错误。非法 YAML 属性不会被自动改写。

## 验证

实现通过本机 SDK 的 `luau-lsp analyze`。实际 Tern 窗口验证覆盖：包含数千篇笔记的真实仓库、`.base` 多维表格、Open file 搜索选择、wikilink 点击跳转、标题/块引用解析、属性和标签显示，以及 Tern canvas 导出后读取 Markdown 内容。

## 参考

- [Tern Plugin SDK](https://docs.stencil.so/tern/)
- [Obsidian 官方帮助源码](https://github.com/obsidianmd/obsidian-help)
- [Bases 语法](https://obsidian.md/help/bases/syntax)
- [JSON Canvas 1.0](https://jsoncanvas.org/spec/1.0/)
- [remark-wiki-link](https://github.com/landakram/remark-wiki-link)
