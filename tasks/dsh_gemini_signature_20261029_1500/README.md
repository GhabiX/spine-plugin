# Spine 上下文排布：只在采样边界之后插入

2026-10-29，交 SpineCodex（spine-core）维护者。第一版文档（只讲了 Open 那一侧）留在 `README.v1.md`。

## 一句话

Gemini 会校验模型消息上的 `thoughtSignature`。Spine 现在有两处会改动一条带签名的模型消息前面的内容：Open 时把节点描述插在打开调用之前；Close/Next 时把关闭调用留在 memory 之后。Gemini 因此偶发在回复中途返回 `400 INVALID_ARGUMENT`。修法是内核统一遵守一条规则，不按模型厂商分支。PoC 已经做了，内核和插件的测试都过了，用 Gemini 实测的结果在后面。

## Gemini 的规则（官方文档）

来源：<https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures>

- "Strict validation is enforced for all function calls within the current turn."
- "Only current turn is required; we don't validate on previous turns."
- 「当前轮」从最近一条带普通内容（不是 functionResponse）的用户消息算起。
- 文本部分的签名不强制校验，缺了不报错，但文档说效果可能变差。
- 文档要求签名按收到的样子原样传回，放在原来的位置。

Spine 插入的节点描述、memory、arrival 都是 user 文本，所以每插一条，在 Gemini 看来就开始了新的一轮。

## 问题出在哪

- **Open**：`reducer.rs` 的 `open()` 把打开调用那次采样放成子节点的第一条，`render_node()` 先输出描述、再输出子节点内容，于是描述排在打开调用之前。描述成了最后一条用户文本，打开调用落在当前轮里，会被校验；而它生成时前面并没有这条描述。
- **Close / Next**：`close()` 把关闭调用那次采样放在父节点里，排在子节点 memory 之后；`next()` 把它放成新兄弟节点的第一条，也在上一个节点的 memory 之后。这次调用生成时前面是子节点的完整过程，现在换成了 memory。只要后面还没有新的用户消息，它就在当前轮，会被校验。

之前的证据（`evidence/`）：失败请求 `004.req.json` 原样重放 5 次成功 2 次；只把描述挪到打开调用和工具结果之后，4 次全成功；去掉全部签名直接 400。样本小，只能算方向性证据，主要证据看下面的实测。

## 方案

先定义「采样」：模型的一次调用，包括它输出的思考、文本、所有工具调用，以及这些工具的结果。内核里一次采样就是一个 `SourceSpan`。

要守住的不变式：**模型的一条输出如果原样留在上下文里，它前面的内容必须和它生成时看到的一样。** 这条不只是 Gemini 的要求：描述排在打开调用之前，模型读到的历史就成了「我先被告知进了 1.1.1，然后才去打开 1.1.1」，和实际发生的顺序相反。Gemini 只是用签名把它强制了。

内核两条规则：

1. **新内容只追加在采样边界之后。** 节点描述、memory、birth、arrival 都排在某次采样的全部输出和工具结果之后。Spawn 和 arrival 现在已经是这样，Open 和 Next 的描述是例外。
2. **关闭节点的那次采样随节点一起折叠。** Close/Next 那次采样归属被关闭的节点，折叠后只剩 memory。

两条规则对所有模型都一样，不按厂商分支，所有宿主看到的仍是同一份上下文。缓存不受影响：改动只在上下文末尾，每次请求的前缀仍和上一次一样。

### 对昆秋三点考虑的回应

1. 「做 open 决定时看不到当前采样的内容，所以放在采样前」：模型做这次采样时没看到描述（包括里面的节点提示词），放在前面等于告诉模型「你当时看到了」，所以应该放在后面。
2. 「close 时能把这次采样算作子节点」：这是归属问题，和显示顺序是两件事。采样照样是子节点的第一条，关闭时一起折叠，只是描述渲染在它之后。
3. 「一次采样有很多条消息，不用操心 open 放哪」：一次采样就是一个 `SourceSpan`，「放在这个 span 之后」是唯一的位置，不需要在采样内部找位置。

