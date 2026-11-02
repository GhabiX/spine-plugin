# Handoff：Spine 上下文排布与 Gemini thoughtSignature

2026-10-29。本目录还有：`README.md`（方案 A 和 PoC 的详细说明、插件仓库目录）、`README.v1.md`（最早只讲 Open 一侧的版本）、`evidence/`（原始请求和响应、重放脚本）、`poc/`（方案 A 的 patch 和核对脚本）。

## 0. 接手方式

- 会话：跳板 `/root/jiahong` 下的 Claude Code 会话 `286ad1d6-b45d-432f-9503-b1cbb0778350`。
- fork：在跳板上 `cd /root/jiahong && claude --resume 286ad1d6-b45d-432f-9503-b1cbb0778350 --fork-session`。会话很长，前面压缩过几次；这份文档本身就是完整状态，fork 后可以先让它读这份文档。
- 所有工作都在 C80 上，经 `/root/jiahong/work` 执行；项目规则见 `/root/jiahong/CLAUDE.md`（不删文件，废弃物挪进 `/data/spinetree/temp/recyclebin/<时间>/`；不打印凭据；推送和发布前先问）。

## 1. 问题

DSH 插件（`@spinejit/dsh-spinejit`，未发布）用 Gemini 4 Argon 实测时偶发整轮失败，报 `Incomplete JSON segment at the end`，有一次是 `MALFORMED_RESPONSE`。原始响应显示 Gemini 在回复流中途返回 `400 INVALID_ARGUMENT`。不装插件跑同样的任务正常。

Pi 上同样的排布也会出错，但 Pi 会自动重试，把错误盖住了；DSH 不重试这类错误，所以整轮失败。

## 2. 已确认的事实

**Gemini 的规则**（官方文档 <https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures>）：

- "Strict validation is enforced for all function calls within the current turn."
- "Only current turn is required; we don't validate on previous turns."
- 「当前轮」从最近一条带普通内容（不是 functionResponse）的用户消息算起。
- 文本部分的签名不强制校验。
- 签名要按收到的样子原样传回。

**Spine 现在的排布**（内核 `spine-core/src/reducer.rs`，锁定版本 SpineCodex `9e956ba`）：

- Spine 插入的节点描述、memory、arrival 都是 user 文本。每插一条，在 Gemini 看来就开了新的一轮。
- **Open**：打开调用那次采样（模型的调用和工具结果）是子节点的第一条；`render_node()` 先输出描述，再输出子节点内容。于是描述排在打开调用之前，打开调用落在「当前轮」里，会被校验，而它生成时前面没有这条描述。
- **Next**：同上，新兄弟节点的描述排在 next 调用之前；上一个节点的 memory 也在它前面。
- **Close**：关闭调用那次采样留在父节点里，排在子节点 memory 之后。后面没有新的用户文本时，它在当前轮里，也会被校验，而它生成时前面是子节点的完整过程。

**证据**：

- 旧日志里，Open 时请求的最后几条是 `描述 → 带签名的 spine_open 调用 → 工具结果`。同样形状的请求有的成功有的失败（rc.2 的 004 失败，rc.4 的 004 成功），说明是偶发的。
- 重放 rc.2 的 004 号请求：原样 5 次成功 2 次；只把描述挪到调用和工具结果之后，4 次全成功；去掉全部签名直接 400。样本小，只算方向性证据。

## 3. 方案 A（已做 PoC）：新内容只追加在采样之后，关闭采样随节点折叠

做法：
- 描述变成节点的一条 entry，排在打开它的那次采样之后；
- Close 和 Next 那次采样归入被关闭的节点，一起折叠。

改动约 30 行，全在 `reducer.rs`。详细见 `README.md` 和 `poc/spine-core.patch`。

结果：
- 内核 72 条测试全过（改 1 条旧预期，新增 1 条排布测试）；
- 插件侧 SDK、host、Pi 全过；
- DSH 有 14 条测试写死了旧排布，逐条核对过都只是顺序变化，还没改；
- Gemini 实测：原版内核 4 次全挂，方案 A 5 次全过，58 次请求 0 报错。

**昆秋的顾虑是对的，方案 A 有实际代价**：5 次运行里，Gemini 每次都把 `spine_next` 和下一步的第一个动作（`read(test_api.py)`）放在同一次调用里。方案 A 把这次采样折叠进旧节点，`read` 的结果也跟着没了，模型下一次调用只好再读一遍。这在 5 次里都发生了。所以关闭采样随节点折叠这条改了归属，影响确实大：同一步里的其他调用结果会丢；要么丢，要么禁止混调，都要多花一步。

需要澄清一点：方案 A 对 Open 并没有改归属。打开采样仍属于子节点、随它折叠，只是描述的渲染位置从调用前挪到调用后。改了归属的是 Close/Next。

## 4. 方案 B（建议下一步试，还没做）：不改任何归属，只调渲染顺序

依据是第 2 节的 Gemini 规则：只有当前轮会被校验，而 Spine 的文本会开启新的一轮。所以只要**每次 Spine 转换的那次采样，后面紧跟着它产生的 Spine 文本**，这次采样就落进上一轮，不再被校验。之后的模型消息都是在新上下文里生成的，前缀本来就一致。

