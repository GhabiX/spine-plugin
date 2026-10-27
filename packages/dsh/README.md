# DSH SpineJIT

SpineJIT context management for DeepSeek Harness (DSH), backed by the portable
Spine SDK. It is developed against `@deepseek-ai/dsh` `0.2.1-rc.2` and is not
usable yet: the package loads as a Cordis plugin named `spinejit`, and the
context management lands in later commits.

Tests run the production DSH AgentLoop, session store and official JSONL
persistence with a scripted model adapter (`test/harness.mjs`), and load the
plugin through the Cordis Loader as a DSH bundle does.
