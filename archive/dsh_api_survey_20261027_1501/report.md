# DSH 0.2.1-rc.2 接口核对与重写前置结论

完整交付文档：`archive/dsh_api_survey_20261027_1501/report.md`；执行留痕：同目录 `worklog.md`；全部安装/实验材料：`temp/null/20261027_dsh_survey/`。

## 范围与证据

- 2026-10-27；本仓库 HEAD `3df13cf`。只读生产源码，不提交，不调用真实模型，不读任何凭据。
- 完整安装 `@deepseek-ai/dsh@latest` = `0.2.1-rc.2`，617 个包；Node v22.23.2，`npm install --ignore-scripts --no-audit --no-fund`。依赖锁、缓存、安装日志、实验脚本都在 `temp/null/20261027_dsh_survey/`。没有访问同学的 DSH 本体；收到根消息 #17 后只读获准的 `spine-dsh/` 和 `spine-dsh-plan.md`。
- 下文 `P/` = `packages/plugin/src/deepseek-harness/`；`N/` = `temp/null/20261027_dsh_survey/node_modules/@deepseek-ai/`；`O/` = `/data/swe/FramePilot/cachetree/scaffold/deepseek-harness-home/spine-dsh/packages/dsh/`。DSH 行号引用 npm 发布包 `lib/index.js` 或 `lib/types/*.d.ts`，不是仓库未发布源码。
- 标记：**源码**＝读发布源码核实；**实验**＝实际执行；**推断/待证**＝尚未证明的设计或风险。用户经根消息 #19 改定从头重写；两份旧插件都只作参考。消息 #21 要求补 Gemini 真模型测试方案，本次仍不调用模型。

## 结论先行

**不能把当前插件认定为可用于 DSH 0.2.1。** 它能通过真实 Loader 注册四个工具，但第一个真实 AgentLoop pre-step 就因 `session.events` 已移除而失败，真实/假 provider 都还没被调用。继续修这个读接口后，还会遇到 required event owner 缺失、完整 surface projection 缺失、tool message 结构变化、subagent API 替换。

**重写的 P0 是先证明 host 能力，而非立即写完整插件。** stock 0.2.1 的发布 API 没有旧版 required-event-owner 和完整 ordered surface replacement。`registerMessageProjection` 只改已有消息内容；标准 `surfaceOp.replace` 是区间→单消息。实验 plugin record 是可忽略、允许迁移丢失的记录，不是 required archive 的等价物。不能靠换名、吞异常或改请求文本把这些缺口藏起来。若仍坚持不改 DSH 本体，应先由用户决定可接受的公开插件面/持久化设计；当前调研不能证明旧合约可直接由 stock API 完成。

## 逐项接口核对表