只给 Gemini 走 post-sampling 不建议：内核会出现按厂商分支的逻辑，测试和一致性数据要备两套；而且只改 Open 的话，Close/Next 仍会出错。

## PoC

分支 `poc/sampling-boundary`，基于 SpineCodex `9e956ba`（插件 `core-source.json` 锁定的版本）。worktree 在 C80 `/data/swe/FramePilot/cachetree/scaffold/spine-sdk-plugin/temp/null/20261029_sigpoc/codex`，没有提交。patch 在本目录 `poc/spine-core.patch`。

改动都在 `codex-rs/spine-core/src/reducer.rs`：

- 节点描述变成节点的一条 entry（复用 `ContextItem::SyntheticNode`，没有新类型）。`open()` 的子节点从 `[打开采样, 描述]` 开始；`next()` 的兄弟节点从 `[描述]` 开始。
- `render_node()` 不再自己先推描述，只按 entries 渲染。
- 新增 `fold_closing_sampling()`：`close()` 和 `next()` 先把关闭那次采样放进被关闭的节点，再组装 memory；父节点不再追加这次采样。节点的 `end` 改成这次采样的结尾，`next()` 新兄弟的 `start` 改成这次采样的结尾。

测试：

- spine-core：72 条全过。改了 1 条写死旧顺序的预期（`close_keeps_replies_and_drops_other_assistant_text`，关闭采样不再出现在 memory 之后）。新增 1 条 `a_sampled_item_keeps_the_context_it_was_sampled_in`，把 Open、嵌套 Open、Next、Close 后的排布钉住。fmt 干净；clippy 有两处 `expect()` 报错，原版本上就有，不是这次引入的。
- 插件仓库（用 PoC 内核重建 WASM）：SDK 30/30、host 18/18、Pi 插件 160/160（另有 2 条跳过）。Pi 改了 1 条写死旧下标的测试（`poc/pi-plugin-test.patch`）。
- DSH 插件：30 条里 14 条失败，都是写死旧排布的预期，还没改。核对方法：`poc/reorder-check.mjs` 作为预加载，断言失败时把旧预期按两条规则改写，改写后和实际一致就算通过。这样 9 条通过；剩下 5 条是按下标取元素或断言「最后两条是关闭调用」，逐条看过，也只是顺序变化。正式改时要逐条更新这些预期。

Gemini 实测（DSH rc.4，Gemini 4 Argon，同一任务：嵌套两个子步骤读文件、关闭、再开一步修复并跑测试）：

| 内核 | 运行次数 | 正常完成 | Gemini 中途报错 | 测试修好 |
|---|---|---|---|---|
| 原版（`r4`、`r4b`、`r4c`、`r4d`） | 4 | 0 | 4 次运行都在中途失败 | 0 |
| PoC（`poc1`–`poc5`） | 5 | 5 | 58 次请求里 0 次 | 5 |
| 不装插件（`p4`、`p4b`，对照） | 2 | 2 | — | 2 |

PoC 每次运行都走了 Open、嵌套 Open、Next、Close、再 Open 修复、Close。从请求记录（`fetchlog-poc*/`）核对了排布：描述排在打开调用和它的工具结果之后；关闭的子节点只剩 memory，关闭调用不再出现。

和之前一样，样本不大，但对比很清楚：原版 4 次全挂，PoC 5 次全过。

## 要确认的点

1. **关闭采样里同时有别的工具调用**（比如 `spine_close` 和 `bash` 一起调）：按规则 2，`bash` 的结果会跟着折叠，模型来不及看到。建议 `spine_close`/`spine_next` 遇到同一步里还有别的调用时返回工具错误、不执行关闭，让模型下一步单独再调。内核已经禁止「关闭时同时回复用户」和「一步里多个结构操作」，这是同一类限制。PoC 没做这条。
2. **关闭后保留下来的回复**：排到 memory 后面的模型回复，前面的内容也变了，但它是纯文本，Gemini 不强制校验文本签名，不会报错。要完全一致，可以在挪位置时去掉签名和推理状态，只留文字。可选，不影响修这个错误。
3. **Spawn 子节点**：birth 已经排在 spawn 采样之后，符合规则 1。子节点自己的分配文本是开头的第一条，前面没有它的采样，应该没问题，请确认。
4. **Codex 宿主**：PoC 只在 Pi 和 DSH 上测了。Codex 也用同一个内核，需要跑一下 Codex 的测试，再做一次真实冒烟，确认模型照样正常使用节点。
5. Gemini 的 `skip_thought_signature_validator` 占位签名可以跳过校验，但会降低模型表现，只对 Gemini 有效。只当兜底，不进内核。

