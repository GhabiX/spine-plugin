# Pi SpineJIT and Spine SDK

This directory is the source of the **SDK-backed** Pi/DSH Spine plugin. Daily
Pi should `pi install` `packages/plugin` from here. EvoClaw vendor copies must
be cut from a git commit of this repo, not a second tree. The separate native
Pi implementation is outside this package. Pi loads the compiled `dist` entry;
TypeScript source changes require the SDK, host, then plugin builds described
[below](#pi-extension). WASM rebuilding is required only for Rust/core changes.

## Published Pi installation

The public package is `@spinejit/pi-spinejit`. Users install one package; npm
resolves the matching SDK and host dependencies:

```bash
pi install npm:@spinejit/pi-spinejit
```

The source repository is
[`GhabiX/spine-plugin`](https://github.com/GhabiX/spine-plugin). Release
publishing is manual through the `Publish npm packages` workflow: select `plugin`
for `@spinejit/pi-spinejit`. Configure its npm Trusted Publisher entry before
using the workflow. SDK and host are published separately only when their
versions change. See [publishing and migration](doc/RELEASE.md#npm-publishing).

This repository is the portable Spine product boundary for Node agent hosts.
It packages one Rust semantic kernel behind a narrow WASM ABI, a TypeScript SDK,
one shared transaction controller, and explicit Pi and DeepSeek Harness plugin
entrypoints.

The canonical semantics remain in CacheTree's `doc/FormularDef.md`. The sole
current `spine-core` implementation remains in SpineCodex and is identified by
`core-source.json`; this repository never carries a copied reducer.

## Migrating from the old package name

`@spinejit/spine-plugin` has been renamed to `@spinejit/pi-spinejit`.
For a global installation, stop the current session, then run:

```bash
pi remove npm:@spinejit/spine-plugin
pi install npm:@spinejit/pi-spinejit
```

For a project installation, add `--local` to both commands. Restart Pi after
switching and load only one of these packages. Replace the package name in any
pinned settings or JavaScript imports; the exported subpaths are unchanged.
The SDK and host package names remain unchanged. Version `0.1.0` retains the
existing Pi `0.87.1` compatibility requirement; this rename does not establish
compatibility with Pi 1.x.

## Protocol pairing

The portable interface is `spine-sdk/v3`; its current context recipe is
`spine.context.plan.v2`. Recipes contain current ordered cells, while complete
historical memory stays in the semantic tree and typed archive. The recipe no
longer duplicates all historical memory alongside its visible cells.

Upgrade the TS SDK and packaged WASM together, rebuild dependent hosts, and
restart existing processes. Mismatched v1/v2 envelopes are rejected. Existing
Codex/Pi typed session records replay into v2 plans without rewriting the log;
saved v1 recipe snapshots are not accepted as v2. See the
[ABI contract](doc/ABI.md#current-plans-and-durable-history).

## Packages

- `crates/spine-wasm`: stateful, coarse Rust/WASM transaction binding.
- `packages/sdk`: `@spinejit/spine-sdk`, versioned DTOs and the ESM runtime.
- `packages/host`: `@spinejit/spine-host`, the minimal Pi Plugin Host contract
  for ownership, dependency order, namespaces, lifecycle, immutable event
  observation, private storage, and session requests.
- `packages/plugin`: `@spinejit/pi-spinejit`, shared controller plus the `./pi`
  entrypoint. The previous DeepSeek Harness adapter is archived in
  `archive/dsh_adapter_v0_20261027/`; a rewrite against current DSH follows.
- `archive/spinetree_plugin_20261027/`: the former `@spinetree/plugin`
  SpineTree coordination plugin, archived on 2026-10-27 together with its
  release gate. It depended on the old blocking Spawn and is no longer built.
- `fixtures/conformance`: host-neutral semantic traces.
- `tests`: native/WASM, recovery, and cross-host equivalence gates.

Pi and DeepSeek Harness history identifiers are transport metadata. They never
become Spine scope parents. Host adapters map typed evidence, persistence,
context publication, lifecycle, and child execution; they do not reduce Spine
state.

## Pi Plugin Host contract

Pi remains the outer host. `@spinejit/spine-host` is a thin contract inside
that host, not another process or runtime. `@spinejit/pi-spinejit` is the
single `spine.canonical` owner for Scope transitions, sampling, projection,
compaction, recovery, and Spawn. The host rejects duplicate owner slots and
namespaces, gives each plugin private storage, and orders activation by
manifest dependencies. The current contract only implements owner claims;
event observation and session requests are host services, not separate
capability kinds.

### Pi session requests

The optional `@spinejit/spine-host/pi` export provides
`createPiSessionAdapter(resolveSession)`. Supply a resolver for caller-owned
PiClient `SessionLease` objects, indexed by Pi session ID:

```ts
import { SpinePluginHost } from "@spinejit/spine-host";
import { createPiSessionAdapter, type PiSessionLease } from "@spinejit/spine-host/pi";

// Populate this map with active leases acquired by the application.
const leases = new Map<string, PiSessionLease>();
const host = new SpinePluginHost({
  sessions: createPiSessionAdapter(sessionId => leases.get(sessionId)),
});
```

The application owns PiClient connection, authentication, lease acquisition,
disposal and reconnection. The adapter checks the session ID and active lease,
then awaits `prompt(text)` or `steer(text)`. Successful resolution returns
`accepted: true`; a missing/inactive lease or a Pi command's `busy` or
`session_locked` error returns `accepted: false`. Other errors propagate
unchanged. The adapter adds no transport or connection lifecycle.

## Pi extension

`@spinejit/pi-spinejit` declares `./dist/pi/extension.js` in `pi.extensions`.
The same compiled module is exposed by `@spinejit/pi-spinejit/pi/extension`
and is included by the package's `files` list. Local directory and packed
installation therefore use the same entry through Pi's loader and host virtual
module support.

For Pi SDK development, run these commands from this repository's root:

```bash
npm run build -w @spinejit/spine-sdk
npm run build -w @spinejit/spine-host
npm run build -w @spinejit/pi-spinejit
pi install /absolute/path/to/spine-plugin/packages/plugin
```

Rebuild after TypeScript changes, then `/reload` or restart Pi and start a new
session. Install dependencies before building; the plugin depends on the matching
SDK/host packages and Pi 1.1.0 rather than bundling them. See the
[package guide](packages/plugin/README.md#pi-sdk-installation-and-updates).

It registers the four canonical tools, has no browsing slash commands, and
uses `@spinejit/spine-sdk/node` for the packaged WASM runtime.
Pi reads `packages/plugin/spine.toml` once per extension activation. The tool
catalog and default session runtime share that configuration snapshot; tree
navigation keeps it, while `/new` or reload activates the current disk version.
The text is passed to WASM as `configToml`. The file owns Pi's JIT text, node
text, and tool descriptions.
Editing these config fields does not require a WASM rebuild. Parameter-field
descriptions, including the shared `close`/`next` memory guidance, come from
`spine-core/src/tools.rs` and require rebuilding the packaged WASM. Pi's
incremental-memory policy is expressed in the node prompt and configured
`close`/`next` tool descriptions; the shared parameter schema is unchanged.
Hosts that
omit `configToml` still use the `spine-core` embedded default. Before each agent run, the extension's
`before_agent_start` hook extends Pi's assembled system prompt through this
configured runtime. Pi tool names are written in the toml. The extension does not
rewrite them or insert a second copy of the prompt.

Branch policy groups reading, analysis, and verification for one result. Open a
direct child when it needs independent work and can return a useful result;
answer sections and unchanged checks do not by themselves require new branches.
Root-first-open, direct ownership, completion before close/next, and sampling
semantics remain in effect. A user reply alone does not complete an obligation.

Runtime preserves user evidence and child memories. Parent memory adds new
synthesis, changed conclusions, remaining work, and evidence unique to that
branch, rather than copying child memories. Keep facts that would otherwise
leave with the branch's raw history. Node IDs can identify visible memory but
are not a history-retrieval API.

In interactive Pi TUI mode it renders a folded SpineCodex-style pretty tree as an
`aboveEditor` widget keyed by `spine-tree`, with one blank row below the tree
to separate it from the input border, refreshed only when the display
signature changes. A running Spawn child shows `◐` in the tree until its result arrives.
The optional [`@spinejit/spinetree-navigation`](packages/spinetree-navigation/README.md)
Pi extension adds `/spine-tree [node-id]`: navigate this same bottom tree and
read node memory above it. It works in regular TUI mode, without
modifying Pi or moving the execution cursor. The core alone retains the default
tree; the old print-only `/spine-tree` command is intentionally no longer registered.

The core is the sole widget owner. Navigation requests a copied read-only
snapshot through the versioned `spinejit:tree-view:v1` Pi event and temporarily
contributes a bounded view via `@spinejit/pi-spinejit/pi/tree-view`. Discovery
occurs when the command runs, so either extension load order works. View failures
stay inside the UI error boundary. Background publications update the default
tree while the browser holds its snapshot; releasing the view displays the latest
tree. This is an in-process extension contract, not a security sandbox.

Core-plan freshness skips repeated WASM previews when no source or sampling
state has changed. It does not cache the current Pi message view. Ordinary
requests and compact summaries synchronously materialize messages from the
published plan, the relevant branch snapshot, and existing source bindings.
Host context edits therefore take effect without inventing a source or commit;
closed scopes still expose only their returned memory. The publication path
also materializes messages, so this change does not establish a speedup.

Before recording an execution or starting Spawn children, the SDK calls the
pure `spine-core` validator through the WASM binding. The plugin does not copy
the canonical byte/count policy; it only shapes a child's result into an arrival
the core accepts (an oversized memory becomes an errored arrival). Pi's own child process stdout/stderr capture remains
owned by Pi and is outside this plugin boundary.

In SDK mode the Pi deployment profile must load Spine as the final and exclusive
context reducer and the exclusive compaction owner. A co-loaded SpineTree L1
artifact may select st mode at session startup instead; SDK tools are then hidden
and all SDK context/compaction/navigation hooks are inactive. Discovery and the
fixed per-session mode contract are described in the
[package guide](packages/plugin/README.md#spinetree--sdk-session-modes). The extension intercepts
`session_before_compact`, asks Pi's model registry for the summary, persists a
typed compact barrier and replacement messages, then publishes the new
projection before allowing Pi to append its acknowledgement entry. A native
compaction entry is accepted during recovery only when paired with the durable
Spine compact entry and marked `fromHook`; an unpaired or non-hook native
compaction fails closed.

Compact summary input, tools, preparation, and retained messages share the
event's branch snapshot. If the branch changes while the summary is pending,
the extension cancels the uncommitted compact and preserves the new tail.
Reload shutdown cancels an active operation before disposing the old runtime.
Offline real-Pi checks cover a pending context request; they do not establish
safety for every external asynchronous interleaving.

The current Pi entry and `pi-compact-fallback` 0.2.1 share the
`pi:compaction-owner:v1` check. SDK mode checks ownership at `session_start`,
after the mode responder is available. A competing owner produces a clear
`Pi compaction plugin conflict` error; experiment launchers must treat that as
an invalid configuration. St mode makes no SDK ownership claim. Subscriptions
belong to the extension runtime and are cleared on reload. Old fallback 0.2.0
bundles and old Spine builds are not covered. Rebuild and reload both entries;
a running process retains its loaded extension. Do not stack compaction owners
that do not implement this protocol.

Archive `durabilityId` is the persist key `archiveRecordId(record)`:
`attempt_id.value` on `sampling_started` and `commit_id.value` on
`sampling_commit`. `record_digest` is not the persist key; recovery accepts it
only as same-day compatibility when that field is present and equals
`durabilityId`. Overflow retry removes only the final retryable
`error`/`length` assistant from replacement context. If Pi aborts compaction
after Spine has completed, the extension faults and aborts the live session.
Assistant responses with `stopReason: "deferred"` are rejected because the
sampling contract only admits completed, failed, or cancelled terminals.
Committed input-token accounting records `input + cacheRead + cacheWrite` when
Pi provides safe non-negative values for all three components.
Session-start and session-tree recovery is generation guarded: a stale async
replay is disposed instead of replacing the runtime selected by the latest
session transition, and a new tree transition clears a prior lifecycle fault.

Spawn does not block the parent. `spine_spawn` is staged at `tool_call` like the
other Spine tools and returns an acceptance at once; the children start only
after `turn_end` commits their births, because the tool cannot wait for the
commit of its own turn. Each child inherits the parent's sampling-start session
prefix (`C_child = C_parent · Δ_child`), fixed at birth, by resuming a forked Pi
session file named by its birth id, then receives an identity/peer assignment
envelope. The child process loads the same discovered packages/extensions as a
normal Pi agent, keeps the parent's active tool allowlist plus typed
`spine_child_return`, and can use `spine_open` / `spine_close` / `spine_next` /
`spine_spawn`.

Each child's final result returns on its own as an arrival: a custom
`spine.arrival` message sent with `deliverAs: "steer"`, which starts a turn
when the agent is idle. The core admits it as an external input at the cursor
where it arrives, so it stays in context where the model first saw it and is
kept, with user messages and the agent's replies to the user, in the memory of
the node that closes over it. A completed arrival carries the child's typed
memory; an errored or aborted one carries only a diagnostic. `spine_close` and
`spine_next` are refused while a birth inside the node has not arrived, a child
cannot return while its own children are running, and compaction is cancelled
until every birth has arrived. Stop (an aborted agent run) cancels running
children; their aborted arrivals do not wake the agent. Without a UI (print and
JSON modes, and every child) the settled agent waits for a running child, whose
arrival starts the next turn.

With a UI, a failed child enters a per-child recovery prompt: `Continue` reuses
the same child session history, `Retry` starts a new attempt from the birth
prefix, and `Abandon` delivers the failure. `Continue` first validates the
existing session header, identity, and active branch through Pi's session
loader and Spine replay preflight. If the parent restarts, a child that had
already called `spine_child_return` is redelivered from its own session file
without running again; one that had not is offered `Continue` or `Abandon`
(only `Abandon` without a UI), since the birth prefix is not kept outside the
child session. Each producer is delivered at most once while it is unarrived.

## DeepSeek Harness extension

The previous adapter targeted an older DSH and the blocking Spawn receipt. It is
archived in `archive/dsh_adapter_v0_20261027/` and is being rewritten against
current DSH with the arrival semantics above.

## Development source

The workspace builds against the sibling SpineCodex checkout at the path
recorded in `core-source.json`, which also names the exact SpineCodex
`revision`. `node scripts/verify-core-source.mjs` checks that Cargo uses that
path and that `codex-rs/spine-core` plus the workspace files it inherits
(`codex-rs/Cargo.toml`, `codex-rs/rust-toolchain.toml`) equal that revision,
with no untracked or ignored files. Pass a checkout root to verify another
SpineCodex checkout. `scripts/build-node-wasm.sh` runs the check before and
after its locked Cargo build. The checked-in WASM is therefore determined by
this repository's commit and the core revision; bit-for-bit builds across
toolchains or directories are not claimed.

After generating a Node-targeted `spine_wasm.js` with the exact locked
`wasm-bindgen-cli` version, verify native/WASM equivalence with:

```bash
npm run test:wasm-golden -- /absolute/path/to/spine_wasm.cjs
```
