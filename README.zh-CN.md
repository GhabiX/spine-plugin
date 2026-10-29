# Spine for Pi

[![npm](https://img.shields.io/npm/v/@spinejit/pi-spinejit)](https://www.npmjs.com/package/@spinejit/pi-spinejit) [![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

[English](README.md) | 中文

**长任务，短上下文。** Spine 让你的 Pi agent 把每个已完成的步骤折叠成几行记忆。学到的结论留下，中途读过的数千行内容移出上下文。

```
不用 Spine，每次请求都要带上这些：
  cat src/cache.py            900 行
  cat tests/api_test.py     1,200 行
  pytest -x                   400 行日志

用了 Spine，完成的步骤只留一两行：
  ✓ 读 cache.py     warm() 是 async，没有任何地方 await 它
  ✓ 读测试          setUp 与缓存预热存在竞态
  ✓ 修复            setUp 现已 await warm()；40/40 通过
```

在 Spine 论文（[arXiv:2610.37224](https://arxiv.org/abs/2610.37224)）中，搭载 Spine 的 Pi 在 SWE-Milestone 上的得分比原版 Pi 高 9.5–17.5%；搭配 Gemini 3.8 Flash 时成本还降低了 45%。

## 亮点

- **Agent 自己记笔记。** 开启步骤、执行任务，趁还清楚重点时当场写下记忆并收尾。
- **对话完整保留。** 你的消息和 agent 的回复原封不动，只清掉中间的工作记录。
- **Prompt 缓存持续命中。** 当前步骤之前的所有内容保持逐字节一致。
- **子 agent 并行。** `spine_spawn` 同时运行多个子 agent，完成后各自把结果带回父节点。

## 安装

```bash
pi install npm:@spinejit/pi-spinejit
```

装完即可：启动 Pi 1.1.0，agent 会自动使用 Spine。它会获得四个工具：`spine_open`、`spine_close`、`spine_next` 和 `spine_spawn`。详见 [packages/plugin](packages/plugin/README.md)。

从 `@spinejit/spine-plugin` 升级：请先运行 `pi remove npm:@spinejit/spine-plugin`。

## 相关项目

- **Codex 用户？** [SpineCodex](https://github.com/GhabiX/SpineCodex) 是内置了 Spine 的 Codex。
- **DeepSeek Harness：** 插件即将上线，见 [packages/dsh](packages/dsh/README.md)。
- 我们的更多 Pi 插件：[pi-background-job](https://github.com/GhabiX/pi-background-job)（完成后唤醒 agent 的后台任务）、[pi-btw-cached](https://github.com/GhabiX/pi-btw-cached)（复用同一缓存的 `/btw` 旁路提问）、[pi-compact-tree](https://github.com/GhabiX/pi-compact-tree)（紧凑的终端树视图）、[pi-timeout-policy](https://github.com/GhabiX/pi-timeout-policy)（所有工具统一的超时策略）。

从源码构建与设计文档：[doc/DESIGN.md](doc/DESIGN.md)。Apache-2.0。

<details><summary>引用</summary>

```bibtex
@misc{xiang2026spine,
  title         = {Spine: Compiling Subtask Trees into Structured Context for Long-Horizon Coding Agents},
  author        = {Jiahong Xiang and Kunqiu Chen and Lingming Zhang and Yuqun Zhang},
  year          = {2026},
  eprint        = {2610.37224},
  archivePrefix = {arXiv}
}
```

</details>
