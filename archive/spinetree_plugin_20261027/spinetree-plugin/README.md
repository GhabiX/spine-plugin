# SpineTree tool contracts

`spinetree_read({ branch })` captures one HEAD and reads all result fields from
that immutable snapshot. In `spinetree.read.result/v2`, `binding` is the branch's
non-ended registry entry. Ordinary executable Agents use a durable
`WorkingBinding`: `{ agentId, sessionId, branch, scope, bindingId, leaseId,
operationId, epoch, scopeCursor, status }`. Legacy registry entries may still be
read by contract-level tools, but the Agent launcher rejects them for executable
sessions because they do not carry a valid WorkingBinding lease.
Both running and paused Agents are discoverable; `binding` is null when none exists.
Multiple active entries return `SpineTreeReadError` with code `ambiguous-binding`
so callers do not route a message to an arbitrarily selected Agent.

Use `result.binding.agentId` as `spinetree_send.to`. AgentId and PiSessionId are
different identities. The lookup reflects the captured HEAD; send still checks
the recipient's current registry state.

`branch.reexecution.binding` preserves the allocation snapshot, including the
status recorded at allocation. It is not a live registry lookup. A completed
reexecution can therefore retain `status: "running"` in that historical record
while top-level `binding` is null. Use `branch.reexecution.state` for the
operation's progress and top-level `binding` for current Agent availability.
Keep the historical ownership fields intact for receipt and lease validation.

The project store accepts only snapshots with `schema: "spinetree.snapshot/v2"`
and a `branches` map. Any own `agents` field, including an empty map, is rejected.
Memory and Git stores apply the same validation; invalid initialization and
commits cannot advance state. Git initialization validates before creating its
directory. Registry, mailbox, Scope imports and extra application metadata are
preserved. This package starts new trees; it does not migrate old snapshots.
Keep historical trees with their original package. Read does not modify state.
Git snapshot publication waits up to 1000 ms for a ref lock. The update still
uses the expected HEAD as its compare-and-swap value; if another writer wins
while this commit waits, the store reports a stale HEAD instead of overwriting it.

Use the same snapshot store for tree reads and the persistent registry/mailbox
adapters. `GitSpineTreeAgentRegistry` also accepts `MemorySpineTreeStore` for
in-memory shared snapshots. A standalone `MemoryAgentRegistry` is independent
of a tree snapshot and is not queried by read: querying a second store would
break the fixed-HEAD guarantee.

Each tool declares its own JSON Schema and description. Host's `describeTool(name)`
returns this metadata, and the Pi composition forwards it to `registerTool`.
The five input contracts are:

| Tool | Required | Optional |
| --- | --- | --- |
| `spinetree_read` | `branch` | — |
| `spinetree_change` | non-empty `changes`; each item has `expectedRevision` | — |
| `spinetree_send` | `to`, `message` | `from`, `requestId` |
| `spinetree_observe` | `receiptId`, `agentId` | `leaseId` (required while leased) |
| `spinetree_rejuvenate` | `parent`, `branch` | `request` |

Strings must be non-empty. `change` items are `update` with `branch`,
`expectedRevision` and `attributes`, `move` with `branch`, `expectedRevision`
and `parent`, or `archive` with `branch` and `expectedRevision`.
`expectedRevision` is `revision` from `spinetree_read` for that ProjectBranch.
It changes only when that branch value changes. Registry, mailbox, and other
store commits are retried inside the tool. A different branch value writes
nothing and returns `applied: false` with the current branches. Update
attributes are limited to `goal` (string) and `constraints`, `skills`, `tools`
(arrays). The model-facing schemas reject unrecognized fields; runtime checks
still enforce state-dependent constraints such as store CAS and receipt
ownership. Host does not add a schema validation layer to `executeTool`.

