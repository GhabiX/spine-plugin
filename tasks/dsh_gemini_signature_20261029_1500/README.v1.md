# Spine 上下文排布与 Gemini thoughtSignature 冲突

2026-10-29，交 SpineCodex（spine-core）维护者处理。

## 一句话

Spine 把节点描述 `<spine_node … status="opened">` 插在了**打开这个节点的那条模型消息之前**。Gemini 的模型消息带 `thoughtSignature`，签名对应的是模型生成这条消息时看到的上下文；事后在它前面插入内容，上下文就和签名对不上了。结果是 Gemini 偶发在回复流中途返回 `400 INVALID_ARGUMENT`。问题在内核的排布上，Codex、Pi、DSH 三个宿主共用这份排布。

## 现象

- DSH 插件（`@spinejit/dsh-spinejit`，还没发布）在 DSH 0.2.1-rc.2 和 rc.4 上用 Gemini 4 Argon 实测：嵌套步骤、spawn、恢复会话都能跑通，但多轮任务里偶尔整轮失败，报 `Incomplete JSON segment at the end`，有一次报 `MALFORMED_RESPONSE`。
- 不装插件的 rc.4 跑同样的任务两次都正常。
- 原始响应（`evidence/004.res.txt`）：流到一半出现 `400 INVALID_ARGUMENT: Request contains an invalid argument.`，后面跟一段不带 `data:` 前缀的 JSON；genai SDK 解析不了这段，于是报 Incomplete JSON segment。
- Pi 上没暴露，是因为 Pi 会自动重试，失败那次被盖住了；DSH 不把 `PI_AI_ERROR` 当可重试错误，所以整轮失败。

## 证据

失败请求 `evidence/004.req.json` 的 contents（`[sig]` 表示带 thoughtSignature）：

```
0 user   [U1] test_api.py fails; find out why and fix it. ...
1 user   Current runtime context ...
2 user   <spine_node id="1.1" ... status="opened">
3 model  text + functionCall:spine_open [sig]        ← 打开 1.1 的那次调用
4 user   functionResponse:spine_open
5 user   <spine_node id="1.1.1" ... status="opened">  ← 插在打开它的调用之前
6 model  text + functionCall:spine_open [sig] + functionCall:read
7 user   functionResponse:spine_open + functionResponse:read
```

第 6 条是 1.1.1 的打开调用。模型生成它时上下文止于第 4 条，现在它前面多了第 5 条。

把这个请求原样和改动后重放（顺序发，不并发；`evidence/replay.py`）：

| 变体 | 结果 |
|---|---|
| A 原样 | 5 次里 2 次成功，3 次流中途 INVALID_ARGUMENT |
| B 只把第 5 条挪到第 6、7 条之后 | 4/4 成功（第 5 次是本地代理断线，不算） |
| C 去掉所有签名 | 直接 400 |

B 说明只要描述不插在签名消息前面就正常；C 说明签名不能简单去掉。

Pi 的请求也是同样排布：`evidence/pi-f4.req.json` 第 8 条是 `<spine_node id="1.2" …>`，第 9 条才是打开 1.2 的 `spine_open [sig]`。

## 代码位置

内核版本按插件仓库 `core-source.json` 的锁定：SpineCodex `9e956ba188c768c2076c8e520b0e5de4007ba434`，`codex-rs/spine-core`。

- `src/reducer.rs` `open()`：打开调用的 span（模型的 spine_open 调用和它的工具结果）作为子节点的第一条 entry：`entries: vec![NodeEntry::Leaf(ContextItem::SourceSpan { span })]`。`next()` 对新的兄弟节点也是这样。
- `src/reducer.rs` `render_node()`：Live/Opened 节点先推 `ContextItem::SyntheticNode`（就是节点描述），再渲染 entries。两处合起来，描述就排到了打开调用前面。
- 描述的文本由插件 SDK 渲染：`packages/sdk/src/host/render.ts` `spineNodeText()`。这里只管文本，不管位置。

## 修复方向（建议，请从第一性核实）

原则：**每条模型消息都排在它生成时看到的上下文之后。**

最直接的改法：`render_node()` 先渲染子节点的第一条 entry（打开调用的 span），再推节点描述，然后渲染其余 entries。描述和打开调用都还在子节点里，节点关闭时一起折叠，看起来不影响折叠语义；新增的内容都在末尾，缓存前缀也不会变。下面几点需要你们确认：

