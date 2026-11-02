# DSH 插件真实模型测试（Gemini 4 Argon，2026-10-29）

## 环境
- DSH CLI rc.2 / rc.4 装在 rc2/、rc4/；pnpm 12.16.1 在 tools/；DSH_HOME = home-rc2 / home-rc4（home-plain4 不装插件，作对照）。
- 插件：packages/dsh 加 bundle 清单（cordis.patch.yml：关 compaction-basic、command-compact、tool-result-pruner、image-offload，插入 spinejit），`dsh plugin --profile headless add <tgz>` 安装。改动未提交。
- 模型：home patch 把 llm-pi-ai 加 google 路由（apiKeyEnv GEMINI_API_KEY），默认 google/gemini-4-argon high。key 用 Pi auth.json 的取 key 命令放进环境变量。
- 网络：NODE_USE_ENV_PROXY=1 + HTTPS_PROXY=127.0.0.1:11801（11903 不通）。run.sh / resume.sh 跑 headless --json；logfetch.mjs 预加载记录 Gemini 原始请求和响应；replay.py 重放。

## 结果
- rc.2 n3：嵌套步骤（1.1 → 1.1.1/1.1.2 → 1.2）全部正确，测试通过。
- rc.2 s1：spine_spawn 两个子 agent 并行，结果回到父 agent，修复通过。
- rc.2 n3b：--session-id 恢复会话，不读文件只凭记忆准确答出 1.1 结论。
- rc.4 r4/r4b/r4c/r4d、rc.2 n4：中途失败。前三次 `Incomplete JSON segment at the end`，r4d 为 MALFORMED_RESPONSE。
- 对照：rc.4 不装插件 p4/p4b 两次都正常。

## 根因
- 原始响应（fetchlog-rc2/004.res.txt）：Gemini 回复流到一半发来 `400 INVALID_ARGUMENT: Request contains an invalid argument.`，后面跟一段不带 `data:` 的 JSON，genai SDK 因此报 Incomplete JSON segment。
- 请求排布（004.req.json）：Open 的节点描述 `<spine_node id="1.1.1" … opened>` 是 user 文本，插在打开它的那条带 thoughtSignature 的模型消息之前。签名对应的是模型生成时看到的上下文，事后在它前面插入内容就改了这段上下文。
- 重放 004 号请求（顺序发）：A 原样 2/5 成功，3 次 mid-stream INVALID_ARGUMENT；B 把描述挪到该模型消息和它的 functionResponse 之后 4/4 成功（第 5 次是代理 EOF）；C 去掉签名直接 400。
- Pi 的请求排布相同（replay/f4.json 第 8、9 条），Pi 有重试所以没暴露；DSH 不把 PI_AI_ERROR 当可重试错误，整轮失败。rc.4 本身没问题。