具体：
- **Open**：子节点渲染成 `打开采样 → 描述 → 其余内容`（和方案 A 相同）。
- **Next**：新兄弟节点同样渲染成 `next 采样 → 描述 → 其余内容`。上一个节点的 memory 仍在 next 采样之前。next 采样仍属于新节点，同一步里的 `read` 结果保留，不会重复读。
- **Close**：关闭采样仍留在父节点，但渲染顺序改成 `关闭采样 → 子节点 memory`。在模型看来就是「调用 spine_close → 工具返回 → memory」，读起来很自然，和 Open「调用 → 描述」对称。

实现草图：
- `render_node()` 对 Live/Opened 节点，先输出第一条 entry（Open/Next 的采样），再输出描述，再输出其余 entries；
- `close()` 把关闭采样插在父节点 entries 里 `Child(被关闭节点)` 之前，而不是之后（关闭时这个 Child 一定是父节点的最后一条，中间的东西都记在子节点里）。

不改归属，不改折叠语义，同一步里的其他调用结果都保留。

风险和要验证的：
- 方案 B 依赖 Gemini「只校验当前轮」这条文档规则。Next/Close 采样前面的内容仍然变了，只是不再被校验。
- 先用重放验证：拿方案 A 实测或旧日志里的请求，手工构造 B 的排布（Close 后 `关闭采样 → memory`、Next 后 `memory → next 采样 → 描述`），各重放若干次；
- 再按 `README.md` 的做法换 WASM 跑 DSH 实测 5 次，和方案 A 对比请求数和重复读取。

## 5. 其他备选

- **C. 只在 Gemini 适配层处理**：渲染时发现某条带签名的调用前面的内容变了，就把它的签名换成文档允许的占位值 `skip_thought_signature_validator`。不碰内核，但只对 Gemini 有效，文档说会降低效果；而且要在 Pi 和 DSH 两边的消息转换里各做一遍。
- **D. 宿主层重试**：遇到中途 `INVALID_ARGUMENT` 就重试。Pi 现在实际就是这样被掩盖的。问题还在，每次失败白花一次请求，不建议作为修法。

## 6. 其他进行中的事

- DSH 插件发布在等这个问题定下来。
  - `packages/dsh` 有未提交改动：`cordis.patch.yml`（关掉 compaction-basic、command-compact、tool-result-pruner、image-offload，插入 spinejit）、`package.json`（`dsh.bundle.patch`、keywords、files、`engines.dsh`）。
  - 之后还要：把 peer 依赖放宽到测过的范围（现在精确锁 rc.2）、`publish.yml` 加 dsh 选项、发布（首发可能要手动认证，待核实）、给 awesome-dsh-plugin 提 PR。
- `@spinejit/pi-spinejit` 0.1.3（内置 `/spine-tree` 浏览器）已 stage 到 npm，等批准，和这个问题无关。
- 插件仓库 main = `b599498`，已推送。

## 7. 位置速查（C80）

| 什么 | 在哪 |
|---|---|
| 插件仓库 | `/data/swe/FramePilot/cachetree/scaffold/spine-sdk-plugin`（GitHub `GhabiX/spine-plugin`） |
| 开发用内核 worktree | `/data/swe/FramePilot/cachetree/tasks/spine_arrivals_core_20261027_1840/worktree`，分支 `spine-plugin/arrivals`，HEAD `9e956ba` |
| 方案 A 的 PoC | `spine-sdk-plugin/temp/null/20261029_sigpoc/`：`codex/`（内核 worktree，分支 `poc/sampling-boundary`，未提交）、`plugin/`（插件 worktree，用 PoC 内核重建了 WASM）、`target/`（cargo 缓存）、`replaced/`（被换下的 SDK 文件） |
| DSH 实测 | `spine-sdk-plugin/temp/null/20261029_dsh_e2e/`：`run2.sh`、`poc-batch.sh`（5 次运行）、`poc-summ.sh`（汇总）、`summ.py`（列调用）、`logfetch.mjs`（记录 Gemini 请求和响应，不记 header）、`fetchlog-*/`、`out-*.json`、`ws-*/`；DSH home `home-rc4`（原版）、`home-poc4`（方案 A） |
| Pi 的同类请求 | `spine-sdk-plugin/temp/null/20261028_pi_e2e/replay/f4.json`（第 8、9 条） |

常用命令：

```bash
# 内核测试（在 PoC 内核 worktree 的 codex-rs 下）
CARGO_TARGET_DIR=<PoC>/target cargo test -p spine-core --offline --no-fail-fast
# 用改过的内核重建 WASM：PoC 里跳过了 verify-core-source（内核故意偏离锁定版本），手动执行 build-node-wasm.sh 里的 cargo build 和 wasm-bindgen 两步
# 插件测试（Node 22.23：PATH=$HOME/.nvm/versions/node/v22.23.2/bin:$PATH）
npm test
# DSH 测试按新排布核对旧预期
node --import <PoC>/reorder-check.mjs --test test/*.test.mjs
# Gemini 实测 5 次 + 汇总
bash poc-batch.sh; bash poc-summ.sh poc1 poc2 poc3 poc4 poc5
```
