# DSH API survey

2026-10-27 15:01 +0800 开始。只读本仓库实现与安装的 DSH；不改 src、不提交、不调真实模型。证据、安装、实验脚本和日志统一在 `temp/null/20261027_dsh_survey/`（charter 指定位置）。读取父节点 tuy3fyg3 memory v1 / seq50。

安装命令使用 Node v22.23.2，npm cache/log 在指定 temp，HTTPS_PROXY 按 charter。npm --ignore-scripts 避免依赖脚本产生未受控动作；如运行所需 native 包因此不可用，将记为实验限制。

## 执行结果

- latest 安装完成为 0.2.1-rc.2，共617包。源码核对覆盖 Cordis hooks、session events/flush/surface/restore、tools、subagents、bundle/profile 与 Gemini adapter。
- 根消息 #17 授权只读同学 spine-dsh 和计划；#19 改定从头重写；#21 追加 Gemini 真实模型测试设计。全部已回执，本次没有调用真实模型。
- `smoke-old.mjs`：真实 Loader 注册当前插件四工具；首 pre-step 报 events is not iterable；surface/projection 不改变 derived context；旧 bootstrap 因 registerRequiredEventOwner 不存在失败。
- `smoke-loop.mjs` 四个分支（默认、--old、--retry、--cancel）实际用真实 AgentLoop/LLM Runtime/Session/Tools/Loader，仅 adapter 是假实现。默认3请求open-close-stop，旧插件0请求首步失败，retry4请求，cancel1请求且没有turn-stopping；断言均通过。只验证0.2.1公开接入钩子，不等同Spine语义e2e。
- `capability-probe.mjs`：released V4拒绝未知required archive/projection，允许ignorable plugin记录；当前SDK拒绝旧bootstrap dispatch；spawn数量1/17拒绝2/16通过。
- 重要未决：required archive owner与完整atomic ContextPlan publication接口缺失；取消/错误最终awaited durable barrier未证；内建spawn/fork都不直接继承当前完整parent context。已向父节点发#16/#25/#26并交完整报告。
- 查Google官方公开价格并保存页面与抽取；只记录GEMINI_API_KEY变量名，未读取/打印密钥。
- 未修改src、未提交、未跑全仓测试（本次是只读调研，验证仅temp实验）；git tracked工作树无变化。所有实验输出在指定temp，报告/留痕完成后移到archive。