| 项 | 插件位置 | DSH 0.2.1 位置 | 判断与语义 |
|---|---|---|---|
| Cordis `name/inject/apply` | `P/extension.ts:36-37,110` | `N/dsh-subagent-spawn-in-process/lib/index.js:10-12,38-42`；真实 Loader 冒烟 | **一致（源码+实验）**。可加载 ESM function plugin；禁用时 apply 早返回。 |
| `agent/pre-step` | `P/extension.ts:133-136` | `N/dsh-agent/lib/types/runtime-types.d.ts:293-314`；`N/dsh-agent-loop/lib/index.js:902-930` | **一致（源码+实验）**，awaited waterfall，payload 含 agent/messages/turn/step/signal，必须返回 `next()` 决策。注意 systemPrompt assembly 在 pre-step 前已发生。 |
| `llm/stream` | `P/extension.ts:138-144,254-262` | `N/dsh-llm/lib/index.js:2393-2398` | **形状一致、分类不充分（源码）**。同步返回 AsyncIterable；async generator 可在第一次迭代前 await。0.2.1 提供 `isAgentLoopRequest()` 检查 exact object 身份，应优先于 purpose 缺省启发式。 |
| `session/event` | `P/extension.ts:146-150` | `N/dsh-session/lib/index.js:1577-1601` | **一致（源码）**，`(session,event)`；同步发布、逐 listener containment，Promise 不被 await。不能在此同步 reenter append；也不能把该通知当 durable/异常传播 barrier。 |
| `agent/request-error` | `P/extension.ts:152-159` | `N/dsh-agent/lib/types/runtime-types.d.ts:338-357`；`N/dsh-agent-loop/lib/index.js:1131-1149` | **一致但覆盖有限（源码+实验）**，awaited waterfall，返回 retry/undefined。针对流的 error/aborted finish；并不兜住所有 thrown exception、signal cancellation、工具期故障。 |
| `agent/turn-stopping` | `P/extension.ts:161-163` | `N/dsh-agent/lib/types/runtime-types.d.ts:373-392`；`N/dsh-agent-loop/lib/index.js:999-1008` | **成功路径一致（源码+实验）**，awaited serial，在最后 step/end 后、turn/end 前。取消/抛错路径跳过它，不能当通用 finally。 |
| `session/disposed` | `P/extension.ts:165-178` | `N/dsh-session/lib/index.js:1925-1936` | **事件一致、非 awaited teardown（源码）**；不能证明 `whenIdle()`/外部完成时 archive 已 flush。 |
| `session.events` | `P/extension.ts:203`；`P/index.ts:79` | `N/dsh-session/lib/index.js:1452-1479`；`lib/types/index.d.ts:205-230` | **缺失（源码+实验）**。旧 getter 已移除。`snapshotEvents()` 尚存在但明确 deprecated/new calls prohibited；新实现使用 `sessionQuery.observeSession()` 的 observation.events（`N/dsh-session-query/lib/types/index.d.ts:47`、`observation.d.ts:7-27`），及时 dispose，或自己的受控增量 projection。不能简单把生产新代码写成 snapshotEvents。 |
| `user/message` | `P/extension.ts:272-274`；`recovery.ts:149` | `N/dsh-agent-loop/lib/index.js:1067-1073` | **一致（源码）**，data 就是 UserMessage；source.kind 区别人类和 runtime context。 |
| `assistant/message` | `P/extension.ts:274-275` | `N/dsh-agent-loop/lib/index.js:1156-1164` | **一致（源码+实验）**，data.message + data.usage；另有 assistant/attempt（失败流，不是成功消息）。 |
| `tool/call` | `P/extension.ts:280-286` | `N/dsh-agent-loop/lib/index.js:578-582,681-689` | **一致（源码+实验）**，data.callId/name/arguments；在 prepare/dispatch 前 append。append 是 log acceptance，不等于 durable flush。 |
| `tool/result` | `P/extension.ts:276-279,422-438`；`messages.ts:15-19`；`recovery.ts:158-168` | `N/dsh-agent-loop/lib/index.js:692-711`；`N/dsh-llm/lib/types/message.d.ts:151-160` | **失配（源码+实验）**。现在 role=`tool`，content 是 text 等块，`toolCallId`、`isError` 在 message 顶层；旧版只接受 system/user/assistant，并在嵌套 tool-result 块找 isError，即使放宽 role 也会误记失败为成功。 |
| `tool/code-dispatch-start` / `tool/code-dispatch` | `P/extension.ts:287-299` | `N/dsh-tools/lib/index.js:1400-1433`；`N/dsh-session/lib/index.js:133-134` | **失配（源码）**，改名为 `tool/ptc-dispatch-start` / `tool/ptc-dispatch`，字段仍有 subCallId/name/arguments/isError。旧名在 V4 被认定 retired（`N/dsh-session-format-v3-to-v4/lib/index.js:174`）。更合适使用 awaited tools/execute + tools/result 统一处理 native/PTC。 |
| `step/end` | `P/extension.ts:300-301` | `N/dsh-agent-loop/lib/index.js:982-998` | **事件一致、不能直接表示成功（源码+实验）**，在 finally 总会 append。旧 deferred success 的思路应保留，但必须证明错误/取消覆盖和最终 awaited 排空。 |
| `turn/end` | `P/extension.ts:302-306` | `N/dsh-agent-loop/lib/index.js:1012-1035` | **reason 形状基本一致（源码）**，completed/aborted/error/blocked/max-tokens 等；旧版只对错误/取消 enqueueFinish，正常成功依赖前面的 stopping。它是非 awaited session/event 通知。 |
| `compaction/*` | `P/extension.ts:268-271`；`recovery.ts:60-64` | `N/dsh-compaction-basic/lib/index.js:469-511` | **仍存在（源码）**，排斥 native compaction 的思路正确；但还有 image/offload 等不以 compaction/ 命名的 context 改写，光查 ctx.compaction/事件前缀不够。 |
| `sessions.registerRequiredEventOwner` | `P/extension.ts:115-116`；`index.ts:98,136-138,250-258` | `N/dsh-session/lib/index.js:1714-2050`、`lib/types/index.d.ts` | **缺失（源码+实验）**。0.2.1 没这个 registry；released V4 vocabulary 静态构建。不能用 registerMessageProjection 冒充 owner/codec。 |
| `sessions.flush(session)` | `P/index.ts:128-132` | `N/dsh-session/lib/index.js:1939-1969` | **一致（源码+实验）**，await 所有 durability listeners，返回是否至少一个参与。false 必须拒绝，不代表已持久化。 |
| `session.surface.nodes/replaceGeneration` | `P/index.ts:75-76,155-161` | `N/dsh-session/lib/index.js:539-548,1329-1331` | **仍存在（源码+实验）**。另有 contentGeneration。读 generation 不等于有完整 surface CAS 发布 API。 |
| `surface/projection` | `P/index.ts:152-166` | `N/dsh-session/lib/index.js:150-163,420-476,1729-1737` | **缺失且静默无效（源码+实验）**：同名未知事件可进入内存 log，但 deriveMessages 不变；released V4 restore 拒绝未知 required type。新 registerMessageProjection 是 seq→既有消息内容更新，不改变 membership/order；普通 replace 将区间换成一个 message，不等价旧完整 ContextPlan atomic projection。 |
| `tools.register` | `P/extension.ts:311-366` | `N/dsh-tools/lib/types/index.d.ts:105-128,217-239,637`；`lib/types/index.js:468-488` | **结构一致（源码+实验）**，name/description/parameters + required output.schema/render + async execute(args,exec)；exec.agent/callId/signal 仍有。真实注册四工具成功；手写 schema 语义落后于 SDK。 |
| `subagents.start` | `P/extension.ts:375-399` | `N/dsh-subagent/lib/types/index.d.ts:123-145`；`types.d.ts:25-52` | **缺失（源码）**，改为 startActivation(spec)，见下文。activation.childId，不是 run.id。 |
| structured output | `P/extension.ts:99-107,380-391` | `N/dsh-subagent/lib/types/types.d.ts:161-166,237-262`；`lib/types/structured.js:14,48-75` | **能力仍在但调用入口变了（源码）**。outputSchema 放 spec.request，模型要调 structured_output；result.structured 仅有效捕获时存在，失败/取消不会自动给模型 memory。不能从异常/最后文本伪造 memory。 |

