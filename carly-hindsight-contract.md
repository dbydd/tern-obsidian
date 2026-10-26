# Carly 与 tern-obsidian 的 Hindsight 接口

ready: true

通知记录：2026-10-26 22:06 插件热加载后，7 个 Hindsight 导出经 Carly `lua` 工具实测注册（`type()` 全部为 function），`hindsight_recall({limit=1},'/tmp/tern-hs-vault')` 返回 document_id `tern-hs-vault/alpha.md` state current。intercom 目标会话已断开，本文件为对 Carly 的交付通知。

Hindsight 保存 vault 的知识副本。插件不接入 Carly 会话记忆，不自动 retain 用户或助手对话。每个 vault 使用自己 `.obsidian/plugins/hindsight/data.json` 的配置（只读继承），Tern 的覆盖项写在 `<vault>/.obsidian/tern-obsidian/settings.json` 的 `hindsight` 键，同步状态写在 `<vault>/.obsidian/tern-obsidian/hindsight/<binding>/`。两者都随仓库走，不进 Tern 的 kv。endpoint 与 bank 必须显式存在，不使用 agent memory bank。

锁与心跳留在 Tern 的 plugin-data（机器本地），不参与仓库同步：sync 服务没有强一致性，远端 pid 无意义，把锁放进会同步的目录只会反复搬运临时文件。索引、待确认 operation 与作业历史仍然跟仓库走。

索引与 Obsidian 插件兼容：同样的 `sha256:` 原始字节指纹、`vault/path` 文档 ID、`update_mode: replace`、`vault:`/`folder:`/`created:`/`updated:` 合成标签。重复同步是覆盖同一文档，不产生重复记忆。Tern 永不删除继承文档。风险在于两边配置不一致（例如 observationScopes 或范围不同）时，最后写入的一方决定文档内容。

## 实际调用

| 实际调用 | 返回与行为 |
| --- | --- |
| `hindsight_status(root?, job_id?)` | 只读配置与同步状态。baselineInherited 在首次同步前计入参考 syncIndex。指定 job_id 跟踪同一作业。 |
| `hindsight_sync(opts?, root?)` | opts 为 `{force?,job_id?}`。prepare 立即返回 `{job_id,root,bank,state,launch}`，Tern 侧持有后台进程。status 不推进作业。 |
| `hindsight_recall(query, opts?, root?)` | 返回事实、引用 ID、展开的 observation source_facts、来源与 next_offset。 |
| `hindsight_reflect(question, opts?, root?)` | 返回 text、based_on、sources、structured 与 usage。 |
| `mental_model(action, opts?, root?)` | 读：list/get/query/operation。写：create/update/refresh/delete。 |
| `knowledge(action, opts?, root?)` | 读：tree/search/get/operation。写：folder/create/update/refresh/delete。 |
| `hindsight_config(patch?, root?)` | 读取隐藏 key 的配置。patch 明确修改 Tern 覆盖项；null 清除对应覆盖项。 |

配置字段为 apiUrl、apiKey、bankId、includeFolders、excludeFolders、prefixDocId、defaultBudget、syncOnEdit、observationScopes。API key 不进入结果与日志。recall 接受 types、budget、max_tokens、tags、tags_match、tag_groups、scope、folder、prefer_observations、include_chunks、include_entities、include_source_facts、min_scores、offset、limit；分页覆盖本次服务端检索集，服务端重排可能改变后续请求排序。reflect 接受 budget、max_tokens、tags、tags_match、tag_groups、scope、folder、fact_types、response_schema、exclude_mental_models、exclude_mental_model_ids、trace。mental_model query 需要 id 与 query，把该模型缓存正文交给 reflection，不隐式刷新。model 管理选项为 id、name、source_query、query、tags、tags_match、trigger、max_tokens、limit、offset、detail、operation_id、budget、scope；knowledge 管理选项为 id、name、source_query、query、tags、tags_match、tag_groups、trigger、max_tokens、parent_id、limit、scope、operation_id。refresh/create 返回 operation_id 时用 operation action 读结果。

