# AI 见解模块接口

应用保持 CommonJS、Express 与 SQLite；三个业务模块共享 `src/insights/service.js`，不经过 MCP 网络层。所有暂定规则在项目配置中显式展示为待校准值，现有达标规则不变。

## 模块边界

| 层 / 模块 | 主要文件 |
| --- | --- |
| 公共层 | migration、依赖与锁文件、`src/insights/contracts.js`、`service.js`、`model.js`、`index.js`、`background.js`、公共 DB 查询、路由、全局配置、前端和共享文档 |
| 文章表现 | `src/insights/performance.js`、`src/insights/performance/`、`src/db/queries/ai-performance.js` |
| 行业资讯 | `src/insights/news.js`、`src/insights/news/`、`src/db/queries/ai-news.js` |
| Google 收录 | `src/insights/indexing.js`、`src/insights/indexing/`、`src/db/queries/ai-indexing.js` |

各模块在内部仓库均配有对应的 `node:test` 测试与合成夹具；本参考版未随附测试套件。

公共层维护权限、任务、事务与预算；各模块只通过公共上下文执行外部请求和提交结果。

## 模块导出

导出 `{plan,run}`。`plan({db,project,settings,now,actorId,selection,assertActive})` 返回 `{window_key,input,guards}`，`now` 为 UTC ISO 字符串。每次读取前调用 `assertActive()`。`input` 是执行时使用的不可变输入；`guards` 数组元素为 `{sql,args,expected}`，其中 SQL 是返回单个标量的内部 SELECT，执行时和最终原子写入都要求它与 expected 一致。建议以 SQLite `json_group_array(json_object(...))` 捕获所用文章及指标的完整版本；不得只用可能同秒重复的更新时间。配置版本和项目的 Google 绑定已由共享层守卫。规划不进行外部调用。窗口按上海业务日或完整月份；重复入队不应因读取已有本模块输出而产生新输入哈希。

`run(ctx)` 返回 `{cards,counts,warnings,status?}`。运行上下文包含 `db,google,config,adapters,run,project,input,settings,now,actorId,assertActive,commit,external,explain`。`run` 是持久任务，含 `id,project_id,actor_id,module`；`settings` 为经校验的完整配置；`input` 是 plan.input；`now` 为 ISO 字符串。

- `ctx.assertActive()`：重新校验执行者、项目、租约、配置和全部输入守卫，任何异步外部操作前和返回后都调用。
- `ctx.commit(statements)`：接受 backend.prepare(...).bind(...) 数组，在同一个原子事务内再次验证上述条件。模块禁止绕过它写任何业务结果。局部成功的新闻/收录快照可通过它保存。
- `ctx.external(kind,scope,fn,limits)`：先检查外部调用开关及权限，再原子预留预算、记录已发出，执行 fn，返回前重查权限并记账。limits 支持 `daily,projectDaily,minute,cost,dailyCost`。索引 kind=`indexing`、scope=精确 property，手动与日任务共用账本，失败也消耗计数。使用 settings.indexing 的上限。新闻网络使用 kind=`news`、scope=来源 URL。自动化测试注入 `adapters.synthetic=true`。
- `ctx.explain(evidence)`：返回 `{status,explanation,error_code?,usage?}`；每个 evidence 必须有 `id`。默认无模型配置时 status=disabled；严格 schema、引用、数字与链接检查失败时保留规则事实并返回失败状态。模型无工具权限，不能决定类别。若需专用上下文，放在有 id 的 evidence 中。数字引用允许 ISO 日期与中文年月日的等价展示，以及原始数值保留两位小数；不接受非零数被舍入为零、符号翻转或新计算。任何模型解释失败必须计入 warnings，不得伪称 AI 成功。

卡片格式：`{entity_key,category,priority,title,url,evidence:[{id,...}],...业务可展示字段}`。优先级为数字，高优先。文章以 article ID 为 entity_key，索引也以 article ID 为键；资讯按项目内事件去重键。可附 `summary,limitations,period,model,status,provenance`。模型结果请放 `model`，规则事实由模块自己计算。共享服务统一发布卡片并保存完整不可变 data_json，重跑保留人工 feedback。字段中不得包含令牌/账户秘密/未经批准的客户正文。

`background.language` 只控制解读与 Google 检查结果的语言。模型请求将它单列为 `output_language`，不据此填充目标市场或推断网站语种；空市场保持未知。文章模型证据包含规则判断、限制与待核查事项，低样本继续观察不能被改写为已确认的问题。完成 HTTP 后被结构、终止原因或证据校验拒绝的结果保留安全 usage 与 finish_reason，不保存拒绝正文或推理过程。

文章模块的 `input.model_input_version` 标识解释输入格式，旧格式计划在外部调用前取消。模型只收到 `kind: performance_narrative` 的定性证据，包含 `id,category,article_context,facts,limitations,recommended_checks,suggested_actions`；`id` 由当前文章的完整证据生成，保持稳定且区分不同文章或输入。卡片额外保存 `source_evidence_ids`，指向同一卡片内的原始快照；这组本地追溯引用不发送给模型。模型返回的 `evidenceIds` 只能引用实际收到的定性证据 ID，原有定量证据和页面指标对照保持完整。`performance-narrative-v4` 包含多月连续、季度、同期和同项目参考的确定性定性事实；article_context 的标题和登记关键词只提供主题，其中型号和版本数字在模型投影中屏蔽，不给数字指标作证；完整原标题和登记关键词保留在原始证据中。

## 数据表