## 发布包真实冒烟

所有脚本在 `temp/null/20261027_dsh_survey/`；没有真实 API 调用。

1. `smoke-old.mjs`：真实 Cordis Context + Loader + SessionStore + SystemPrompt + ToolRuntime；加载本仓库 dist extension 成功，四工具可见；pre-step 报 `events is not iterable`。append `surface/projection` 前后 derived message 数均为 1，证明不是有效投影。O/bootstrap 真实 Loader fiber state=3，readiness service 不存在。`smoke-old.log` 保留结果。
2. `smoke-loop.mjs --old`：真实 AgentRegistry + AgentLoop + LlmRuntime + SessionProjectionRegistry + 上述服务；假 adapter 已注册；加载当前插件，发送用户消息；**provider calls=0，turn/end.error=events is not iterable**，断言通过。日志 `smoke-loop-old.log`。
3. `smoke-loop.mjs`：temp 中 `hook-probe-plugin.mjs`（只验证接口，不实现 Spine）经真实 Loader 加载。用真实 base bundle patch + `probe.bundle.patch.yml` compose，断言四个 native reducer/入口 disabled。假 adapter 依次发 open、close、stop，**3 请求、两个 tools body 执行、turn completed**，断言通过。`loop-session.jsonl` 是真实 Session 事件，由 survey flush listener 写入；不是官方 JSONL backend 端到端，不证明 Spine archive/ContextPlan。
4. `smoke-loop.mjs --retry`：第一次 synthetic RATE_LIMIT finish，probe recovery listener 返回 retry。**同一个 step 第一次失败后再次 llm/stream，第二次才 open；总 4 请求**，每次 loop request 都被 isAgentLoopRequest 识别；断言通过。不是生产 retry policy 的完整测试。
5. `smoke-loop.mjs --cancel`：假 adapter 内触发 agent.cancel(user)。**1 请求；assistant/attempt → step/end → turn/end(aborted)，没有 request-error，也没有 turn-stopping**；断言通过。最终文件写入由脚本额外显式 flush，不能算 host 默认的 awaited terminal checkpoint。说明正常 stopping 不能封闭所有采样事务。
6. `capability-probe.mjs`：调用真实 `restoreReleasedV4Artifact`。`spine/archive` 和 `surface/projection` unknown required 均拒绝；`plugin:spine/archive` + ignorable 被接受。旧 O/package.json 的 rc.5 peers 被 0.2.1 compatibility 判为不满足、未豁免。SDK 原生 validator 的 spawn 数量 1/17 拒绝、2/16 通过。当前 SDK 没有 O/runtime 依赖的 bootstrap request variant。日志 `capability-probe.log`。