## 复现

- 之前的证据在 `evidence/`。DSH 测试目录在 C80 `/data/swe/FramePilot/cachetree/scaffold/spine-sdk-plugin/temp/null/20261029_dsh_e2e/`：
  - `run.sh`、`run2.sh`：一次 headless 运行；
  - `poc-batch.sh`：这次 PoC 的 5 次运行；
  - `logfetch.mjs`：预加载，记录 Gemini 的请求和响应正文，不记 header。
  - PoC 用的 DSH home 是 `home-poc4`：从 `home-rc4` 复制，把里面的 `@spinejit/spine-sdk`（`dist`、`wasm`）和 `@spinejit/dsh-spinejit`（`dist`）换成 PoC 构建。被换下来的文件在 `20261029_sigpoc/replaced/`。
- 重放：`GEMINI_API_KEY=… HTTPS_PROXY=http://127.0.0.1:11801 python3 -I evidence/replay.py evidence/004.req.json 5`。C80 上走代理用 11801 端口；Node 程序要加 `NODE_USE_ENV_PROXY=1`。

## 插件仓库目录

C80 `/data/swe/FramePilot/cachetree/scaffold/spine-sdk-plugin`，GitHub `GhabiX/spine-plugin`，main = `b599498`。

| 路径 | 内容 |
|---|---|
| `core-source.json` | 锁定的 spine-core 来源（SpineCodex 仓库、revision、子目录）。`developmentPath` 指向开发用的 SpineCodex worktree：`/data/swe/FramePilot/cachetree/tasks/spine_arrivals_core_20261027_1840/worktree`（分支 `spine-plugin/arrivals`） |
| `Cargo.toml` | 根 workspace；`spine-core` 按 path 依赖指向上面的 worktree |
| `crates/spine-wasm` | 把 spine-core 编译成 WASM 的 Rust crate |
| `packages/sdk` | `@spinejit/spine-sdk`：协议类型、Node 下的 WASM 运行时（`wasm/node`）、各宿主共用的控制层（`src/host/`）；节点描述等文本在 `src/host/render.ts` |
| `packages/host` | `@spinejit/spine-host`：宿主插件的最小契约和 Pi 会话适配 |
| `packages/plugin` | `@spinejit/pi-spinejit`：Pi 插件；`src/pi/navigation/` 是内置的 `/spine-tree` 浏览器 |
| `packages/dsh` | `@spinejit/dsh-spinejit`：DeepSeek Harness 插件，还没发布（bundle 清单 `cordis.patch.yml` 的改动还没提交） |
| `fixtures/conformance` | 跨宿主一致性的 golden 数据 |
| `scripts/` | `build-node-wasm.sh`（重建 WASM）、`verify-core-source.mjs`（核对内核源码和锁定的 revision 一致）、`verify-wasm-golden.mjs` |
| `doc/` | `DESIGN.md`、`ABI.md`、`OWNERSHIP.md`、`RELEASE.md` |

常用命令（仓库根目录，Node 22.23）：

```bash
npm install
npm test                     # sdk、host、pi-spinejit、dsh-spinejit
npm run check                # 构建加类型检查
npm run test:wasm-golden
# 重建 WASM：需要 CARGO_TARGET_DIR 和 WASM_BINDGEN（wasm-bindgen 0.2.127）；
# 脚本会先核对内核源码和 core-source.json 的 revision 一致，内核改动提交后更新 revision 再跑
npm run build:wasm-node
```

内核改完后插件这边要做：更新 `core-source.json` 的 revision，重建 WASM，更新 DSH 测试预期，跑全部测试，再用 Gemini 重跑 DSH 和 Pi 的实测。
