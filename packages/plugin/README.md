# Pi SpineJIT

SpineJIT context management for Pi, backed by the portable Spine SDK.
Install one package; npm installs the SDK and host dependencies automatically:

```bash
pi install npm:@spinejit/pi-spinejit
```

Version `0.1.0` is developed and tested against Pi `1.1.0`. The last state developed
against Pi 0.87.1 is tagged `pi-0.87-final`.

## Recommended Pi plugins

We also publish these Pi plugins, which work alongside this one:

| Package | Source | Description |
| --- | --- | --- |
| [`@spinejit/pi-background-job`](https://www.npmjs.com/package/@spinejit/pi-background-job) | [`GhabiX/pi-background-job`](https://github.com/GhabiX/pi-background-job) | Background jobs and output monitors for Pi: exits and new log lines wake the agent by themselves. |
| [`@spinejit/pi-btw-cached`](https://www.npmjs.com/package/@spinejit/pi-btw-cached) | [`GhabiX/pi-btw-cached`](https://github.com/GhabiX/pi-btw-cached) | /btw side questions for Pi: ask about the main session while it runs, on the same prompt-cache prefix; runs no tools, saves nothing to history. |
| [`@spinejit/pi-compact-tree`](https://www.npmjs.com/package/@spinejit/pi-compact-tree) | [`GhabiX/pi-compact-tree`](https://github.com/GhabiX/pi-compact-tree) | Compact process tree for Pi's terminal UI: tool calls fold into one-line summaries and thinking into titles, with a borderless input and a one-line footer. |
| [`@spinejit/pi-timeout-policy`](https://www.npmjs.com/package/@spinejit/pi-timeout-policy) | [`GhabiX/pi-timeout-policy`](https://github.com/GhabiX/pi-timeout-policy) | One timeout policy for Pi's foreground tools: 60s when unset, 2h at most, and timeouts for grep and find too. |

```bash
pi install npm:@spinejit/pi-background-job
pi install npm:@spinejit/pi-btw-cached
pi install npm:@spinejit/pi-compact-tree
pi install npm:@spinejit/pi-timeout-policy
```

## Migrating from @spinejit/spine-plugin

The public package is now `@spinejit/pi-spinejit`. Stop the current session,
then replace the old installation:

```bash
pi remove npm:@spinejit/spine-plugin
pi install npm:@spinejit/pi-spinejit
```

Use `--local` on both commands for project installations, then restart Pi.
Do not load both names together. Update pinned package settings and imports to
the new name; all exported subpaths remain available. SDK and host names stay
the same.

## Spine plugin prompt configuration

Pi loads its prompt configuration from `spine.toml` in `@spinejit/spine-sdk`,
the SpineConfig every host plugin shares. This file
overrides the embedded `spine-core` prompt defaults, so updating the shared WASM
artifact alone does not update Pi's configured wording.

Each extension activation reads one configuration snapshot for its tool catalog
and default runtime. Tree navigation reuses it; `/new` and reload read the file
again. A custom runtime factory remains responsible for its own configuration.

The default node body is empty. Each projected `<spine_node>` still includes
its identity, summary, and stable status; the global JIT prompt explains those
boundaries once. An explicit nonempty `prompt.node` remains supported. Tool
descriptions retain the operation and returned-memory guidance.

Pi and SpineCodex now use the v6 recursive-call policy: each branch owns an
outcome, Close returns one level, and new work begins under its direct owner.
The global policy and Open/Close/Next descriptions are synchronized, with host
tool names adapted. Node bodies remain empty; Spawn and parameter schemas are
unchanged. The v6 Pi training and unseen-task PoC passed the exercised ownership
and return cases; repeated memory and broader lifecycle coverage remain limits.

## Pi SDK installation and updates

This package is the SDK-backed Pi SpineJIT extension. Its Pi manifest and package
export both select `dist/pi/extension.js`, which is included in the package.
The native Pi implementation is a separate project.

From this repository's root, build the TypeScript packages in dependency order:

```bash
npm run build -w @spinejit/spine-sdk
npm run build -w @spinejit/spine-host
npm run build -w @spinejit/pi-spinejit
pi install /absolute/path/to/spine-plugin/packages/plugin
```

Users install only the Pi package; npm
resolves the matching SDK and host dependencies automatically:

```bash
pi install npm:@spinejit/pi-spinejit
```

Local directory installation and packed installation use the same compiled
entry. After source changes, rebuild these packages, then `/reload` or restart
Pi and start a new session. A `spine.toml` wording change needs extension
reactivation, but does not require a TypeScript or WASM rebuild. Normal Pi
0.87.1 `/new` also reactivates extensions; a tree navigation is not a reload.

The package depends on matching SDK and host packages and Pi 1.1.0. In a local
checkout, workspace dependencies must already be installed. A packed consumer
must resolve those dependencies too; the plugin tarball does not bundle them.
Spawn's default child invocation passes the currently loaded extension module,
so the formal `dist` entry is also the explicit child entry.

## SpineTree / SDK session modes

The same Pi configuration may load this package, navigation, and the SpineTree
L1/native artifact. At `session_start`, the plugin synchronously queries L1 on
`pi.events` channel `spinetree:mode` with `{ cwd, sessionId, mode? }`. Only L1
owns discovery; no responder means `sdk`. The decision is frozen for that
session. Creating a tree mid-session takes effect in a new session, not during
the current run. Both extension load orders are supported.

In `st` mode every `spine_*` tool is re-registered as `hidden`, so neither the
model nor codemode/`ctx.executeTool()` can reach it. SDK context, sampling,
compaction, ownership claims and navigation are inactive. Work uses shell `st`
and delegate/job workers; their branch caps are the results. In `sdk` mode the
existing SDK tools, context projection, compaction, Spawn and navigation remain
the active path. An SDK conversation is not migrated into a st conversation.

Compaction-owner conflict checking occurs at SDK `session_start`, after mode
selection, rather than factory activation; st sessions never claim SDK ownership.
A conflicting SDK compaction configuration is still invalid and must not run.

## Runtime composition

`extendSystemPrompt(base)` composes an original host base with enabled Spine
prompt sections. Pass the original base for every call, not an earlier composed
result. The host text is preserved as supplied, including any literal examples
of Spine tags. Pi's sampling hook receives fresh original system options and
performs this composition once for the request.

## Local development build

The development `spine-core` source is fixed by `core-source.json` as SpineCodex
revision `cb01f18b0113ada388b0ede69b36c1194513a240` plus the versioned patch
`provenance/spine-core-cb01f18.patch`. The declaration records the full core
file inventory and hashes, including prompt composition fixes and the v6
configuration. It does not claim those changes are in the upstream commit.

Build with the repository's `scripts/build-node-wasm.sh`, an explicitly selected
shared Cargo target cache, and `wasm-bindgen 0.2.127`. The script produces
`packages/sdk/wasm/node/spine_wasm*`, loaded by `packages/sdk/dist/node.js`.
The script verifies the declared source before and after its locked Cargo build.
See the repository README for source reconstruction. Build evidence is recorded
in `tasks/sdk_review_branch_e2e_20260928_1232/evidence/core-provenance/`.
No release or publication is implied by this local development build.

## Provider message ordering

Spine items stay at their projected positions in the conversation. Node
descriptors, memory, births and arrivals are Pi custom messages, which Pi sends
to every provider as user messages in place; kept replies are assistant
messages. None of them is a system message, so no provider moves them into the
initial system content, and opening a node only appends to the request. A
closed node shows its memory first, then the user messages, replies and
arrivals it keeps, so a kept reply never reads as an answer given without the
work behind it.

## Sampling boundary

One Spine sampling is one Pi agent-loop model request. It begins in the
`context` hook, after the request context is published and materialized, and
ends at `turn_end`, which Pi emits on every path, including run failures.
`before_provider_request` is not a sampling boundary: Pi's cache warmer replays
the last request with `maxTokens: 1` through that hook without a turn, while a
tool call runs (`cacheWarming: "streaming"`) or after the run settles
(`"idle"`). Spine leaves those replays alone.

## Durable message order

Pi 0.87.1 can persist context-only custom messages after a turn without calling
extension message handlers. Before admitting a user or custom steering/follow-up
message, the plugin admits that durable tail first. Context preparation also
reconciles the tail. This preserves source order across sampling commits and
recovery, including a silent custom update followed by a queued custom message.
Assistant and tool-result events retain normal sampling order; they do not
trigger full replay while Spawn terminal staging may still be uncommitted.
