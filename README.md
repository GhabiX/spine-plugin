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
[`GhabiX/spine-sdk-plugin`](https://github.com/GhabiX/spine-sdk-plugin). Release
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
`core-source.json`; this repository never carries a copied reducer. The
[release gate](doc/RELEASE.md) states which SpineTree paths are usable and
which remain experimental.

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

The portable interface is `spine-sdk/v2`; its current context recipe is
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
- `packages/plugin`: `@spinejit/pi-spinejit`, shared controller plus `./pi`
  and `./deepseek-harness` entrypoints.
- `packages/spinetree-plugin`: `@spinetree/plugin`, an ordinary Pi project
  coordination plugin. It owns only the `spinetree` namespaces and does not
  replace the canonical Spine context or sampling owner. Its `spinetree_read`
  tool becomes a real, fixed-HEAD read when the factory receives an explicit
  snapshot store or `.spinetree` root adapter. An explicit change-capable store
  also enables `spinetree_change`, which applies immutable ProjectBranch
  updates through `expectedRevision` from `spinetree_read`. The Git store still
  uses expected-HEAD CAS internally. `GitSpineTreeStore`
  provides the explicit filesystem adapter: `initialize()` creates a
  `.spinetree` Git repository, snapshots are committed as immutable
  `state.json` objects, and `git update-ref` performs expected-HEAD CAS. The
  default factory remains contract-only and creates no workspace state.
  Explicit registry and mailbox adapters additionally enable `spinetree_send`:
  v2 validates AgentId addresses and only enqueues. Explicit caller-driven
  dispatch leases receipts and calls `sessions.request`; send never waits for
  the recipient prompt. See the [message contract](packages/spinetree-plugin/README.md#queued-messaging-and-observation).

  A mailbox that also exposes `receipt()` enables `spinetree_observe`. The
  caller supplies `{ receiptId, agentId, leaseId? }`; the plugin resolves that Agent,
  checks that the receipt's `to` field names the same Agent, and then performs
  the mailbox's idempotent `observed()` transition. This is an explicit
  recipient acknowledgement, not an automatic consequence of Pi accepting a
  prompt. The Host contract has no caller identity field, so the declared
  `agentId` is checked against the registry but is not a transport-level
  authentication mechanism. In-prompt observation requires the envelope leaseId.
  Queued/failed receipts, wrong recipients and stale tokens return typed errors.

  Registry and mailbox persistence use the same immutable snapshot and HEAD as
  the ProjectBranch tree. The application creates and initializes one
  `GitSpineTreeStore`, then passes adapters built from that store to the plugin:

  ```ts
  import {
    GitSpineTreeAgentRegistry,
    GitSpineTreeMailbox,
    GitSpineTreeStore,
    createSpineTreePlugin,
  } from "@spinetree/plugin";
  import { SpinePluginHost } from "@spinejit/spine-host";

  const store = GitSpineTreeStore.initialize("./.spinetree", initialSnapshot);
  const host = new SpinePluginHost({ sessions });
  host.register(createSpineTreePlugin({
    store,
    registry: new GitSpineTreeAgentRegistry(store),
    mailbox: new GitSpineTreeMailbox(store),
  }));
  ```

  `registry` and `mailbox` are written into the committed snapshot fields of
  the same Git history. Each mutation reads the current HEAD and publishes with
  expected-HEAD CAS; a concurrent writer is retried against its new snapshot,
  while an exhausted retry budget returns a typed stale-head error. The plugin
  never creates `.spinetree`, starts a Git process on its own, or turns the
  host's private storage into persistence.

  This CAS is also the cross-process ownership boundary. Two registry or
  mailbox writers may read the same HEAD, but only one expected-HEAD update can
  publish; the loser reloads the winning snapshot and retries its semantic
  mutation. A mailbox lease therefore has one committed owner at a time. An
  expired lease is reclaimed with a new lease ID, and the old token cannot
  acknowledge delivery. Exclusive registry registration applies the same rule
  to active Agent ownership of a ProjectBranch. These guarantees do not add a
  lock file or background coordinator; they rely on Git ref atomicity and the
  bounded retry policy.
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
compaction, recovery, and Spawn. `@spinetree/plugin` is an ordinary contributor
that exposes `spinetree_*` tools and a namespaced status command. Without
explicit adapters its tools remain contract-only. The host rejects duplicate
owner slots and namespaces, gives each plugin private storage, and orders
activation by manifest dependencies.
The current contract only implements owner claims; event observation and
session requests are host services, not separate capability kinds. The
SpineTree plugin's in-memory change store and registry/mailbox remain testable
adapter boundaries. `GitSpineTreeStore` is an explicit Git-backed
`.spinetree` persistence adapter; no Pi launcher creates or attaches one by
default.

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

With explicit SpineTree adapters, `spinetree_send` persists a queued receipt and
returns. `dispatchSpineTreeMailbox({ registry, mailbox, sessions, limit })` selects
a bounded batch of due queued receipts or expired leases and routes them to Pi.
Prompt text is a `spinetree.message/v1` JSON envelope containing receiptId,
leaseId, to, from and the original message. A recipient can observe with this
identity and enqueue a reply while its prompt is still running. Replies wait for
a subsequent dispatcher pass; there is no nested prompt call from send.

The adapter's `accepted` still means prompt completion. Without observation,
success marks delivered, rejection/transient errors requeue, and errors marked
`permanent: true` fail. Once observed, later results for the same token return the
observed state unchanged. Old lease tokens cannot acknowledge a newer attempt.
Missing/ended Agents fail; lease acquisition races are reported in `skipped`.

The caller owns dispatcher scheduling and timeout policy. Long prompts exceeding
the lease interval or lost acknowledgements can cause duplicates. requestId only
deduplicates local enqueue; Pi prompt commands have no remote dedupe field. The
adapter never marks observed itself. Tests use simulated leases; project task
smokes also exercise official Unix/CBOR transport with deterministic runtimes,
not production model behavior. Details and migration from send v1 are in the
[message contract](packages/spinetree-plugin/README.md#queued-messaging-and-observation).

`spinetree_rejuvenate` is enabled only with an explicit snapshot store, a
registry that exposes `list()` and `registerExclusive()`, and a caller-owned `rejuvenator.provision`
adapter. It validates that `{ parent, branch, request? }` names an existing
`capped` branch, that `parent` is the branch itself or an ancestor, and that
no active Agent is already bound to the branch. The provisioner receives
detached branch data plus the effective inherited context and owns Pi session
creation, transport, initial prompt, and cleanup. Its returned binding is
registered through the same registry; the result is
`spinetree.rejuvenate.result/v1`. There is no implicit Pi process creation or
cross-layer transaction, so a registry failure after external provisioning is
reported for the caller to clean up. Without all explicit adapters the tool
remains contract-only.

Agent lifecycle is an explicit registry concern. `MemoryAgentRegistry` and
`GitSpineTreeAgentRegistry` expose `transition(agentId, status)` with the
matrix `running -> running|paused|ended`, `paused -> paused|running|ended`,
and `ended -> ended`. A transition changes only `status`; binding identity is
kept intact. Missing agents return `unknown-agent`, and recovering an ended
agent returns `invalid-transition`. The project POC wires this operation only
when `spinetree.agent` is supplied: canonical `onSessionReady` registers a
`running` binding and the caller-owned `session_shutdown` hook marks it
`ended`. Session creation, lease ownership, transport, disposal, and
reconnection stay outside the plugin.

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
pi install /absolute/path/to/spine-sdk-plugin/packages/plugin
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
signature changes. `spine_spawn` streams per-child status on the tool row.
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
the canonical byte/count policy; it only keeps terminal-receipt checks needed
after child work returns. Pi's own child process stdout/stderr capture remains
owned by Pi and is outside this plugin boundary.

The Pi deployment profile must load Spine as the final and exclusive context
reducer and the exclusive compaction owner. The extension intercepts
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
`pi:compaction-owner:v1` activation check. If both are configured, whichever
loads second is rejected before registering tools or hooks, with a clear
`Pi compaction plugin conflict` error. Pi can continue with the first plugin;
experiment launchers must treat loader errors as an invalid configuration.
Subscriptions belong to the extension runtime and are cleared on reload.
This requires both updated entries: old fallback 0.2.0 bundles and old Spine
builds are not covered. Rebuild and reload both entries to use that check; a
running process retains its loaded extension. Do not stack other compaction
owners that do not implement this protocol.

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

Spawn children inherit the parent sampling-start session prefix (`C_child =
C_parent · Δ_child`) by resuming a forked Pi session file, then receive an
identity/peer assignment envelope. The child process loads the same discovered
packages/extensions as a normal Pi agent, keeps the parent's active tool
allowlist plus typed `spine_child_return`, and can use `spine_open` /
`spine_close` / `spine_next` / `spine_spawn`. Nested spawn is hang-until-join in
the child process, matching SpineCodex child `spine.spawn`. Children still
return through `spine_child_return`; missing or duplicate returns mark that
child `errored` with a diagnostic μ and do not abort siblings. Pi can replay a
fully committed Spawn and verifies its durable per-child staging. If Pi crashes
after staging child terminal memory but before persisting the parent tool result
and turn commit, the extension fails closed on restart: Pi currently does not
expose a recovery-time native tool-result finalization API.

While the parent Pi process remains live, a root TUI/RPC Spawn with failed child
terminals enters a batch-level recovery gate. The user can choose `Continue` to
reuse the same child session history, `Retry` to create a new attempt session
from the frozen parent prefix and assignment, or `Abandon` to return the mixed
receipt. Successful ordinals are never rerun, and terminal staging is deferred
until the batch reaches a final decision so each ordinal is staged once. The
gate is serialized by Pi's `executionMode: "sequential"`; `Continue` first
validates the existing session header, identity, and active branch through Pi's
session loader and Spine replay preflight. If the session is valid but the
assignment is absent from the branch, the continuation carries the frozen
assignment once as a context fallback; an invalid session or an uncommitted
nested Spawn staging entry removes `Continue` from the choices and leaves
`Retry`/`Abandon`. Child launch/API errors and prefix, validation, or staging
invariant failures remain host-fatal rather than being hidden as retries.
print/JSON and nested child modes keep the headless one-shot behavior. This
live-parent recovery does not recover an in-flight Spawn after the parent
process has restarted.

## DeepSeek Harness extension

`@spinejit/pi-spinejit/deepseek-harness` binds directly to the public
`Session` and `SessionStore` contracts. It registers strict versioned codecs
for `spine/archive` and `spine/spawn-terminal`, publishes the complete ordered
model context through the core `surface/projection` event, and awaits
`SessionStore.flush()` after every archive, terminal staging, and projection.
Creation fails before sampling work when no durability listener participates.

The deployment composition supplies the ownership callback that disables or
rejects every competing DSH context reducer and native compaction path. The
adapter verifies this callback before creating its controller. Its disposer
removes the required-event registration when the owning plugin/session scope
ends. Complete durable Spawn staging can be recovered in canonical task order;
partial, duplicate, or malformed staging fails closed.

The loadable Cordis entry is
`@spinejit/pi-spinejit/deepseek-harness/extension`. One DSH step is one
sampling cycle: typed session messages are admitted as sources, `llm/stream`
durably begins the attempt, typed native and Code Mode tool events stage Spine
operations, and the next pre-step or turn-stopping boundary performs
PostSampling. Request failures close the attempt before retry. Spawn uses the
typed `ctx.subagents.start()` structured-output contract and requires a
non-empty model-authored `memory` field.

The extension rejects a composed native compaction service at load and session
recovery, and faults if any `compaction/*` event appears. DSH does not yet have
a generic exclusive-owner registry, so deployments must keep native compaction
and competing context reducers out of the Spine-enabled composition.

## Development source

The workspace uses the sibling SpineCodex checkout through the path recorded in
`core-source.json`. The current development source is revision
`cb01f18b0113ada388b0ede69b36c1194513a240` **plus** the versioned
`provenance/spine-core-cb01f18.patch`. The patch includes the local core changes
needed for recipe v2, empty node bodies, deterministic prompt composition, and
their regression tests; the revision alone does not contain those changes.

`developmentSnapshot.files` records every core file and the inherited Cargo
workspace manifest/toolchain. To reconstruct this development source, check out
the exact revision in a separate SpineCodex checkout and apply the patch from
that checkout's root. Do not apply it over an already modified core. Verify with
`node scripts/verify-core-source.mjs /path/to/reconstructed/SpineCodex`; without
the argument, the helper also checks that Cargo uses the declared sibling path.
The helper verifies the complete core inventory, file hashes, and patch hash.

`scripts/build-node-wasm.sh` runs this check before and after its locked Cargo
build, before replacing the packaged artifact. CI/release must reconstruct the
same revision plus patch and use the SDK workspace's `Cargo.lock`; a base-only
checkout is not this build's source. This records a reproducible development
input, not a published core release. `provenance/node-wasm-build.json` records
the binding inputs, toolchain, build settings, generated artifact hashes, and
portable checks for the checked-in WASM. It does not claim bit-for-bit builds
across other toolchains or directories. A future ownership migration may move
the canonical crate here only if SpineCodex changes atomically to depend on it.

After generating a Node-targeted `spine_wasm.js` with the exact locked
`wasm-bindgen-cli` version, verify native/WASM equivalence with:

```bash
npm run test:wasm-golden -- /absolute/path/to/spine_wasm.cjs
```