来源结构为 `{root,rel,path,document_id,citation_id,chunk_id,state,line?}`，state 是 current、stale、excluded、unresolved。聚合 observation 自身无 document_id 时保留 unresolved，sources 列出真正的原始 fact 来源；引用 ID 原样保留。

## 同步语义

同步只选 Markdown，范围为参考 includeFolders/excludeFolders 与 Tern allow/deny 的交集，deny 优先。文档 ID 沿用 vault-name/path。参考 syncIndex 只读用于跳过已入库内容；Tern 只删除自己 retain 过的文档，继承文档永远保留 Obsidian 归属。force 只重发当前范围，不清空 bank。

作业由 Tern 进程持有：prepare 原子取锁写作业记录后放锁，runSync 以 `wx` 独占锁运行，心跳 10 秒；进程死亡后锁按 ISO 时间戳判 stale。每个 retain 的 operation UUID 在 POST 前落盘，丢失确认后重发同一 UUID，不产生重复更新。`submitted` 是服务端受理，`ingested` 只在 GET /operations/{id} 返回 completed 时计入，`tracked` 是已提交索引的文档数。轮询预算 60 秒，超时状态为 incomplete 并注明 pending 数，绝不标 done。失败作业保留 pending operation，用 `hindsight_sync({job_id},root)` 续跑同一作业。作业不跨 binding：endpoint/bank/prefix 变化后旧 job_id 不可复用。

syncOnEdit 打开后启动文件监听（4 秒防抖、跨 VM 锁、10 秒重读配置），启动监听不上传整个 vault；配置缺失或 syncOnEdit 关闭时立即返回 `{state:'disabled'}`。

## 验收证据

真实库只读（Alexandria，bank obsidian-alexandria）：status baselineInherited=3487、referenceLastSyncAt 正确；recall("causal emergence",{budget="low",max_tokens=1200,limit=2}) 展开到 papers/abstracts/emergence-causality-complex-systems-survey-abstract.md state=current；reflect 返回概述与 blogs/context/causal-emergence-community-context.md 等 6 个 current 来源；mental_model list、knowledge tree 通过。Carly 已回读原文核对，本轮 22:00 复验通过。

隔离库 /tmp/tern-hs-vault（bank tern-obsidian-test）：

| 操作 | 证据 |
| --- | --- |
| 增 alpha.md | job done，submitted=1/ingested=1，recall 命中 document_id tern-hs-vault/alpha.md state=current |
| 增 gamma.md | job done，submitted=1/ingested=1，skipped=1（alpha 指纹未变） |
| 改 alpha.md | job done，submitted=1/ingested=1，update_mode=replace 重发 |
| 删 gamma.md | job done，deleted=1，recall 查 ternhindsightgamma 0 命中 |
| 故障：endpoint 改为 127.0.0.1:9 | job failed，submitted=0/ingested=0/failed=1，errors 记录 ECONNREFUSED 与 pending 1，failed 状态如实保留 |
| 恢复后重试 | 同一 job_id 续跑 done，服务端 operation 完成后 ingested=1，idempotent UUID 防重复 |
| 作业中断 | Carly 22:00 前提交的 hs-mvpbh9gq 经后台进程续跑 done，submitted=1/ingested=1/tracked=1 |
| watcher | syncOnEdit=false 返回 {state:'disabled'}，不产生日志或上传 |

隔离验收还创建了 smoke mental model、folder、knowledge page 并 update 改名成功，操作 receipts 均返回 operation_id。

## 已知限制

- 参考 Obsidian 插件的 body 无分块；整篇正文作为一个 retain item。
- 大缓存 mental model 的 query 反射较重，60 秒超时返回失败，不伪造成功。
- prepare 后 60 秒内无进程认领，作业按 interrupted 处理，可续跑。
- 真实库 Alexandria 尚未用 Tern 作业同步；其 recall/reflect 直接读 Obsidian 插件既有入库内容。