运行方式：`$HOME/.nvm/versions/node/v22.23.2/bin/node temp/null/20261027_dsh_survey/smoke-loop.mjs [--old|--retry|--cancel]`。npm install 已结束；不需要编译、不需写任何生产路径。安装用了 ignore-scripts，未验证全部 CLI/native 依赖；本次实际加载的核心服务正常。

## 哪些请求会被误当采样

- **普通 loop 请求、重试**（源码+实验）：`N/dsh-agent-loop/lib/index.js:1281-1288` 标记 exact request，purpose 未定义，带 sessionId；重试发生在 step 内 request-error 后（1136-1149），不是新的 pre-step。旧插件的 request-error 先 finishNow 再 next，按此路径不会撞 prior sampling active；仍需回归验证 exception/cancellation 分支。
- **Compaction 摘要**（源码）：`N/dsh-compaction-basic/lib/index.js:313-323` purpose=`compaction`，sessionId=父 session；旧 filter 跳过。启用 Spine 时应禁掉执行入口，而不只是跳过采样。
- **标题**（源码）：`N/dsh-session-title-llm/lib/index.js:191-214` purpose=`session-title`、相同 sessionId，prepared call.stream 仍经过 llm waterfall；旧 filter 跳过。
- **自动权限 review**（源码）：`N/dsh-experimental-auto-review/lib/index.js:397-414` 不带 purpose，但也不带 sessionId；旧 filter 因无 sessionId 跳过。
- **子 agent**（源码）：是独立真实 AgentLoop、独立 sessionId 的普通请求（purpose 未定义），应绑定自己的 sampling，而非算父 agent 第二次采样。
- **暖缓存**（限定的静态结论）：检查已安装所有 DSH 包 bundled lib/index.js 的 llm 调用点、purpose、cache-warm/maxTokens:1，没找到类似 Pi CacheWarmer 的定时 maxTokens:1 replay；这不是对未来插件或 provider 内部一切网络重试的全称证明。pi-ai adapter 明确关闭 SDK 自动 retry（`N/dsh-llm-pi-ai/README.md:259`），visible retry 交给 DSH。
- **潜在误判**（推断）：任意插件带已有 sessionId、不带 purpose 手工调 llm.stream，旧 filter 会当成真实新采样；复制/重放原 request 的辅助插件同理。未发现 stock caller 符合这个触发条件，不能宣称已复现 Pi 同款 bug。重写使用 `isAgentLoopRequest(request)`（`N/dsh-llm/lib/index.js:357-388`）并验证对 middleware 顺序/重入身份的约束，不能用 maxTokens 数值猜。

## 三处已知缺口复核

