# Spine for Pi

[![npm](https://img.shields.io/npm/v/@spinejit/pi-spinejit)](https://www.npmjs.com/package/@spinejit/pi-spinejit) [![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

English | [中文](README.zh-CN.md)

**Your agent's context, shaped like its task.**

A long task is a tree of subtasks, but an agent's context is a flat log: finished work, dead ends, and the current step pile up in one stream, leaving the agent to guess where each piece of work begins and ends. Spine aligns the context with the task tree. The agent opens each subtask with a goal and closes it with a memory; Spine keeps the current subtask in full and automatically folds each finished one into its memory.

![The Spine tree in Pi: each step of the task, and the memory a finished step left behind](doc/images/spine-tree.png)

Less context, better results: in the Spine paper ([arXiv:2610.37224](https://arxiv.org/abs/2610.37224)), Pi with Spine scores 9.5–17.5% higher than plain Pi on SWE-Milestone; with Gemini 3.8 Flash, it also costs 45% less.

## Highlights

- **Explicit boundaries and state.** Every subtask has a goal, a start, and an end. The agent always sees the goals above it, the step it is on, and what finished steps found.
- **Managed automatically.** Closing a step shrinks the context—no separate summarizing pass. The agent writes the memory on the spot, while it still knows what mattered.
- **Your conversation stays, the cache keeps hitting.** Your messages and the agent's replies are kept, and everything before the current step stays byte-for-byte identical.
- **Subtrees in parallel.** `spine_spawn` hands a subtree to a child agent; its result comes back into the parent's tree.

## Install

```bash
pi install npm:@spinejit/pi-spinejit
```

That's it: start Pi 1.1.0 and the agent works in steps on its own. The tree above the input shows where it is; `/spine-tree` browses the tree and opens any step's memory. Details: [packages/plugin](packages/plugin/README.md).

Upgrading from `@spinejit/spine-plugin`: run `pi remove npm:@spinejit/spine-plugin` first.

## Also

- **Codex user?** [SpineCodex](https://github.com/GhabiX/SpineCodex) is Codex with Spine built in.
- **DeepSeek Harness:** a plugin is coming in [packages/dsh](packages/dsh/README.md).
- More Pi plugins from us: [pi-background-job](https://github.com/GhabiX/pi-background-job) (background jobs that wake the agent), [pi-btw-cached](https://github.com/GhabiX/pi-btw-cached) (`/btw` side questions on the same cache), [pi-compact-tree](https://github.com/GhabiX/pi-compact-tree) (a compact terminal tree), [pi-timeout-policy](https://github.com/GhabiX/pi-timeout-policy) (one timeout policy for every tool).

Building from source and design notes: [doc/DESIGN.md](doc/DESIGN.md). Apache-2.0.

<details><summary>Citation</summary>

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
