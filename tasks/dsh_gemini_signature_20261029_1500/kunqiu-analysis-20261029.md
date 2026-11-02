
# Gemini thoughtSignature / Spine 历史重排问题：三种修复方案验证报告

日期：2026-10-29

## 结论先行

当前证据支持：问题发生在 Spine 重建 Gemini 历史时，新的 `user` 节点说明被放到了已经生成的 model 函数调用和 thoughtSignature 前面。Gemini 重新划分 turn 后，旧函数调用可能被当作当前 turn 的调用，随后返回通用 `400 INVALID_ARGUMENT`；客户端把这个中断表现成 `Incomplete JSON`。

这是最合理的协议兼容性解释，但 Gemini 没有直接返回“signature mismatch”。也没有证据证明 thoughtSignature 是整个 context prefix 的哈希。

三种方案都做过真实验证，但验证层级不同：

- 方案 A：完整 Core 测试和 DSH 真实任务验证过，能绕过协议错误，但改变了 Spine 语义并造成混调结果折叠问题。
- 方案 B：固定请求、DSH、Pi、resume/fork 都验证过，是当前最小影响的候选方案。
- 方案 C：现在已直接用 Gemini 真实请求验证，assistant 角色放在原注释位置并不会被 API 必然拒绝；全部注释改成 assistant 的 Open/Next/Close 各 2/2 正常返回。但它尚未做完整 DSH 任务验证，而且会把宿主生成的历史说明伪装成模型输出，需要单独评估语义风险。

建议优先继续方案 B；方案 C 不应再被描述为“已证明非法”，但也不能在没有任务级验证前作为默认方案。

## 1. Bug 背景

1. Spine 在重建 Gemini 请求历史时，会把 Open、Next、Close 的节点说明或 memory 作为新的 `user` 内容插入历史。
2. 有时，这条新 `user` 内容位于已经生成的 model 函数调用和 `thoughtSignature` 之前。
3. Gemini 以普通 `user` 内容划分当前 turn，并对**当前 turn** 的函数调用做严格校验，因此重组后的历史可能触发 `400 INVALID_ARGUMENT`，客户端随后报告 `Incomplete JSON`。

## 2. Bug 原因 

以下三个原因同时成立，方可有概率触发 bug

  1. Open、Close 等操作在 pre sampling 位点植入了新的 user message。
  2. 当前 sampling 中的 thought message 仍属于最新的 user turn，因此需要进行签名校验。
  3. 当前 sampling 中的 thought message 附带的签名不匹配新植入的 user message。

## 3. 真实请求如何出错

原始请求简化如下：

```text
Gemini 预期：
  user: 用户请求，签名为 S
  model-sampling：spine_open + read + signature S # 旧调用, S 不匹配新加入的 user

Spine 重建为：
  user: 用户请求，签名为 S
  user: Open 节点说明           # 新插入
  model-sampling：spine_open + read + signature S # 旧调用, S 不匹配新加入的 user

```

这条说明是在旧调用生成以后才出现的，但被放到了旧调用之前。该请求随后收到 `400 INVALID_ARGUMENT`，流中断后客户端显示 `Incomplete JSON`。

## 4. 三种修复方案对照

| 方案 | 实际改法 | 实际验证 | 已发现缺陷 | 结论 |
|---|---|---|---|---|
| A. 全局 post-sampling | 把 Open/Next/Close 植入的 message 移到 post-sampling，破坏 bug 原因 1、2、3 | Core 72 条测试通过；DSH 方案 A 实测 5 次任务、58 次请求，无 Gemini 协议错误 | 改变 Core 的有序消息投影和节点折叠；5 次都出现 `Next + read` 同批结果随归属折叠，后续发生重复读取；DSH source-order 反例会破坏宿主 surface invariant；所有 provider 都会受影响 | 协议层能绕过错误，但语义代价已实测，不作为默认修复 |
| B. Gemini adapter 加边界 | 在 post-sampling 添加额外 user message，破坏 bug 原因 2      | 固定历史重放 30/60 → 58/60；DSH 任务 2/5 → 5/5；Pi 当前 Core resume/fork 8/8；混调工具结果保留 | 不修复旧 signature，只改变 turn 边界；每条可见边界约增加 27 token；需要 durable `sampling_commit`、resume/fork 重建和幂等；Spawn/compact/cancel/warming 尚未覆盖 | 当前最小影响、证据最完整的候选方案 |
| C. message 改 assistant/model | 将植入的 message 从 `user` role 改为 `model` role，破坏 bug 原因 1、2、3 | 直接 Gemini 请求验证：只改最新注释时 Open 2/2、Next 2/2、Close 1/2 正常；另一次 Close 为网络超时；把 fixture 中全部 Spine node/memory 改为 model 时 Open 2/2、Next 2/2、Close 2/2，全部 HTTP 200/STOP；FC/FR 输入记录保持不变，输出仍为合理的 `spine_next/read` 或 `spine_close` | 这会把宿主生成的说明伪装成模型已经说过的话；可能改变模型对历史的理解和 thought 续接；没有开始新的 user turn，不能直接复用方案 B 的机制；尚未做完整 DSH 任务、resume/fork、compact 验证；如果把 model 放在请求末尾则 API 明确拒绝，但这不是本方案的正确构造 | 已证明“不是 API 必然非法”，但尚未证明任务语义安全；需独立任务级验证后再决定 |

## 5. 推荐方案 B ：实际排列

```text
user：读取 cache.py 的节点说明
model：spine_open + read(cache.py) + signature S
user：两个工具结果
user：上下文已经更新，请继续
```

方案 B 不修复 `S`，也不删除旧 thought。它只让旧 FC/FR 位于新的普通 user 边界之前，使下一次模型输出从新的 turn 继续。

