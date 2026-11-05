# Portable ABI Contract

Status: implementation contract for portable schema `spine-sdk/v3` and
context recipe `spine.context.plan.v2`.

The JavaScript boundary is a coarse stateful runtime. Rust-only ownership types
such as `SamplingHandle` and `PreparedSamplingCommit` remain inside the binding.
Every request and response is bounded, serializable pure data carrying an
explicit schema discriminator.

The lifecycle is:

```text
restore -> sourceSnapshot / continueNamespace
observeSources -> preview -> publish
beginSampling -> persist started record
stageExecution -> finishExecution
prepareFinish -> persist commit record
install -> publish ContextPlan
compact(barrier) -> persist compact entry -> publish compacted ContextPlan
```

`prepareFinish` never installs. The host must durably persist the returned
commit record before calling `install`. A failed persistence discards
the unpersisted candidate. Replay installs the same canonical state without
replaying live-only host effects.

Cold-start recover must not copy the whole host log in one ABI request.
`replay_begin` / `replay_apply` / `replay_finish` drive `CanonicalReplay`
incrementally; each JSON request stays under `MAX_ABI_REQUEST_BYTES` (4 MiB).
`replay { inputs }` remains sugar for begin + one apply + finish when the
payload already fits. `replay_apply` failures latch the runtime Faulted and
do not publish.

`compact` is idle-only. The host persists the typed barrier before issuing the
runtime command. The command advances the context epoch and returns the
replacement source plan; the host binds those core-assigned source identities
before publishing. The Pi adapter requires non-empty replacement metadata before
writing the durable entry. Compact barriers are also valid replay inputs.

`sourceSnapshot` returns the core-assigned source identities needed to bind
host messages to `ContextPlan` cells. `continueNamespace` changes physical host
session identity without changing Spine scope-tree semantics. Preview
publication is serialized by the shared controller with all other runtime
operations.

The npm package keeps the portable protocol at `@spinejit/spine-sdk` and exposes
the generated Node WASM runtime only at `@spinejit/spine-sdk/node`. The Node
artifact is generated with the exact `wasm-bindgen 0.2.127` CLI; importing the
portable root does not load Node built-ins or WASM.

The portable ABI does not expose ParseStack internals, filesystem config
loading, native tool grouping, rendered-text parsing, or host history topology.
The Node WASM wrapper additionally exposes `extendSystemPrompt(base)`, which
delegates prompt composition to the configured `SpineConfig` without exposing
the reducer or its internal state.


## Spawn, arrivals and replies (v3)

A `spawn` operation carries only its `tasks`. Committing it creates one birth
node per task (`kind: "Spawn"`, closed, memory `[Birth { task }]`) under the
cursor; the commit does not wait for the children. Each child's final result
enters the parent later as a source character of its own,
`{ type: "arrival", boundary, arrival: { producer, outcome, memory?, diagnostic?, execution_ref? } }`,
where `producer` is the birth node id. A completed arrival carries non-empty
`memory`; an errored or aborted one carries `diagnostic` and no memory. The
core admits each producer at most once and places the arrival at the cursor
where it is admitted, so it stays in the context exactly where the model first
saw it. A node's `spawn_outcome` is `null` until its arrival is admitted.
Close, Next and Compact are rejected while a birth inside the scope has not
arrived.

The source role `reply` marks an assistant message that ended its sampling with
`stop` and no tool call; the host passes only its text blocks. It renders as
assistant text and is kept, with user messages and arrivals, in the memory of
the node that closes over it. A reply in the same sampling as a structural
operation is rejected.

A node just closed (by Close, or by Next) shows as it was until the next
sampling, so the request after a Close only appends to the one before it and
the model decides its next step with its own work in view. That sampling folds
the node, and the folded node replaces the node's own suffix, so everything
rendered before the node's first cell is unchanged. Folding at the Close
itself made models doubt the memory and redo the node's work. The sampling
that folds a node no longer follows the prefix it was sampled on, so it renders
without reasoning where the provider ties reasoning to the prefix. Gemini does
not, and requires its thought signatures on the function calls of its current
turn, where that sampling sits; a Gemini output keeps its reasoning.
The model reads a Spine call's result in that request, after the call has
taken effect, so the result says what the call did: the node a Close or Next
closed, after a Close where the model is now, and after an Open or Next the
node it opened. An acknowledgement that only said the call was staged left
models unsure whether the node had closed: they stopped, closed it again, or
Gemini returned a malformed response.

An open node has no descriptor item in the context. Its descriptor
(`status="opened"`, with the configured node prompt) is in the result of the
`spine_open` or `spine_next` call that opened it, inside the node's opening
sampling; the host numbers it as the core does, the next child of its parent,
births included. As an item of its own after the call's result, Gemini read it
as a new user message: replaying 6 such requests 6 times each, 14 of 36 returned
`MALFORMED_RESPONSE` and 3 were empty; with the descriptor in the result, 36 of
36 answered.

A folded task node starts with its descriptor, now `Closed`: its id and goal,
where its folded work began. It then renders what it keeps in their original
order (user messages, replies, births, arrivals and its children's memories),
then its memory summary. The sampling that closed it folds with the node's
work. A host refuses `spine_close` beside other tool calls: the memory in
`spine_close` is written before their results exist. A birth node has no descriptor: its
birth record is where the spawned branch starts. Inside an ancestor's memory a
child renders the same way.

v3 removes v2's `terminal_results`, `SpawnResult` and `SpawnEvidence`; a v2
client is rejected by the schema check.

A v2 context recipe contains the ordered `cells` for the current projection.
Memory items are represented in those cells when visible; the recipe and its
resolved form do not carry a second `memory_slots` copy of every historical
node. Full node memory, user evidence, and child returns remain in the semantic
tree and typed sampling records. Compact can therefore replace the current
view without retaining invisible historical memory in the recipe's 2 MiB
budget. The tree and archive may still grow; this is not an unlimited-history
guarantee.

The Rust recipe decoder rejects the v1 tag and rejects a v2 object containing
removed fields. The TS SDK and packaged WASM must be upgraded together: v1
initialization/commands are rejected by v2 WASM, and v1 responses are rejected
by the v2 client. There is no negotiated or fallback representation. Rebuild
and deploy both artifacts, then restart hosts using an older loaded runtime.

Sampling archive, source snapshot, compact barrier, and host transport schemas
are unchanged. Codex and Pi persist typed source/archive/compact records, not
recipe snapshots. Existing sessions use the same canonical replay to rebuild
v2 plans; their original records do not need rewriting. A separately saved v1
recipe is not a v2 input or a substitute for those durable records.
