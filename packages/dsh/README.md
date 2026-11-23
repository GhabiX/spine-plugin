# DSH SpineJIT

SpineJIT context management for DeepSeek Harness (DSH), backed by the portable
Spine SDK. Version `0.1.4` is developed against DSH `0.2.2-rc.5` and also
validated against `0.2.1-rc.2`; a bundle loads it as the Cordis plugin `spinejit`.
Development uses Cordis `~4.1.0` and Loader `~1.1.0`; the peer range also
accepts Cordis `~4.0.5` for the older host. Other DSH releases are not claimed.

## Install

Add the plugin to a DSH profile, then start that profile:

```bash
dsh plugin --profile web add @spinejit/dsh-spinejit
dsh web
```

`dsh plugin --profile <name> add` installs the package into `$DSH_HOME/profiles/<name>` and adds it to the profile's bundles. Its bundle patch disables `compaction-basic`, `command-compact`, and `tool-result-pruner` (since Spine owns structural context changes) and inserts the `spinejit` plugin. Native `image-offload` is left at the host/user setting: it marks individual images without moving Spine sources, so over-budget requests can recover. An explicit user disable remains respected. Verify with `dsh <name> --dump-config | grep spinejit`. For terminal use, add it to a profile that includes `@deepseek-harness-tui/dsh-tui`.

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
  `spine_open` or `spine_next` call that opened it.
- The model sees each user message with its `[U<n>]` number in front, as in
  Pi; the user does not. The logged message, which every client draws, stays
  as the user wrote it. When a step opens, the plugin logs the numbers of the
  user messages it carries in an ignorable `plugin:spinejit/user-anchors`
  record, and a message projection puts each number in front of the message
  the model reads, alike for a live session, a resumed one and a fork. DSH
  builds a step's request from the log right after logging its messages, with
  no point between, so that first request shows a new user message as the user
  wrote it; every later request shows it numbered. Sessions logged by
  dsh-spinejit 0.1.1 and earlier carry the number in the message text and
  resume as they are.
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
  messages were answered unnumbered.
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
- Ordinary Forks need not record `parentSession`. Each inherited segment is
  replayed in a stable namespace, then continued in the new session's namespace;
  inherited births stay with their original owner. Pending user sources and
  synthetic Fork tool results are observed before the recovered plan is applied.
- A child waiting for descendants retains its activation until input or Stop.
  Stop also cancels accepted Spawn work that has not started yet: it records
  aborted arrivals without starting children or waking the stopped parent.
- Plugin reload reattaches existing agents, drains old child writers before
  reading results, and preserves claimed arrivals across rejected steps.
- Context replacements preserve individual slots for later summaries and log
  token shadow prices. Input accounting includes uncached, cache-read and
  cache-write tokens, which DSH reports as disjoint counts.

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

Empty Spine developer markers and reserved slots are hidden from Chat only;
other events and the model context are unchanged. User text is never stripped
just because its first line looks like `[U<n>]`. Legacy inline-anchor sessions
remain readable, but their old inline numbers may remain visible in bubbles.

## Not yet

- A Spawn child that fails is not retried or continued; its arrival says why.
- Spine tools must be called by the model directly, not from code (PTC).
- Plugins that delete, move or summarize conversation sources (compaction and
  tool-result pruning) must not run alongside Spine. Native image offload is
  compatible; it preserves source identity and order.
- This reliability release does not add private checkpoint WASM, a replacement
  Web preset/compact command, read-only Spawn UI, or the redesigned tree UI.

## Tests

Tests run the production DSH AgentLoop, session store and official JSONL
persistence with a scripted model adapter (`test/harness.mjs`), and load the
plugin through the Cordis Loader as a DSH bundle does. Each scenario also
checks that the official JSONL restore, without the plugin, equals the live
context. The 83 tests cover images, ordinary/truncated Forks, pending-source
recovery, literal user anchors, context slots, cached usage, nested Spawn,
Stop races, and plugin reload, including parked results claimed by rejected
steps after background recovery. These are scripted headless tests, not a
browser layout or paid-model end-to-end claim.

From the workspace root:

```bash
npm install
npm run check
npm run build
npm test
# Fresh absolute output directory; no dependency symlinks or --force.
npm run test:hosts -w @spinejit/dsh-spinejit -- /absolute/fresh/dsh-host-matrix
npm pack -w @spinejit/dsh-spinejit --dry-run
```

The matrix installs each actual host with its matching Cordis/Loader, asserts
resolved host versions, then checks, builds and tests the same source. CI runs
it on Node `22.19.0` and `25`. Reliability fixes were contributed by
[wxh (kabxx)](https://github.com/kabxx); upstream authorship is preserved in
commit trailers.

When upgrading an existing profile, check `--dump-config` for a leftover
explicit `image-offload` disable. Removing this bundle's override does not
undo a separately saved user setting. Checkpoint and Web preset migrations
are deliberately outside this release.