Move changes a completed branch's project parent; its canonical Scope ancestry,
identity and memory source stay intact. Archive marks the node archived and
retains it and its memory. Later imports preserve an already committed terminal
Scope mapping to that node without reactivating it or replacing its memory,
including after reexecution. This requires the existing import mapping: a new
binding to an archived branch is still rejected, as is a live Scope that tries
to reuse its archived mapping. Neither operation merges results, deletes nodes,
nor prunes canonical context. Work decomposition and result integration remain
separate lifecycle and parent-verification steps.

Without the required explicit adapters, a tool retains its input schema but its
description states that it returns `contract-only`. No implicit state is created.

## Queued messaging and observation

`spinetree_send` v2 only validates Agent addresses and enqueues. A fresh result is
`{ schema: "spinetree.send.result/v2", status: "queued", receipt, to, sessionId }`.
It never calls the session adapter or waits for the recipient. Reusing `requestId`
with the same message returns its current receipt; `status` equals `receipt.status`
(including leased or observed). A conflicting message under that key fails.
Memory adapters retain state only in process; Git adapters persist it before return.

Applications must call `dispatchSpineTreeMailbox({ registry, mailbox, sessions,
limit })` outside the sending tool stack. Each pass selects a bounded batch once;
messages enqueued during a prompt, including replies, wait for another pass.
The caller owns scheduling, fairness, timeouts and Pi connections/leases. There is
no automatic worker. The Pi adapter still awaits actual prompt completion.

Dispatcher prompt text is JSON with this exact envelope:

```json
{"schema":"spinetree.message/v1","receiptId":"mail-1","leaseId":"lease-1","bindingId":"binding-b","to":"agent-b","from":"agent-a","message":"Please review the result"}
```

`from` is null when omitted. The message string is preserved. This envelope is
application text within Pi's existing prompt API, not a new Pi wire protocol.
The recipient uses `spinetree_observe({ receiptId, agentId: to, leaseId })` during
its prompt, then may enqueue a reply to `from` with `spinetree_send`. Observing
confirms receipt, not successful task completion or exactly-once business effects.
Agent checks establish routing consistency; they are not authentication.

State transitions are `queued -> leased -> delivered -> observed`, or
`leased -> observed` when the recipient confirms before its prompt completes.
Leased observation requires its current token. Delivered/observed allow omitted
tokens for existing callers and legacy receipts, but any supplied token must match.
Queued and failed cannot be observed. Delivered/observed retain the completing
leaseId as delivery identity, with leaseUntil cleared; it is no longer an active
lease. Same-token late success/rejection/error returns observed without a write.
A superseded token cannot observe or overwrite a newer delivery's state.

Without observation, accepted prompt completion marks delivered; rejected or
transient failures requeue; explicitly permanent errors mark failed. Busy targets
therefore leave the same receipt available for a later pass. Long prompts exceeding
the lease interval and lost acknowledgements can cause duplicate prompts: delivery
remains at least once. requestId deduplicates local enqueue, not remote execution.
Storage acknowledgement failures propagate and do not masquerade as transport errors.

Migration from send v1: schedule explicit dispatch, decode envelope text rather
than assuming plain message text, and pass its leaseId for in-prompt observation.
Custom mailbox implementations must implement these observation and late-completion
rules too; the built-in Memory/Git adapters share the transition functions.

## Explicit canonical Scope mapping

`commitSpineTreeScopes({ store, agentId, sessionId, transactionId, record,
projection, selections })` imports an already committed canonical sampling result.
`record` is the SDK `SamplingCommit`; `projection` is its installed `SpineProjection`.
The caller retains the receipt for retry if the project write fails. This API
does not execute operations, reduce memory or register an additional model tool.

Select `{ nodeId, parent }` to allocate a new ProjectBranch UUID under an existing
parent, or `{ nodeId, branch }` to bind an existing project branch. Only Task scopes
can be selected. Existing branches must be unbound and live; replacing a prior
result requires typed reexecution. Selected Spawn terminals must use their
reserved branch and verified handoff, including the ended child lease check.
Unselected scopes stay local. On each subsequent commit, pass an
empty selection to refresh known mappings, or add explicit selections for new work.
The Agent must exist in the same snapshot registry and belong to this Pi session.