1. **spawn schema（源码+实验）**：`P/extension.ts:324` 的 minItems=1 与 core validator 的 2..16 不符。真实 Node WASM validator 1/17 拒绝、2/16 接受；SDK toolCatalog 的 spawn schema minItems=2，但目前 catalog 自身没发 maxItems=16。重写从 SDK catalog/validator 派生，不手写另一套；schema 上限缺失是 SDK catalog 的单独事项，不能称取 catalog 就已覆盖上限。
2. **system instruction（源码）**：当前 P/ 没使用 extendSystemPrompt、nodePrompt 或 systemPrompt.section，只注册简短工具说明；遗漏 canonical Spine instruction。O/runtime.ts:59-72 有 SDK instruction → section 的正确意图，但它用的 bootstrap/validate_tool dispatch 不存在于本仓库当前 SDK（实验 invalid_json）。应使用本仓库 `packages/sdk/src/node.ts:83-105` 的 extendSystemPrompt/nodePrompt/toolCatalog/validateSpineToolInput，映射工具名后注入 `systemPrompt.section`；不能照搬 bootstrap variant。
3. **stageSpawn 比 durable tool/call 早？**：对 **0.2.1 native 调度不是源码事实**。`N/dsh-agent-loop/lib/index.js:578-582` 先 append call，再 await prepare，然后 dispatch；fulfilled state 的 session/event Promise callback 会先 enqueue register，spawn stage 又经过同一 tail，未知 call 不是正常路径必现。**append ≠ durable**；真正 durability 由 `N/dsh-session-checkpoint-policy/lib/index.js:66-70` 在工具 body 前 await flush。PTC nested 不另做该 flush，依赖 outer call。旧插件监听的是已改名的 code-dispatch，所以 PTC spawn 仍可能 unknown call（推断），不能用 native 顺序反驳该风险。重写用 awaited tools/execute 注册/验证/stage，明确是否保证 durable call；真实 scheduler native/PTC + denied/aborted/finalizer + 慢 flush 都要测。

额外 **Spawn prefix 语义缺口（源码+推断）**：formal authority `/data/swe/FramePilot/cachetree/doc/FormularDef.md:635-643` 要求 C_child=C_parent·Δ。当前 P/extension.ts:112 默认 provider=`spawn`；`N/dsh-subagent-spawn-in-process/lib/index.js:1-7,20-30` 明确 fresh/zero parent context、inheritsParentContext=false。内建 fork（`N/dsh-subagent-fork-in-process/lib/index.js:13-27,34-48`）也只继承最后 completed turn，遗漏当前 spawn 所在 turn。两者都不能不加证明就声称保留当前 parent prefix。

## 两份旧实现逐模块对照（仅参考，不以任何一份为底）

