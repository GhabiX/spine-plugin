# Spine for Pi

[![npm](https://img.shields.io/npm/v/@spinejit/pi-spinejit)](https://www.npmjs.com/package/@spinejit/pi-spinejit) [![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

English | [中文](README.zh-CN.md)

**Long tasks, short context.** Spine lets your Pi agent fold each finished step into a few lines of memory. What it learned stays; the thousands of lines it read along the way leave the context.

```
Without Spine, every request carries all of this:
  cat src/cache.py            900 lines
  cat tests/api_test.py     1,200 lines
  pytest -x                   400 lines of log

With Spine, each finished step is a line or two:
  ✓ read cache.py   warm() is async and nothing awaits it
  ✓ read the test   setUp races the cache warm-up
  ✓ fix             setUp now awaits warm(); 40/40 pass
```

In the Spine paper ([arXiv:2610.37224](https://arxiv.org/abs/2610.37224)), Pi with Spine scores 9.5–17.5% higher than plain Pi on SWE-Milestone; with Gemini 3.8 Flash, it also costs 45% less.

## Highlights

- **The agent writes its own notes.** It opens a step, does the work, and closes it with a memory written on the spot—while it still knows what mattered.
- **Your conversation stays.** Your messages and the agent's replies remain intact; only the working history goes.
- **The prompt cache keeps hitting.** Everything before the current step stays byte-for-byte identical.
- **Subagents in parallel.** `spine_spawn` runs child agents side by side; each result lands back in the parent when done.

## Install

```bash
pi install npm:@spinejit/pi-spinejit
```

That's it: start Pi 1.1.0 and the agent uses Spine on its own. It gets four tools: `spine_open`, `spine_close`, `spine_next`, and `spine_spawn`. Details: [packages/plugin](packages/plugin/README.md).

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