0019 建立多模型条目与主备选择、外部调用配置，扩展账本记录实际模型与任务的单 URL 标量；旧单模型密文原样迁入 default 条目。部署对所有条目验证加密文件匹配。0017 建立公共设置、任务、见解、反馈、新闻条目、索引快照、预算和日调度去重表。字段以 migration 为准。模块读取/持久化新闻与索引行的 data_json 可包含最小必要结构，保留 evidence ID。新闻失败信息可作为运行 warnings 和卡片限制；索引每次尝试都写快照，有效性与业务状态分开。快照与任务有项目复合外键。

## 读取与操作 API

- `GET /api/ai-insights/configuration`：授权项目与配置状态元数据。
- `GET /api/ai-insights/activity` 与 `GET /api/projects/:projectId/ai-insights/activity`：展开时读取有界运行详情。
- `GET /api/ai-insights/overview`：三模块有界聚合，先按当前账号过滤再计算计数/排序/分页；无项目前置选择。支持模块各自 offset、category、feedback，以及按上海发布日期过滤的 news_date。`module_only` 只查询指定模块。列表仅返回卡片投影，完整证据从详情取得。
- `GET /api/projects/:projectId/ai-insights`：项目三模块看板。
- `GET /api/projects/:projectId/ai-insights/:id`：证据快照。
- `POST /api/projects/:projectId/ai-insights/runs`：`{module,retry_of?,article_id?}`，202 `{id,status,...}`。
- `GET /api/projects/:projectId/ai-insights/runs/:runId`：只读轮询，不执行任务。
- `GET/PUT /api/projects/:projectId/ai-insights/settings`：PUT `{version,config}` 乐观并发控制。
- `PATCH /api/projects/:projectId/ai-insights/:id/feedback`：`{action,note?}`。
- `GET /api/projects/:projectId/index-snapshots`：有限分页历史。

错误统一 `{error,code}` 和 HTTP 400/403/404/409/503。所有入口、入队、每执行单元、最终写入都重查权限。当前仓库 owner、在册文案师拥有同等业务权限；读取、运行、反馈和项目设置遵守这一规则。模型凭证由管理员配置页加密保存；未保存时兼容服务端环境默认。项目配置不能指定模型端点或密钥。未授权项目采用统一无权限结果。

## 外部调用与恢复

外部调用及每日自动任务分别默认关闭。模型还要求项目明确同意数据外发并配置调用上限。`model.budget_mode` 为 `cost`（默认）、`calls` 或 `unlimited`（显式测试不限额）；`cost` 还要求价格和金额上限，`calls` 只限制每日次数与输出 token，无价格时实际费用为 null。模式切换不重置次数；同日存在无预留额的未知费用时拒绝费用模式的新调用。`unlimited` 取消模型次数/金额/分钟限制，仍需项目外发授权，仍逐次记账并保留未知费用；不会绕过不确定请求暂停。无凭证仍可执行规则/固定样本。测试全部使用可重复 mock，不访问真实 API。持久租约过期后，未发出外部请求的任务可重新入队；已发出请求的任务标 uncertain，保留未知费用和预留额，不自动重发。主动重试保留 retry_of，uncertain 不支持自动重试。

单 URL 检查仅允许 indexing 提供正整数 article_id；共享层将 selection 传入 plan，并在显式重试时恢复原选择。模块验证该文章当前仍属于项目且有效。批量与单条共用预算和当日检查缓存，缓存卡片保留原 checked_at。

资讯 source 支持 tier（primary / secondary / unknown）和 publisher，均由配置维护者核实；news.min_summary_chars 与 news.max_per_publisher 为可配置暂定值。材料或日期不足使用 news_observation 类别并跳过模型，选择原因、来源关系及规则版本保留在证据里。

管理员模型配置 API：GET/PUT /api/admin/ai-model，现代 PUT 为 `{version,profiles,selected_model_id,fallback_model_id,enabled}`。profile 包含 id、label、base_url、model_name、enabled、input_rate/output_rate（可 null）、call_ceiling，可选 api_key / clear_key；响应仅 key_configured，不回显密钥。旧单模型请求仍可更新所选主模型。更换地址必须重新输入或清除密钥。全局配置版本加入入队、执行与事务守卫，保存不产生网络请求。

外部调用配置 API：GET/PUT /api/admin/ai-runtime，PUT `{version,external_enabled}`。管理员权限与乐观版本在同一事务验证；默认沿用环境值，保存后以网页配置为准。`DEPLOYMENT_HOLD` 强制关闭，暂停期间拒绝保存。版本加入任务身份与最终写入守卫。

文章观察窗为 performance.history_months，默认12，范围3–24，额外读取同比参考月。所有历史字段参与输入守卫，缺口、发布年龄、来源配置、URL修订和覆盖逐月校验。近期季度 CTR 使用累计点击/累计展示，排名按展示加权；连续趋势不跨缺口，同项目参考只包含本次分析的成熟可比文章，不表示完整行业排名。

资讯 source.kind 为 feed 或 search，search.query 由服务端固定生成 Google News 公共 RSS，聚合 feed 的 source 声明只作为发布机构元数据。最多20来源、3路抓取；每个 feed 上限100条，缓存与候选按来源均衡读取，精选候选上限300，超出显示延后。news-context-v4 使用 news_dossier 保存同关注方向的独立事件、日期与来源覆盖；模型接收有界标题/摘要投影和项目背景，关联报道同样作为顶层可引用证据，原报道证据保留。请求使用本次快照内的简短引用编号，响应精确映射回原始 ID；未给出的编号不模糊纠正，已完成的拒绝结果仍保留用量。精选保留有效来源代表，按声明来源分级优先一手材料，仍共享发布机构上限；相似标题不强并、发布日期缺失不当作抓取日期，覆盖/关联不单独证明趋势或独立核实。