| 模块 | 值得保留的做法 | 必须避开的旧假设 |
|---|---|---|
| packaging/ownership | O/cordis.patch.yml:1-16 显式禁 native compaction/compact command/pruner，用 readiness 服务约束加载；比 P/ 单纯 ctx.get 检查完整 | O/ 的 rc.5 peers 已不兼容；两份都没覆盖新 image-offload。profile 有 bundle 但 runtime enabled:false 会残留禁用 reducer，不能称 feature-off 恒等。 |
| SDK/prompt/tools | O/runtime.ts:59-72,184-186,258-290 由 SDK 导出 instruction/schema、统一映射工具名；思路正确 | O/runtime.ts:64,121 bootstrap/validate_tool 不是本仓库当前协议；P/extension.ts:311-415 手写 schema/说明且没 canonical system prompt。 |
| sampling lifecycle | 两份每 session 一个 queue、fault latch、deferred successful step、下轮/正常 stopping 前 commit（P/lifecycle.ts:35-207；O/lifecycle.ts:8-143） | 两份用 purpose===undefined 判断主采样；两份都没证明取消/工具异常最终 durable barrier。不要把 finally step/end 当成功。 |
| tool staging | O/runtime.ts:113-136 awaited tools/execute 注册 + tools/result 结束，比靠 session/event 再异步 pending.then 的 native/PTC event 枚举更直接 | 仍要补 denied/pre-body skip、post-policy failure、nested execution 和 aborted-before-dispatch；注册事实与成功执行事实不能混。P 的 code-dispatch 旧名失效。 |
| messages/recovery | 两份 typed source bindings、跳过自身投影、物理事件+archive replay、fork namespace、model-authored memory，不从 rendered text 猜（P/messages.ts/recovery.ts，O/同名文件） | 两份依赖 session.events、旧 tool role/嵌套 result；synthetic source.kind=plugin 已不是 0.2.1 共享 catch-all（N/dsh-llm/lib/types/message.d.ts:95-103）；新 source 应声明自己的 producer。 |
| controller/host adapter | 共享 `packages/plugin/src/controller.ts`、`host-adapter.ts` 的 prepare→persist→install→publish 事务思想可复用 | O/src/controller.ts、host-adapter.ts 是它自己的副本（O/src/adapter.ts:3-4），不要把旧分支副本重新抄进新版制造第二份语义；能否复用取决于新 host 能力 gate。 |
| durable adapter | P/index.ts:128-166 和 O/adapter.ts:26-68 都坚持 flush/先 archive 后 publish；P archive 校验更细（index.ts:296 起）；O bootstrap codec 先于 persistence 的构图意图正确 | 两份都依赖已经不存在的 required owner/surface projection；O/adapter.ts:39 claimOwnership 不像 P 那样先校验 active flush，且 decoder 比 P 弱。不能把 ignorable plugin record 当等价替代。 |
| spawn | P/extension.ts:347-399 + shared spawn.ts 并发、task-order receipt、逐 terminal staging、abort/drain；值得复用纯 batch 协调思想 | O/runtime.ts:185 明确不注册 spawn。P start API 旧、run.id 旧、默认 spawn 丢 parent prefix；失败 structured 缺失不能拼假 memory，取消必须 dispose 已发布 activation。 |
| usage | P/extension.ts:440-447 sum(input/cacheRead/cacheWrite) 符合新 DSH disjoint accounting（N/dsh-llm/lib/types/types.d.ts:153-172） | O/runtime.ts:312-317 只取 inputTokens，带 cache 时低估；兼容 input_tokens fallback 不应继续扩散。 |
| tests | O/test/harness-composition.test.mjs:21-162 使用真实 Loader/Session/Tools，比本仓库 fake ctx 更有价值 | O 测试是 rc.5 workspace 相对 imports，不能算 0.2.1 测过；其中“真实 session lifecycle”仍手工 emit hooks，不是实际 AgentLoop/provider 全路径。两份都不能替代最新 npm 包 + 真 AgentLoop 的 e2e。 |

## 重写设计要点与可验收优先级

### P0：先解决/确认合约所需 host 能力（未完成，不建议开始真模型花费）

1. **Required archive + atomic ContextPlan publication**：在 stock 0.2.1 公开接口上做最小证明：未知 required event 如何在官方 restore/fork 校验并先于采样注册；完整 typed message list 如何以一个受控事务发布、generation/provenance 如何校验。当前 read/probe 结论是旧能力已不存在。若无合法实现，记录 gap 并请用户决策；不改 DSH 本体、不联系维护者的边界仍生效。不能污染 static KNOWN_SESSION_EVENT_TYPES、写 parser、使用 rendered-text workaround、借 ignorable 或只拦 provider 请求伪装完成。
2. **所有 terminal 的 awaited ownership**：主采样入口可用 llm/stream async generator + exact request marker；上一成功 step 在 awaited agent/pre-step、最终成功在 awaited agent/turn-stopping 结束。retry 在 awaited request-error 结束失败 attempt。取消/throw/tool drain 没有同等统一 awaited turn-finally，本次 cancel probe 直接证明；必须证明通过公开生命周期可让插件队列在会话完成/卸载前 drained+durable，不能仅 session/event 里 void promise。做不到同样报 gap。
3. **Spawn C_parent prefix**：明确以哪个公开 seed/preset/AgentFactory seam 构造当前 parent context 的精确 prefix；内建 spawn/fork 不自动满足。生产要保持 inherited typed messages/缓存 lineage，不能把历史串成 user 文本。

### P1：能力 gate 通过后才实现

