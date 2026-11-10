# DSH SpineJIT

SpineJIT context management for DeepSeek Harness (DSH), backed by the portable
Spine SDK. It is developed against `@deepseek-ai/dsh` `0.2.1-rc.2`; a bundle
loads it as the Cordis plugin `spinejit`.

## Install

Add the plugin to a DSH profile, then start that profile:

```bash
dsh plugin --profile web add @spinejit/dsh-spinejit
dsh web
```

`dsh plugin --profile <name> add` installs the package into `$DSH_HOME/profiles/<name>` and adds it to the profile's bundles. Its bundle patch disables `compaction-basic`, `command-compact`, `tool-result-pruner`, and `image-offload` (since Spine owns the context) and inserts the `spinejit` plugin. Verify with `dsh <name> --dump-config | grep spinejit`. For terminal use, add it to a profile that includes `@deepseek-harness-tui/dsh-tui`.

## How it works

- The model context is the DSH session surface. Each main-loop model request
  is one Spine sampling. In the log it runs from its marked slot (below) to the
  next sampling's slot or to the end of its step, and only that stretch
  decides it: completed if its response was logged whole, cancelled if the
  response was interrupted, failed if none was logged. A Stop after the
  response was logged does not change it. The plugin settles the open
  sampling before the next step and before a retried request; when it
  settles does not change the result.
- Before each request streams, the plugin appends two empty developer slots.
  They derive no model message and leave room for what the sampling puts in
  front of its response (a Next: the closed node's memory); nothing follows
  the response, since a node a call opens is described in that call's
  result. The first is marked
  (`source.sampling`): it records in the log where the sampling began.
- When the next step opens (`agent/request`), the plugin edits the surface into
  the plan the core last published, using standard surface replacements. The
  edits are a pure function of the surface and the plan (`src/projection.ts`),
  and the edited log restores with DSH alone, without this plugin.
- Folded node descriptors, memory and birth records are user messages with
  source `spine`. An opened node's descriptor is in the result of the
  `spine_open` or `spine_next` call that opened it. User messages get their `[U<n>]` number as they enter a step, in
  the logged message: DSH builds each request from the log right after logging
  the step's messages, with no point between to change what the model is
  sent. The web and desktop client show a user message without it (below).
- Host messages (the system prompt, tool registry changes and runtime context)
  are not Spine sources and stay where DSH puts them.
- Before a request streams, the plugin checks that the surface already shows
  the plan with the right user numbers, and refuses the request otherwise.
- A Spine tool call only checks its input. The sampling stages the call whose
  logged result is not an error, so a result another extension turns into an
  error (a `tools/post-execute` block) commits nothing. A model response may
  carry one Spine tool call; a second one is a tool error. A reply is a
  response that stopped by itself (a stream that ends without a finish chunk
  did) with text and no tool call; text cut off at max tokens is an ordinary
  assistant message.
- The session log is the only record of Spine state; the plugin writes no
  archive of its own. The tree records below only show the tree; nothing
  reads Spine state back from them. A resumed session settles each sampling over the same stretch
  of its log with the same code, or up to the end of the log. A
  session whose conversation started without this plugin is refused: its user
  messages carry no `[U#]`.
- Spawn: each child is a DSH subagent of its parent, started through the
  subagent service under the plugin's provider `spine`, so DSH owns its
  agent, capacity slot and teardown, and a host that waits for subagents
  (headless, for one) waits for it. Its seed is the parent's log just before
  the sampling whose Spawn bore it (session id `<parent>:spawn:<node>`). The
  step after a Spawn commits starts once its children are established. A
  child gets its assignment as a user message; its last reply is what it
  returns. It is judged each time it goes idle after a turn of its own, by
  the SDK's `childState` over its own log (the events after its
  inherited prefix): with every child of its own arrived, a last reply is
  completed with that memory and a turn that ended on a model error is
  errored with DSH's failure message; cancelled by its parent is aborted;
  idle with every child of its own arrived but neither is errored. After a
  restart the same rule reads the child's persisted log, and a child it
  does not end arrives aborted. A child DSH refuses to start, as past the
  active subagent limit, arrives errored with DSH's reason.
- An arrival is a user message the parent receives once, while its birth is
  open; it wakes the parent unless the parent was stopped. It is handed over
  on the child's idle, before DSH releases the child, so a host never sees
  a running parent done with an arrival still to come. Stopping the
  parent stops its children, whose aborted arrivals wait for the next turn. A
  Close or Next in the sampling that sees the last arrival is accepted: the
  commit joins the arrival first. A restarted parent receives a child that
  returned as completed and any other open birth as aborted, without waking.
- A forked session's inherited prefix is its parent's namespace: births the
  parent made there stay the parent's to join.

## The tree on screen

The tree Pi pins above its editor, drawn by the same code
(`@spinejit/spine-sdk/view`), once the agent has opened a task:

- In the terminal (dsh-tui), up to three status rows above the prompt, without
  the header, always including the cursor's row (`◉`). They show the
  top-level session (not a Spawn child) opened or changed most recently.
- In the web and desktop client, the whole tree in the conversation input
  dock (`dist/client.js`, built by `scripts/build-client.mjs`). The host
  appends a `plugin:spinejit/tree` record (`{cursor, nodes}`) to a session's
  log whenever what its tree shows changes, and the session projection
  `spinejit` serves the latest one to clients.

The web and desktop client also show each user message without the `[U<n>]`
line it starts with, as Pi does: `dist/client.js` registers a user-text rule
(`uiConversation.userText`) that hides it in the bubble. The log, the model's
context and the message's copy keep it. The terminal (dsh-tui) has no such
seam and still shows it.

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
