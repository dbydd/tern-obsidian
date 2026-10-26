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
| Obsidian: Edit vault filters | 按仓库编辑 allow/deny 索引筛选，面板浮在当前 pane 右下角，已打开时复用。 |
| Obsidian: Hindsight settings | 按仓库配置 Hindsight 孪生知识库的绑定、同步范围，并查看或启动同步作业。 |

阅读块底部的 **Edit source** 打开原始文件，**Refresh** 重新读取笔记。键盘 `e`、`r` 对应这两个操作。源码编辑后的刷新会读取新内容。`tern open` 的 CLI 打开保留 Tern 原生文件编辑行为，适合 `EDITOR='tern open --wait'`。

## 仓库筛选

`Obsidian: Edit vault filters` 把按仓库保存的筛选面板浮在当前 pane 的右下角；已打开时复用同一个面板，不再叠标签页。面板是 Tern 的 `prefs` 设置页，限宽 640px、内边距 14px/16px。点 `Pattern` 输入行后 Enter 加入当前目标列表；`Add to` 用 Allow/Deny 分段控件切换目标，列表每条右侧 `Remove` 删除。页头显示当前可见文件数。

| 列表 | 语义 |
| --- | --- |
| Allow | 非空时只列出匹配的文件；为空时列出全部 |
| Deny | 匹配的文件不列出；同时命中两个列表时 Deny 优先 |

模式匹配仓库相对路径。`**` 跨目录，`*` 和 `?` 只匹配一段路径。不含 `/` 的模式同时匹配文件名和目录前缀，所以 `raw` 覆盖 `raw/…`，`*.canvas` 覆盖任意深度的 canvas。

筛选只作用于索引：文件选择器、Bases 表格、标签、出链与反向链接，以及 Carly 的 `find`、`links`、`vault`。被筛掉的文件仍能用 `read` 和文件编辑器打开，与 Obsidian 自身的 ignore 过滤一致。改动在下一次打开或 Refresh 索引时生效。

配置写在仓库内 `<vault>/.obsidian/tern-obsidian/settings.json` 的 `filters` 键，随仓库走，不进 Tern 的 kv。

## Carly 读取接口

窗口半边注册五个只读导出，Carly 在 `lua` 工具里直接调用，不必起子进程或自己跑索引。根目录默认取当前焦点 pane 所属的仓库；每个导出都可以显式传 `root`，路径来自 `vaults()`。

| 调用 | 返回 |
| --- | --- |
| `await(plugins.obsidian.vaults())` | 焦点 pane 的仓库根（没有则为 nil），以及 Obsidian 记录的全部仓库路径 |
| `await(plugins.obsidian.vault(root?))` | 仓库根、笔记数、前 20 条索引警告 |
| `await(plugins.obsidian.find(query, limit?, root?))` | 对路径、文件名、别名、标签做大小写不敏感的子串匹配；`total` 是全部命中数，`matches` 最多 50 条，`limit` 默认 20 |
| `await(plugins.obsidian.read(rel, from?, lines?, root?))` | 按行分页读正文；`rel` 可以是仓库相对路径或仓库内的绝对路径；默认 200 行，单页最多 12 KB，`next` 是下一页的起始行 |
| `await(plugins.obsidian.links(rel, root?))` | 出链与反向链接，各最多 80 条；被 ignore 过滤掉的文件 `excluded` 为 true，自身出链不解析 |

`tern.carly.context` 同时登记一条提示，让 Carly 看到当前 pane 属于哪个仓库。五个导出只读：改文件由 Carly 自己的文件工具完成，或交给专门管仓库的 agent。

## Hindsight 孪生知识库

`Obsidian: Hindsight settings` 打开与筛选面板同样式的设置页：绑定（API URL、bank、key）、同步范围（include/exclude、文档 ID 前缀、编辑后自动同步、observation scopes）、同步状态（tracked/inherited 文档数、最近作业、手动 Sync）。

配置与状态全部绑定仓库，不写 Tern 的 kv：

