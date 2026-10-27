# DSH SpineJIT

SpineJIT context management for DeepSeek Harness (DSH), backed by the portable
Spine SDK. It is developed against `@deepseek-ai/dsh` `0.2.1-rc.2`; a bundle
loads it as the Cordis plugin `spinejit`.

## How it works

- The model context is the DSH session surface. Each main-loop model request
  is one Spine sampling. It settles at the next pre-step, at turn-stopping, at
  a request error, or when the agent is disposed (a cancelled turn reaches
  neither hook). The log decides the outcome: cancelled if the turn aborted,
  completed if a response was logged, failed otherwise.
- Before each request streams, the plugin appends two empty developer slots.
  They derive no model message and leave room for what the sampling's Open,
  Close or Next puts in front of its response.
- When the next step opens (`agent/request`), the plugin edits the surface into
  the plan the core last published, using standard surface replacements. The
  edits are a pure function of the surface and the plan (`src/projection.ts`),
  and the edited log restores with DSH alone, without this plugin.
- Node descriptors, memory and birth records are user messages with source
  `spine`. User messages get their `[U<n>]` number as they enter a step, so the
  transcript shows it too.
- Host messages (the system prompt, tool registry changes and runtime context)
  are not Spine sources and stay where DSH puts them.
- Before a request streams, the plugin checks that the surface already shows
  the plan with the right user numbers, and refuses the request otherwise.
- Spine tools only stage their operation, and a model response may carry one
  Spine tool call; a second one is a tool error. Archive records are stored as
  `plugin:spinejit/archive` session records.

## Not yet

- Resuming a session is refused until recovery lands; Spawn is not enabled.
- Spine tools must be called by the model directly, not from code (PTC).
- Plugins that rewrite conversation context (compaction, tool-result pruning,
  image offload) must not be loaded with this one. Spine owns the context; a
  rewritten source makes the plugin refuse the next request.

## Tests

Tests run the production DSH AgentLoop, session store and official JSONL
persistence with a scripted model adapter (`test/harness.mjs`), and load the
plugin through the Cordis Loader as a DSH bundle does. Each scenario also
checks that the official JSONL restore, without the plugin, equals the live
context.