Callers may instead pass `alignment: "one-to-one"` and omit `selections`. The
importer maps canonical Task nodes by depth. An ordinary first Open creates a
child of the immutable execution assignment; nested Tasks create descendants.
Close preserves that identity and its local resources. Home reuse is limited to
the typed Spawn assignment floor and the single inline result of a reexecution.
Spawn terminal handoffs retain their reserved branch and parent. The result
contains generated UUIDs. Replaying the same
alignment receipt is write-free and returns the persisted UUIDs; generated IDs
are not part of the input fingerprint.

Import watermarks retain cumulative Scope mappings separately from the current
receipt's selections. Omitting an old terminal Scope does not forget its mapping;
selecting it after reexecution cannot overwrite a newer memory version. New
receipts from a registered WorkingBinding require its complete matching lease.
A reexecution may Spawn at RootEpoch before its inline result, but result-level
Next or a second inline result rejects the project import without partial writes.
Canonical commits remain immutable if project reconciliation is required.

When reexecution readiness fails, rollback checks the original ownership in both
the Agent registry and the branch's reexecution record inside the snapshot CAS.
A replaced lease, operation or advanced cursor is not rolled back; the newer
snapshot is preserved and the stale `release` callback is not called. Normal
failure marks the owned execution ended/failed before calling `release` with its
original binding. The adapter must release only that allocation. If release also
fails, both the readiness and release errors are retained in an `AggregateError`;
external session cleanup remains the host's responsibility.

Each branch stores `scopeBinding: { agentId, sessionId, thread, epoch, nodeId }`.
Live/Opened scopes keep the project branch live. Closed/Compacted scopes cap it
and copy the complete canonical `MemorySlot[]` with a single `memoryVersion`
increment and `memorySource` recording the binding, transaction, commit and post
boundary. Capping does not end the Agent or assert that the project goal is complete.
Existing project attributes remain unchanged when binding an existing branch.

For a mapped live branch, read resolves its mapped Agent from the same captured
registry snapshot. The returned `binding.branch` remains the Agent's immutable
home branch; `result.branch.id` identifies the branch being read. A capped mapped
branch returns null, including while a replacement Agent is provisioned but has
not yet bound a new live scope. Exclusive registration respects mapped live
ownership. A capped Scope mapping stops reserving the branch, but an Agent whose
immutable home is that branch still reserves it until explicitly ended. Capping
does not change that Agent lifecycle rule.

The receipt's WorkingBinding carries the target canonical epoch and cursor.
The importer validates its immutable assignment and active lease, then updates
that cursor, selected branches and import watermark in one expected-head CAS.
Callers must not prewrite the cursor. Cursor-only registry updates remain
available to hosts with Scope import disabled. The result's optional `binding`
is the registry value at the returned HEAD; a replay returns the current value,
including a paused or ended status, without restoring the receipt's old cursor.
Stale HEAD retries re-read the snapshot (at most eight attempts by
default). The same latest receipt and selection replay without a write and return
the same allocated IDs, regardless of object key order. A changed replay is rejected; within an epoch subsequent
imports must follow the canonical commit chain. Retain and retry failed receipts
in order. An older import is rejected even if its original import once succeeded.

Canonical and project commits are separate transactions. There is no distributed
rollback or recovery worker. A live mapped scope disappearing from a projection
or across an epoch is explicitly unsupported; this slice does not infer a close
or implement compaction/fork migration. Session, lease and dispatcher ownership
remain with the caller.

## Loadable boundaries

ProjectTree, collaboration, the Pi session adapter, and navigation are explicit
loadable units. They keep one `spinetree` tool namespace because the host rejects
a second owner of that namespace. Omitting `load` preserves the historical
project and collaboration tools. `load: []` claims no namespace and registers no
tools. Collaboration cannot be selected without ProjectTree, and the Pi adapter
cannot be selected without collaboration. Navigation stays a separate Pi
extension package and does not register these tools.