- 一个 out-of-tree bundle：manifest `dsh.bundle.patch`，锁定/声明 `engines.dsh` 为已测 prerelease；runtime 与准备服务明确 inject。agent-loop/persistence 等必须等 Spine readiness，避免 bundle 禁了原生 reducer但 Spine 初始化失败时系统照跑。
- base stack 后禁 `compaction-basic`、`command-compact`、`tool-result-pruner`，对 `image-offload` 也明确禁用或证明和 Spine 不冲突；profile/user patch 覆盖必须再检查最终 composition。feature-off = bundle absent，而不只是 runtime enabled:false。
- 通过 current Node SDK 生成 instruction/tool schema/纯参数校验，不创造 bootstrap protocol；systemPrompt.section 为全局/相应 scope 安装 typed section，遵守 persona/preset边界。注入 mechanics/schema/行为测试，不写提示词必须含/禁止词列表。
- 每 session 单独 lifecycle state/queue/source bindings；observe raw typed messages（含 tool/developer 处理策略）与执行事实分离；工具输入校验失败不得先让整个采样永久 fault；允许的 terminal memory 必须模型写。
- 使用 awaited tools/execute + tools/result 统一 native/PTC 执行；call identity、权限拒绝、取消、post-result failure 必须一一结算。
- `ctx.subagents.startActivation({provider,label,signal,delivery:'caller',request:{parent,prompt,outputSchema,...}})`；返回 activation.childId/result/dispose（`N/dsh-subagent/lib/types/types.d.ts:25-52`）。delivery caller 避免与 Spine receipt 双重 parent message。启动 signal 只保证 publication 前取消；启动后必须桥接 caller abort→dispose exact activation（该差异在类型注释明示）；清除监听器、drain 所有孩子。子结果 structured.memory 验证后逐 ordinal durable staging，再按 task order 入一次原子 commit，失败不得从异常捏造 memory。

### 必补测试清单

- **P0 capability contract**：真实发布包 restore/fork/restart 对 required archive 缺 owner/损坏/未知 schema 必须拒绝；全 ContextPlan live/replay 完全相等；commit-before-install/publish各 crash point；官方 persistence，不用手写 flush 成功代替。
- **P0 sampling**：真实 AgentLoop+假 LlmAdapter：普通两 step、title/compaction/auto-review/手工辅助请求、retry、stream throw、取消（stream中、工具中、step/end后）、工具拒绝/post-block/finalizer错；每个实际 loop attempt 一 begin 一 terminal，辅助请求零 begin，最后 tool facts 入同一个正确 commit；真实 completion/teardown 后不留异步 archive。
- **P0 spawn**：2..16 schema/validator，singleton/17拒绝；当前 parent prefix exact继承（含当前 turn）、ordered result（逆序完成）、structured缺失/错误、子失败/取消、parent取消、已发布 activation disposer、部分 terminal staging后崩溃、恢复不盲目重跑。
- **P1 integration**：真实 Harness Loader + npm DSH + bundle composition + 假 provider 的 open/next/close/spawn→archive→ContextPlan→下一请求；PTC 与 native 同一断言；SDK off/on、bootstrap失败、profile override/HMR/服务卸载顺序。
- **P1 feature-off differential**：bundle absent 时 config、request、session log、compaction/subagents 与原 base 相等；不能只测 apply(enabled:false)不触 ctx。
- **P1 real model**：下面少量 Gemini gate，仅在 deterministic tests 与 host capability gate 过后运行。

## Gemini 接入与省钱的真模型 e2e（方案，不执行）

**源码核实**：使用已安装的 `@deepseek-ai/dsh-llm-pi-ai`，catalog route 为 `google`。`N/dsh-llm-pi-ai/lib/index.js:2667-2669` 的 generated metadata 是 `GEMINI_API_KEY`、`https://generativelanguage.googleapis.com/v1beta`。`README.md:36-73` 给 providers / apiKeyEnv / models / retryPolicy 配置；只记录变量名，不读取值。精确模型 catalog 同时包含 gemini-3.1-flash-lite、gemini-3.8-flash、gemini-3.6-flash。不需 Vertex/ADC，不登录、不写 home。

建议 profile patch（配置示例，未触网验证）：