| 路径 | 内容 |
| --- | --- |
| `<vault>/.obsidian/plugins/hindsight/data.json` | Obsidian 插件自己的设置与 `syncIndex`，只读继承，Tern 从不写回 |
| `<vault>/.obsidian/tern-obsidian/settings.json` | Tern 的覆盖项（`hindsight`）与仓库筛选（`filters`） |
| `<vault>/.obsidian/tern-obsidian/hindsight/<binding>/` | 该绑定的索引、待确认 operation、作业历史；`binding` 是 `root\|endpoint\|bank\|prefix` 的短哈希 |
| `<state>/plugin-data/obsidian/hindsight/<binding>/` | 仅锁与心跳（`lock.json`、`watch.lock.json`），机器本地，不随仓库同步 |

同步只选择 Markdown，参考 include/exclude 与 Tern allow/deny 取交集。参考插件的 syncIndex 只读用于跳过已入库内容；Tern 只删除自己 retain 过的文档。作业由 Tern 进程持有，prepare 立即返回 job_id，`submitted` 是服务端受理、`ingested` 是 operation completed。失败、中断与重试都保留在作业记录里。

Carly 侧新增七个导出：`hindsight_status`、`hindsight_sync`、`hindsight_recall`、`hindsight_reflect`、`mental_model`、`knowledge`、`hindsight_config`，签名与语义见 `carly-hindsight-contract.md`。召回与反思的每条事实带引用 ID 与来源（current/stale/excluded/unresolved），聚合 observation 展开到原始 fact。

## 格式支持

- 链接：`[[Note]]`、`[[folder/Note]]`、`[[Note|显示名]]`、别名、相对 Markdown 链接、标题引用、`#^block` 引用。
- 嵌入：Markdown 笔记、标题范围、段落块、图片。图片由 host 通过 `cx:blob` 发送真实字节渲染，点击可放大。循环笔记嵌入显示提示。附件提供文件链接。
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

实现通过本机 SDK 的 `luau-lsp analyze`。实际 Tern 窗口验证覆盖：包含数千篇笔记的真实仓库、`.base` 多维表格、Open file 搜索选择、wikilink 点击跳转、标题/块引用解析、属性和标签显示、Tern canvas 导出后读取 Markdown 内容，以及筛选与 Hindsight 两个 `prefs` 面板。

Hindsight 侧：真实仓库（Alexandria，`obsidian-alexandria`）完成只读验收，`baselineInherited` 计入 3487 条继承文档，recall 与 reflect 的引用可回读原文；隔离仓库（`tern-obsidian-test`）完成增、改、删、故障 ECONNREFUSED 保留 failed、同 job_id 幂等重试、中断后台续跑，以及 `syncOnEdit=false` 时 watcher 返回 disabled。

## 更新日志

### 未发布

- Carly 读取接口：`vaults`、`vault`、`find`、`read`、`links`，全部只读，根目录可取焦点 pane 所属仓库。
- 仓库筛选：`obsidian.filters` 块用 `prefs` 设置页编辑 allow/deny glob，配置写在仓库内 `.obsidian/tern-obsidian/settings.json`。
- Hindsight 孪生知识库：`obsidian.hindsight` 设置页、后台同步作业引擎，以及 `hindsight_status`、`hindsight_sync`、`hindsight_recall`、`hindsight_reflect`、`mental_model`、`knowledge`、`hindsight_config` 七个 Carly 导出。
- 仓库根目录解析兜底：焦点 pane 不在仓库内时改用最近使用的仓库，再退回 Obsidian 的仓库列表选择器。
- 修复：空 cwd 不再被当成仓库路径向下查找；浮动面板复用已打开的 pane 而不再叠标签页。

## 参考

- [Tern Plugin SDK](https://docs.stencil.so/tern/)
- [Obsidian 官方帮助源码](https://github.com/obsidianmd/obsidian-help)
- [Bases 语法](https://obsidian.md/help/bases/syntax)
- [JSON Canvas 1.0](https://jsoncanvas.org/spec/1.0/)
- [remark-wiki-link](https://github.com/landakram/remark-wiki-link)
