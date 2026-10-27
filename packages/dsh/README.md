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
  Close or Next puts in front of its response. The first is marked
  (`source.sampling`): it records in the log where the sampling began.
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
  Spine tool call; a second one is a tool error. A reply is a response that
  stopped by itself with text and no tool call; text cut off at max tokens is
  an ordinary assistant message.
- The session log is the only record of Spine state; the plugin writes no
  archive of its own (DSH reserves plugin records for its own experimental
  packages). Where each sampling began, the Spine call whose result was not an
  error and what the log shows of the response decide every commit. A resumed
  session runs the same lifecycle over its log: a sampling settles before the
  next request, step or turn, as it did live, or at the end of the log. A
  session whose conversation started without this plugin is refused: its user
  messages carry no `[U#]`.
- Spawn: each child is a subagent in the same world, forked from its parent's
  log just before the sampling whose Spawn bore it (session id
  `<parent>:spawn:<node>`). It gets its assignment as a user message and ends
  by calling `spine_child_return` once, after its own children have arrived.
  A child is judged each time it goes idle: returned is completed, cancelled
  by its parent is aborted, and idle with every child of its own joined but
  no return is errored.
- An arrival is a user message the parent receives once, while its birth is
  open; it wakes the parent unless the parent was stopped. Stopping the
  parent stops its children, whose aborted arrivals wait for the next turn. A
  Close or Next in the sampling that sees the last arrival is accepted: the
  commit joins the arrival first. A restarted parent receives a child that
  returned as completed and any other open birth as aborted, without waking.
- A forked session's inherited prefix is its parent's namespace: births the
  parent made there stay the parent's to join.

## Not yet

- A Spawn child that fails is not retried or continued; its arrival says why.
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