```yaml
- id: llm-pi-ai
  config:
    providers:
      google:
        apiKeyEnv: GEMINI_API_KEY
        models:
          - id: gemini-3.1-flash-lite
        reasoning: minimal
        retryPolicy:
          mode: normal
          maxRetries: 0
```

测试创建 Agent 时 agentOptions={provider:'google',model:'gemini-3.1-flash-lite',maxTokens:1024}；实际选择由用户定。最小 profile 不挂标题、自动 review、Web/搜索/文件工具；禁止真实模型开 shell，四个 Spine 工具和 structured_output 足够。每场景有 step/request/token/deadline硬上限，第一次失败保留 trace，不自动无限复跑；非 determinism 与产品 bug 分开。

| 场景 | 真模型必要性 | 建议请求/估计 token（总量，含重复输入） |
|---|---|---|
| open→next→close→最终短答 | 需要一条验证模型读 canonical prompt、工具参数、模型写 memory、闭合后还能继续 | 4 请求；约16k input + 2k output |
| spawn 两独立孩子，各 structured_output，父 join 后短答 | 需要一条验证 Gemini function calling 与子 structured memory；不要用16孩子烧钱 | 4–6 请求（父2、孩子各1–2）；约24–36k input +2–3k output |
| 从以上真实 transcript resume/fork 后各一个 followup | replay本身假provider/纯恢复足够；建议2个真实短请求验证 replay metadata 与真实 Gemini后续请求可用 | 2 请求；约8k input +1k output；恢复构建零模型调用 |
| retry/取消/长工具、故障注入 | 全部细节用假provider；不应花钱制造真实429或270秒等待 | 默认0额外真实请求；可选1个stream中取消 +1个“注入第一次错误后真实成功”，各最多4k input +0.5k output |

推荐一套 **10–14请求、约48–64k input +5–7k output**；这是规划估计，不是测得 usage。输出预算包含 thinking，控制每请求1024，父 memory目标128–256 tokens；实际重复前缀较大时据 usage 调整。总体硬封顶可设20请求、每请求最多8k input /1024 output，超限拒绝再请求；不依赖缓存折扣、不使用 Batch（在线多轮因果链不合适）。

**价格来源**：2026-10-27 读取 Google 官方 https://ai.google.dev/gemini-api/docs/pricing 。HTML 与抽取在 `gemini-pricing.html`、`gemini-price-extract.txt`。Standard付费文本价格，USD/百万 tokens，输出含thinking：

| 用户可选模型 | 输入/输出 | 按64k/7k一次 | 20请求最坏预算160k/20,480 | 建议 |
|---|---:|---:|---:|---|
| gemini-3.1-flash-lite | $0.25 / $1.50 | $0.0265 | $0.07072 | 建议默认，便宜、已在安装catalog；先确定工具行为可用。 |
| gemini-3.8-flash | $0.75 / $3.75（至2026-12-31） | $0.07425 | $0.1968 | Lite 若因遵循能力失败时交叉验证；同价下比旧3.6更合适。2027-01-01官方列价翻倍，运行前重查。 |

公式 cost=(sum input*inputPrice + sum billedOutput*outputPrice)/1e6。上表不含税费/网络代理额外费；不假设免费额度/缓存。建议整套预算$1硬停（明显高于上述计划、仍很小），并由用户确认模型。`gemini-2.5-flash-lite` 更便宜但接入/可用性受旧模型策略影响，不把它当新测试基线。根此前的单次>$30要先询问授权仍适用；本方案远低于此，不构成实际已获发布/外联授权。

## 智子使用体验

`show ..` 能直接拿到父节点现状；`write --reply N -M` 一次完成回执，避免父节点不知道新边界有没有收到。根通过 #17/#19/#21 持续改定“可读参考目录/从头重写/真模型测试方案”，消息记录清楚；需要在 memory 手动把有效 scope 与原 charter 区分，本报告已据最后指令修正。没有遇到阻断的 sophon CLI 问题。CLI `--help` 才发现独立 `log` 命令，初始手交接只强调 show/status/write；若希望每个 run 留摩擦日志，可以在交接模板里直接给 log 用法。