1. Open、Next 两条路径都要改；Spawn 子节点的描述和分配文本是否有同样的问题。
2. 节点描述现在充当节点的「开头」，挪到打开调用之后，对模型读上下文有没有影响（描述里带着节点提示词）。
3. **关闭这一侧有类似形状，还没验证**：节点关闭后，它的 memory 排在后面带签名的模型消息之前（`pi-f4.req.json` 第 1 条 `<spine_memory node_id="1.1">`，第 2 条是带签名的模型回复）。这是折叠本身的结果，没法挪。这次失败只在打开一侧复现过。Gemini 是否只校验「当前轮」（最后一条用户文本之后）的签名，我们没有核实；如果是，关闭侧应该不受影响，但最好查官方文档或重放确认。
4. 不建议的做法：只在宿主层加重试（问题还在，每次白花一次请求）；在 pi-ai / DSH 的 Gemini 适配器里绕开签名（不是我们的代码，而且 C 变体说明不能简单去掉）。

改好后，插件仓库这边需要：更新 `core-source.json` 的 revision，重建 WASM，跑全部测试，再用 Gemini 重跑 DSH 和 Pi 的真实测试。

## 复现

- 证据都在本目录 `evidence/`。原始测试目录在 C80 `/data/swe/FramePilot/cachetree/scaffold/spine-sdk-plugin/temp/null/20261029_dsh_e2e/`，里面有 `run.sh`、`resume.sh`、`logfetch.mjs`（预加载，记录 Gemini 的请求和响应正文，不记 header）。完整记录见 `evidence/results.md`。
- 重放：`GEMINI_API_KEY=… HTTPS_PROXY=http://127.0.0.1:11801 python3 -I replay.py 004.req.json 5`。它跑 A、B 两个变体；C 是另外手动跑的。C80 上走代理用 11801 端口（11903 不通）；Node 程序要加 `NODE_USE_ENV_PROXY=1`。
- 失败是偶发的，重放 5 次左右能看到。

## 插件仓库目录

C80 `/data/swe/FramePilot/cachetree/scaffold/spine-sdk-plugin`，GitHub `GhabiX/spine-plugin`，main = `b599498`。

| 路径 | 内容 |
|---|---|
| `core-source.json` | 锁定的 spine-core 来源（SpineCodex 仓库、revision、子目录）。`developmentPath` 指向本机开发用的 SpineCodex worktree：`/data/swe/FramePilot/cachetree/tasks/spine_arrivals_core_20261027_1840/worktree` |
| `crates/spine-wasm` | 把 spine-core 编译成 WASM 的 Rust crate（`dto.rs`、`runtime.rs`、`validation.rs`） |
| `packages/sdk` | `@spinejit/spine-sdk`：协议类型、Node 下的 WASM 运行时（`wasm/node`）、各宿主共用的控制层（`src/host/`：controller、render、tools、spawn、children） |
| `packages/host` | `@spinejit/spine-host`：宿主插件的最小契约和 Pi 会话适配 |
| `packages/plugin` | `@spinejit/pi-spinejit`：Pi 插件；`src/pi/navigation/` 是内置的 `/spine-tree` 浏览器 |
| `packages/dsh` | `@spinejit/dsh-spinejit`：DeepSeek Harness 插件，还没发布（bundle 清单 `cordis.patch.yml` 的改动还没提交） |
| `fixtures/conformance` | 跨宿主一致性的 golden 数据 |
| `scripts/` | `build-node-wasm.sh`（重建 WASM）、`verify-core-source.mjs`（核对内核源码和锁定的 revision 一致）、`verify-wasm-golden.mjs` |
| `doc/` | `DESIGN.md`（设计说明）、`ABI.md`（SDK 和 WASM 的接口）、`OWNERSHIP.md`（各组件的职责划分）、`RELEASE.md`（发布流程） |

常用命令（仓库根目录）：

```bash
npm install
npm test                     # sdk、host、pi-spinejit、dsh-spinejit 全部测试
npm run check                # 构建加类型检查
npm run test:wasm-golden     # WASM 和 golden 对照
# 重建 WASM：需要设 CARGO_TARGET_DIR 和 WASM_BINDGEN（wasm-bindgen 0.2.127）
npm run build:wasm-node
node scripts/verify-core-source.mjs [另一个 SpineCodex checkout 的根目录]
```

## 当前状态

- 这个问题没修，等你们定方案。
- DSH 插件发布排在这个问题后面。
- Pi 插件 0.1.3（带 `/spine-tree`）已经 stage 到 npm，等批准，和这个问题无关。
