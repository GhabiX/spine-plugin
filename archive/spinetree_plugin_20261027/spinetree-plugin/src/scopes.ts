import { createHash, randomUUID } from "node:crypto";
import type { EpochOrdinalId, NamespacedId, NodeSnapshot, SamplingCommit, SpineProjection, SpawnTask } from "@spinejit/spine-sdk";
import { isWorkingBinding, SpineTreeChangeError, updateWorkingBinding } from "./index.js";
import type { SpineTreeBranch, SpineTreeSnapshot, SpineTreeSnapshotCommitStore, SpineTreeWorkingBinding } from "./index.js";

export interface SpineTreeScopeBinding {
  readonly agentId: string;
  readonly sessionId: string;
  readonly thread: string;
  readonly epoch: number;
  readonly nodeId: readonly number[];
}

export interface SpineTreeScopeMemorySource extends SpineTreeScopeBinding {
  readonly schema: "spinetree.scope.memory/v1";
  readonly transactionId: string;
  readonly commitId: NamespacedId;
  readonly postBoundary: EpochOrdinalId;
}

export type SpineTreeScopeSelection =
  | { readonly nodeId: readonly number[]; readonly parent: string; readonly branch?: never }
  | { readonly nodeId: readonly number[]; readonly branch: string; readonly parent?: never };

type SpineTreeAlignedSelection =
  | SpineTreeScopeSelection
  | { readonly nodeId: readonly number[]; readonly parentNodeId: readonly number[] };

export interface SpineTreeScopeMapping {
  readonly nodeId: readonly number[];
  readonly branch: string;
}

export interface SpineTreeScopeWatermark {
  readonly epoch: number;
  readonly postBoundary: number;
  readonly commitId: string;
  readonly fingerprint: string;
  readonly selections: readonly SpineTreeScopeMapping[];
  /** Cumulative mappings in this epoch, including scopes omitted by later selectors. */
  readonly mappings: readonly SpineTreeScopeMapping[];
  /** First local sampling's boundary in a continued child namespace. */
  readonly inheritedThrough?: number;
}

export interface SpineTreeScopeWorkingBinding {
  readonly bindingId: string;
  readonly leaseId: string;
  readonly agentId: string;
  readonly sessionId: string;
  readonly branch: string;
  readonly epoch: number;
  readonly scopeCursor: readonly number[];
}

export interface SpineTreeScopeCommitInput {
  readonly store: SpineTreeSnapshotCommitStore;
  readonly agentId: string;
  readonly sessionId: string;
  readonly binding?: SpineTreeScopeWorkingBinding;
  readonly transactionId: string;
  /** Public result of an already committed canonical sampling transaction. */
  readonly record: SamplingCommit;
  readonly projection: SpineProjection;
  /** Align owned canonical Task nodes; explicit selections override individual nodes. */
  readonly alignment?: "one-to-one";
  readonly selections?: readonly SpineTreeScopeSelection[];
  readonly maxCasRetries?: number;
}

export interface SpineTreeScopeCommitResult {
  readonly schema: "spinetree.scopes.result/v1";
  readonly head: string;
  readonly replayed: boolean;
  readonly selections: readonly SpineTreeScopeMapping[];
  /** Registry state at this result's HEAD, including on historical replay. */
  readonly binding?: SpineTreeWorkingBinding;
}

export class SpineTreeScopeError extends Error {
  constructor(
    readonly code: "invalid-commit" | "stale-commit" | "conflicting-replay" | "invalid-selection"
      | "unknown-branch" | "binding-conflict" | "unknown-agent" | "unsupported-scope",
    message: string,
  ) {
    super(message);
    this.name = "SpineTreeScopeError";
  }
}

/** Imports selected committed scopes; canonical owns all reduction and execution. */
export async function commitSpineTreeScopes(input: SpineTreeScopeCommitInput): Promise<SpineTreeScopeCommitResult> {
  const { store, maxCasRetries = 8, ...receipt } = input;
  if (!Number.isInteger(maxCasRetries) || maxCasRetries < 1) throw new TypeError("maxCasRetries must be positive");
  // Retain one immutable receipt throughout asynchronous CAS retries.
  const fixed = structuredClone(receipt);
  validateReceipt(fixed);
  const key = JSON.stringify([fixed.sessionId, fixed.record.commit_id.thread]);
  for (let attempt = 0; ; attempt += 1) {
    const head = await store.head();
    const snapshot = await store.readSnapshot(head);
    const prior = snapshot.scopeImports?.[key];
    // Aligned selections are checked against the persisted mapping on replay;
    // generated ProjectBranch UUIDs are output, not receipt identity.
    const fingerprint = fingerprintReceipt(fixed);
    if (prior !== undefined) {
      if (prior.commitId === fixed.record.commit_id.value && prior.epoch === fixed.record.epoch) {
        if (prior.fingerprint !== fingerprint) throw new SpineTreeScopeError("conflicting-replay", "Commit replay differs from the imported receipt or selection");
        if (fixed.alignment === "one-to-one") validateAlignedReplay(fixed.selections ?? [], prior.selections);
        return commitResult(snapshot, fixed.agentId, head, true, prior.selections);
      }
      const record = fixed.record;
      if (record.epoch < prior.epoch || (record.epoch === prior.epoch && (
        record.post_boundary.ordinal < prior.postBoundary || record.previous_commit_id?.value !== prior.commitId
      ))) throw new SpineTreeScopeError("stale-commit", "Cannot import an older or divergent canonical commit");
    }
    const binding = validateSnapshotBinding(snapshot, fixed);
    const draft = structuredClone({ ...snapshot, ...(binding === undefined ? {} : {
      registry: { ...snapshot.registry, [fixed.agentId]: binding },
    }) });
    const ownership = spawnScopeOwnership(draft, fixed);
    const selections: readonly SpineTreeAlignedSelection[] = fixed.alignment === "one-to-one"
      ? deriveAlignedSelections(draft, fixed, ownership)
      : fixed.selections!;
    const mapped = mapScopes(draft, { ...fixed, selections } as MappingReceipt, ownership);
    const mappings = new Map((prior?.epoch === fixed.record.epoch ? prior.mappings : [])
      .map(mapping => [JSON.stringify(mapping.nodeId), mapping]));
    for (const mapping of mapped) {
      const previous = mappings.get(JSON.stringify(mapping.nodeId));
      if (previous !== undefined && previous.branch !== mapping.branch) {
        throw new SpineTreeScopeError("binding-conflict", "A committed Scope mapping cannot change branches");
      }
      mappings.set(JSON.stringify(mapping.nodeId), mapping);
    }
    const next: SpineTreeSnapshot = { ...draft, scopeImports: { ...draft.scopeImports, [key]: {
      epoch: fixed.record.epoch, postBoundary: fixed.record.post_boundary.ordinal,
      commitId: fixed.record.commit_id.value, fingerprint, selections: mapped, mappings: [...mappings.values()],
      ...(ownership === undefined ? {} : { inheritedThrough: ownership.through }),
    } } };
    try {
      const committed = await store.commitSnapshot(head, next, "spinetree: import committed scopes");
      return commitResult(next, fixed.agentId, committed.head, false, mapped);
    } catch (error) {
      if (!(error instanceof SpineTreeChangeError) || error.code !== "stale-head" || attempt + 1 >= maxCasRetries) throw error;
    }
  }
}

function commitResult(snapshot: SpineTreeSnapshot, agentId: string, head: string, replayed: boolean,
  selections: readonly SpineTreeScopeMapping[]): SpineTreeScopeCommitResult {
  const binding = snapshot.registry?.[agentId];
  return { schema: "spinetree.scopes.result/v1", head, replayed, selections: structuredClone(selections),
    ...(binding !== undefined && isWorkingBinding(binding) ? { binding: structuredClone(binding) } : {}) };
}

type Receipt = Omit<SpineTreeScopeCommitInput, "store" | "maxCasRetries">;
type MappingReceipt = Omit<Receipt, "selections"> & { selections: readonly SpineTreeAlignedSelection[] };

function validateReceipt(input: Receipt): void {
  const { record, projection } = input;
  const thread = record.commit_id.thread;
  if (!input.agentId || !input.sessionId || !input.transactionId || !thread || !record.commit_id.value ||
    record.schema !== "spine.sampling.commit" || record.pre_boundary.thread !== thread ||
    record.post_boundary.thread !== thread || record.attempt_id.thread !== thread ||
    record.pre_boundary.epoch !== record.epoch || record.post_boundary.epoch !== record.epoch ||
    projection.last_boundary !== record.post_boundary.ordinal) {
    throw new SpineTreeScopeError("invalid-commit", "Expected a matching committed sampling record and projection");
  }
  if (input.binding !== undefined && (
    input.binding.agentId !== input.agentId || input.binding.sessionId !== input.sessionId ||
    input.binding.epoch !== record.epoch ||
    JSON.stringify(input.binding.scopeCursor) !== JSON.stringify(projection.cursor)
  )) {
    throw new SpineTreeScopeError("binding-conflict", "WorkingBinding does not match the committed Scope projection");
  }
  if (input.alignment !== undefined && input.alignment !== "one-to-one") {
    throw new SpineTreeScopeError("invalid-selection", "Unknown Scope alignment policy");
  }
  if (input.selections === undefined && input.alignment !== "one-to-one") {
    throw new SpineTreeScopeError("invalid-selection", "Provide explicit selections or one-to-one alignment");
  }
}

function validateSnapshotBinding(snapshot: SpineTreeSnapshot, input: Receipt): SpineTreeWorkingBinding | undefined {
  const binding = input.binding;
  if (binding === undefined) {
    const current = snapshot.registry?.[input.agentId];
    if ((current !== undefined && isWorkingBinding(current)) || Object.values(snapshot.branches).some(branch => branch.reexecution?.binding?.agentId === input.agentId &&
        branch.reexecution.binding.sessionId === input.sessionId &&
        (branch.reexecution.state === "running" || branch.reexecution.state === "completed"))) {
      throw new SpineTreeScopeError("binding-conflict", "Registered execution requires its WorkingBinding receipt");
    }
    return;
  }
  const current = snapshot.registry?.[binding.agentId];
  const branch = snapshot.branches[binding.branch];
  if (current === undefined || !isWorkingBinding(current) || current.status !== "running" ||
      current.sessionId !== binding.sessionId || current.branch !== binding.branch ||
      current.bindingId !== binding.bindingId || current.leaseId !== binding.leaseId) {
    throw new SpineTreeScopeError("binding-conflict", "ProjectTree snapshot does not hold the active WorkingBinding");
  }
  if (branch === undefined || (branch.status !== "live" && !(branch.status === "capped" && isReexecutionOwner(branch, input) && branch.reexecution?.state === "completed"))) {
    throw new SpineTreeScopeError("binding-conflict", "WorkingBinding must point to a live ProjectBranch");
  }
  return updateWorkingBinding(current, binding.leaseId, binding);
}

function fingerprintReceipt(input: Receipt): string {
  const { selections, ...alignedReceipt } = input;
  const identity = input.alignment === "one-to-one" ? alignedReceipt : input;
  const serialized = JSON.stringify(identity, (_key, value) => value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
  return createHash("sha256").update(serialized).digest("hex");
}

function validateAlignedReplay(overrides: readonly SpineTreeScopeSelection[], mapped: readonly SpineTreeScopeMapping[]): void {
  const expected = new Map(mapped.map(selection => [JSON.stringify(selection.nodeId), selection.branch]));
  const seen = new Set<string>();
  for (const override of overrides) {
    const key = JSON.stringify(override.nodeId);
    if (seen.has(key) || override.branch === undefined || expected.get(key) !== override.branch) {
      throw new SpineTreeScopeError("conflicting-replay", "Aligned replay attempts to change the persisted Scope mapping");
    }
    seen.add(key);
  }
}

interface SpawnScopeOwnership {
  readonly floor: readonly number[];
  readonly through: number;
}

/** A continued child inherits context, not ownership of the ancestor tree.
 * The first local committed sampling provides the boundary in its rebased
 * namespace. Keep it in the existing import watermark, including on replay.
 */
function spawnScopeOwnership(snapshot: SpineTreeSnapshot, input: Receipt): SpawnScopeOwnership | undefined {
  const agent = snapshot.registry?.[input.agentId];
  const reservation = agent === undefined ? undefined : snapshot.branches[agent.branch]?.spawnReservation as SpawnReservation | undefined;
  if (reservation?.agentId !== input.agentId || reservation.sessionId !== input.sessionId) return undefined;
  const thread = input.record.commit_id.thread;
  const prior = snapshot.scopeImports?.[JSON.stringify([input.sessionId, thread])];
  // A child can spawn immediately at RootEpoch before its parent has any
  // commit, so namespace changes alone do not identify inherited context.
  const floor = reservation.parentScope;
  const through = prior?.inheritedThrough ?? input.record.pre_boundary.ordinal;
  const parent = snapshot.registry?.[reservation.parentAgentId] as SpineTreeWorkingBinding | undefined;
  const node = input.projection.nodes.find(node => sameNode(node.id, floor?.nodeId ?? []));
  if (input.binding === undefined || reservation.schema !== "spinetree.spawn.reservation/v1" ||
      reservation.state !== "launched" || floor === undefined || floor.epoch !== input.record.epoch ||
      parent?.bindingId !== reservation.parentBindingId || parent.sessionId !== floor.sessionId ||
      parent.epoch !== floor.epoch || !sameNode(parent.scopeCursor, floor.nodeId) ||
      (prior !== undefined && prior.epoch !== input.record.epoch) || node === undefined || isTerminalNode(node) || node.start > through ||
      !withinScope(input.projection.cursor, floor.nodeId)) {
    throw new SpineTreeScopeError("binding-conflict", "Child import must remain within its reserved inherited Scope");
  }
  return { floor: floor.nodeId, through };
}

function sameNode(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && withinScope(left, right);
}

function withinScope(node: readonly number[], floor: readonly number[]): boolean {
  return node.length >= floor.length && floor.every((part, index) => node[index] === part);
}

function ownsScope(node: NodeSnapshot, ownership: SpawnScopeOwnership | undefined): boolean {
  return ownership === undefined || sameNode(node.id, ownership.floor) ||
    (withinScope(node.id, ownership.floor) && node.start > ownership.through);
}

function deriveAlignedSelections(snapshot: SpineTreeSnapshot, input: Receipt, ownership: SpawnScopeOwnership | undefined): SpineTreeAlignedSelection[] {
  const { agentId, sessionId, record, projection } = input;
  const thread = record.commit_id.thread;
  const agent = snapshot.registry?.[agentId];
  if (agent === undefined || agent.sessionId !== sessionId || agent.status === "ended") {
    throw new SpineTreeScopeError("unknown-agent", "Scope import requires an active registered Agent for this Pi session");
  }
  const nodes = new Map(projection.nodes.map(node => [JSON.stringify(node.id), node]));
  const overrides = new Map<string, SpineTreeScopeSelection>();
  for (const selection of input.selections ?? []) {
    const key = JSON.stringify(selection.nodeId);
    const node = nodes.get(key);
    if (overrides.has(key) || node?.kind !== "Task" || selection.branch === undefined || !ownsScope(node, ownership)) {
      throw new SpineTreeScopeError("invalid-selection", "Alignment overrides must bind distinct canonical Task nodes to existing branches");
    }
    overrides.set(key, selection);
  }
  const branches = snapshot.branches as Record<string, SpineTreeBranch>;
  const ordered = projection.nodes.filter(node => node.kind === "Task" && ownsScope(node, ownership)).sort((left, right) => {
    const depth = (node: NodeSnapshot) => {
      let value = 0;
      let current = node;
      const seen = new Set<string>();
      while (current.parent !== null) {
        const key = JSON.stringify(current.parent);
        if (seen.has(key)) break;
        seen.add(key);
        const parent = nodes.get(key);
        if (parent === undefined) break;
        value += 1;
        current = parent;
      }
      return value;
    };
    return depth(left) - depth(right) || JSON.stringify(left.id).localeCompare(JSON.stringify(right.id));
  });
  const branchByNode = new Map<string, string>();
  const assigned = new Set<string>();
  const selections: SpineTreeAlignedSelection[] = [];
  for (const node of ordered) {
    const nodeKey = JSON.stringify(node.id);
    const override = overrides.get(nodeKey);
    if (override !== undefined) {
      if (override.branch !== undefined) {
        branchByNode.set(nodeKey, override.branch);
        assigned.add(override.branch);
      }
      selections.push(override);
      continue;
    }
    const retained = retainedTerminalMapping(snapshot, input, node);
    if (retained !== undefined) {
      branchByNode.set(nodeKey, retained.id);
      assigned.add(retained.id);
      selections.push({ nodeId: [...node.id], branch: retained.id });
      continue;
    }
    const mapped = Object.values(branches).find(branch => matchesScope(branch.scopeBinding, sessionId, thread, record.epoch, node.id));
    if (mapped !== undefined) {
      if ((mapped.reexecution?.state === "running" || mapped.reexecution?.state === "completed") && !isReexecutionOwner(mapped, input)) {
        throw new SpineTreeScopeError("binding-conflict", "Reexecution scope requires its reserved WorkingBinding");
      }
      branchByNode.set(nodeKey, mapped.id);
      assigned.add(mapped.id);
      selections.push({ nodeId: [...node.id], branch: mapped.id });
      continue;
    }
    const parent = node.parent === null ? undefined : nodes.get(JSON.stringify(node.parent));
    const parentBranch = parent?.kind === "Task" ? branchByNode.get(JSON.stringify(parent.id)) : undefined;
    const projectParent = parentBranch ?? agent.branch;
    const home = branches[projectParent];
    if (home === undefined) throw new SpineTreeScopeError("unknown-branch", `Unknown ProjectBranch ${projectParent}`);
    const homeBinding = home.scopeBinding;
    const assignedFloor = ownership !== undefined && sameNode(node.id, ownership.floor);
    const resultScope = parent?.kind === "RootEpoch" && isReexecutionOwner(home, input) && spawnEvidence(node).length === 0;
    const canReuseHome = (assignedFloor || resultScope) && !assigned.has(home.id) && home.status !== "archived" &&
      (homeBinding === undefined || (home.status === "capped" &&
        (homeBinding.sessionId !== sessionId || homeBinding.thread !== thread || homeBinding.epoch !== record.epoch)));
    if (canReuseHome) {
      branchByNode.set(nodeKey, home.id);
      assigned.add(home.id);
      selections.push({ nodeId: [...node.id], branch: home.id });
    } else if (parent?.kind === "Task") {
      selections.push({ nodeId: [...node.id], parentNodeId: [...parent.id] });
    } else {
      selections.push({ nodeId: [...node.id], parent: projectParent });
    }
  }
  return selections;
}

function mapScopes(snapshot: SpineTreeSnapshot, input: MappingReceipt, ownership: SpawnScopeOwnership | undefined): SpineTreeScopeMapping[] {
  const { agentId, sessionId, record, projection } = input;
  const thread = record.commit_id.thread;
  const agent = snapshot.registry?.[agentId];
  if (agent === undefined || agent.sessionId !== sessionId || agent.status === "ended") {
    throw new SpineTreeScopeError("unknown-agent", "Scope import requires an active registered Agent for this Pi session");
  }
  const branches = snapshot.branches as Record<string, SpineTreeBranch>;
  const nodes = new Map(projection.nodes.map(node => [JSON.stringify(node.id), node]));
  const seen = new Set<string>();
  const selectedBranches = new Set<string>();
  const selections: SpineTreeScopeMapping[] = [];
  const branchByNode = new Map<string, string>();
  for (const selection of input.selections) {
    const nodeKey = JSON.stringify(selection.nodeId);
    const node = nodes.get(nodeKey);
    const parentNodeId = "parentNodeId" in selection ? selection.parentNodeId : undefined;
    const branchSelection = "branch" in selection ? selection.branch : undefined;
    const parentSelection = "parent" in selection ? selection.parent : undefined;
    const hasBranch = branchSelection !== undefined;
    const hasParent = parentSelection !== undefined || parentNodeId !== undefined;
    if (seen.has(nodeKey) || node?.kind !== "Task" || hasBranch === hasParent || !ownsScope(node, ownership)) {
      throw new SpineTreeScopeError("invalid-selection", "Select each Task scope once, with either a parent or an existing branch");
    }
    seen.add(nodeKey);
    const retained = retainedTerminalMapping(snapshot, input, node);
    if (retained !== undefined) {
      if ((branchSelection !== undefined && branchSelection !== retained.id) ||
          (parentSelection !== undefined && parentSelection !== retained.parent) || selectedBranches.has(retained.id)) {
        throw new SpineTreeScopeError("binding-conflict", "Historical terminal Scope cannot change its ProjectBranch mapping");
      }
      // The canonical terminal node remains in its author's projection. Its
      // durable mapping survives reexecution or archival. It must neither
      // rebind the branch nor overwrite its retained memory or project parent.
      validateSpawnMapping(retained, node, input);
      selectedBranches.add(retained.id);
      branchByNode.set(nodeKey, retained.id);
      selections.push({ nodeId: [...node.id], branch: retained.id });
      continue;
    }
    const mapped = Object.values(branches).find(branch => matchesScope(branch.scopeBinding, sessionId, thread, record.epoch, node.id));
    let branch: SpineTreeBranch;
    if (mapped !== undefined) {
      if ((mapped.reexecution?.state === "running" || mapped.reexecution?.state === "completed") && !isReexecutionOwner(mapped, input)) {
        throw new SpineTreeScopeError("binding-conflict", "Reexecution scope requires its reserved WorkingBinding");
      }
      if (mapped.status === "archived" || (branchSelection !== undefined && branchSelection !== mapped.id) ||
        (parentSelection !== undefined && parentSelection !== mapped.parent) || mapped.scopeBinding?.agentId !== agentId) {
        throw new SpineTreeScopeError("binding-conflict", "Scope mapping is archived or belongs to a different ProjectBranch or Agent");
      }
      branch = mapped;
    } else if (branchSelection !== undefined) {
      const existing = branches[branchSelection];
      if (existing === undefined) throw new SpineTreeScopeError("unknown-branch", `Unknown ProjectBranch ${branchSelection}`);
      if ((existing.reexecution?.state === "running" || existing.reexecution?.state === "completed") && !isReexecutionOwner(existing, input)) {
        throw new SpineTreeScopeError("binding-conflict", "Reexecution scope requires its reserved WorkingBinding");
      }
      const handedOff = handoffSpawnScope(snapshot, existing, node, input, branchByNode);
      if (existing.status === "archived" || (handedOff === undefined && (existing.scopeBinding !== undefined || existing.status === "capped"))) {
        throw new SpineTreeScopeError("binding-conflict", "A bound or capped branch requires typed handoff or reexecution");
      }
      if (Object.values(snapshot.registry ?? {}).some(candidate => candidate.branch === existing.id && candidate.status !== "ended" &&
        candidate.agentId !== agentId)) {
        throw new SpineTreeScopeError("binding-conflict", "ProjectBranch belongs to another active Agent");
      }
      branch = handedOff ?? existing;
    } else {
      const parentId = parentSelection ?? (parentNodeId === undefined ? undefined : branchByNode.get(JSON.stringify(parentNodeId)));
      if (parentId === undefined) throw new SpineTreeScopeError("invalid-selection", "A canonical parent scope must be mapped before its child");
      const parent = branches[parentId];
      if (parent === undefined) throw new SpineTreeScopeError("unknown-branch", `Unknown parent ${parentId}`);
      if (parent.status === "archived") throw new SpineTreeScopeError("invalid-selection", "Cannot create under an archived branch");
      branch = {
        id: randomUUID(), parent: parent.id, goal: node.summary ?? "", constraints: [], skills: [], tools: [],
        memory: null, memoryVersion: 0, memorySource: null, status: "live",
      };
    }
    validateSpawnMapping(branch, node, input);
    if (branch.id === agent.branch && !(ownership !== undefined && sameNode(node.id, ownership.floor)) &&
        !(isReexecutionOwner(branch, input) && node.parent !== null &&
          nodes.get(JSON.stringify(node.parent))?.kind === "RootEpoch" && spawnEvidence(node).length === 0)) {
      throw new SpineTreeScopeError("binding-conflict", "Ordinary Task scopes cannot occupy the execution assignment branch");
    }
    if (selectedBranches.has(branch.id)) throw new SpineTreeScopeError("binding-conflict", "Two scopes cannot bind the same ProjectBranch");
    if (ownership !== undefined && sameNode(node.id, ownership.floor) && branch.id !== agent.branch) {
      throw new SpineTreeScopeError("binding-conflict", "The inherited assignment Scope must map to the child home");
    }
    selectedBranches.add(branch.id);
    const scopeBinding: SpineTreeScopeBinding = { agentId, sessionId, thread, epoch: record.epoch, nodeId: [...node.id] };
    const sameMapping = matchesScope(branch.scopeBinding, sessionId, thread, record.epoch, node.id);
    branches[branch.id] = sameMapping ? branch : { ...branch, scopeBinding, status: "live" };
    branchByNode.set(nodeKey, branch.id);
    selections.push({ nodeId: [...node.id], branch: branch.id });
  }
  for (const branch of Object.values(branches)) {
    const bound = branch.scopeBinding;
    if (bound === undefined || bound.sessionId !== sessionId || bound.thread !== thread || branch.status !== "live") continue;
    const node = nodes.get(JSON.stringify(bound.nodeId));
    if (bound.epoch !== record.epoch || node?.kind !== "Task") {
      throw new SpineTreeScopeError("unsupported-scope", "A live mapped scope disappeared; epoch/fork migration requires an explicit adapter");
    }
    if (bound.agentId !== agentId) throw new SpineTreeScopeError("binding-conflict", "A live scope belongs to a different Agent");
    const imported = importNode(branch, node, input);
    branches[branch.id] = isReexecutionOwner(branch, input) && isTerminalNode(node) ? {
      ...imported, reexecution: { ...branch.reexecution!, state: "completed", terminalSource: imported.memorySource },
    } : imported;
  }
  validateReexecutionResult(snapshot, input);
  return selections;
}

function retainedTerminalMapping(snapshot: SpineTreeSnapshot, input: Omit<Receipt, "selections">, node: NodeSnapshot): SpineTreeBranch | undefined {
  const key = JSON.stringify([input.sessionId, input.record.commit_id.thread]);
  const prior = snapshot.scopeImports?.[key];
  if (prior?.epoch !== input.record.epoch) return undefined;
  const mapped = prior.mappings.find(selection => JSON.stringify(selection.nodeId) === JSON.stringify(node.id));
  const branch = mapped === undefined ? undefined : snapshot.branches[mapped.branch];
  if (branch === undefined || (branch.status !== "archived" && matchesScope(branch.scopeBinding, input.sessionId,
      input.record.commit_id.thread, input.record.epoch, node.id))) return undefined;
  if (!isTerminalNode(node)) {
    throw new SpineTreeScopeError("binding-conflict", "A historical Scope retained after reexecution or archival cannot become live again");
  }
  return branch;
}

function spawnEvidence(node: NodeSnapshot) {
  return node.memory?.flatMap(slot => "SpawnEvidence" in slot && sameNode(slot.SpawnEvidence.owner_node, node.id)
    ? [slot.SpawnEvidence] : []) ?? [];
}

/** A selected Spawn result has the identity established by its typed handoff.
 * Historical results use that persisted handoff, not the current commit's
 * execution list. Selectors cannot materialize a second ordinary result. */
function validateSpawnMapping(branch: SpineTreeBranch, node: NodeSnapshot, input: MappingReceipt): void {
  if (spawnEvidence(node).length === 0) return;
  const handoff = (branch.spawnReservation as SpawnReservation | undefined)?.handoff;
  if (handoff?.schema !== "spinetree.spawn.handoff/v1" || !matchesScope(handoff.to.scopeBinding,
      input.sessionId, input.record.commit_id.thread, input.record.epoch, node.id)) {
    throw new SpineTreeScopeError("binding-conflict", "A selected Spawn result requires its reserved branch and verified handoff");
  }
}

/** A reexecution has one inline result. Spawn terminals retain their own
 * reservation identities and cannot stand in for that result, even if a
 * selector omits them. Validate the whole projection before publishing. */
function validateReexecutionResult(snapshot: SpineTreeSnapshot, input: MappingReceipt): void {
  const home = snapshot.branches[snapshot.registry![input.agentId]!.branch]!;
  if (!isReexecutionOwner(home, input)) return;
  const nodes = new Map(input.projection.nodes.map(node => [JSON.stringify(node.id), node]));
  const top = input.projection.nodes.filter(node => node.kind === "Task" && node.parent !== null &&
    nodes.get(JSON.stringify(node.parent))?.kind === "RootEpoch");
  const inline = top.filter(node => spawnEvidence(node).length === 0);
  if (inline.length > 1 || (inline.length === 0 && home.reexecution!.state === "completed")) {
    throw new SpineTreeScopeError("binding-conflict", "Reexecution permits only one inline result Scope; result-level Next is not a completion");
  }
  const result = inline[0];
  if (result !== undefined && !matchesScope(home.scopeBinding, input.sessionId, input.record.commit_id.thread, input.record.epoch, result.id)) {
    throw new SpineTreeScopeError("binding-conflict", "The inline result Scope must map to its reexecution assignment");
  }
  for (const node of top.filter(node => spawnEvidence(node).length > 0)) {
    const branch = retainedTerminalMapping(snapshot, input, node) ?? Object.values(snapshot.branches).find(branch => matchesScope(branch.scopeBinding,
      input.sessionId, input.record.commit_id.thread, input.record.epoch, node.id));
    const handoff = (branch?.spawnReservation as SpawnReservation | undefined)?.handoff;
    if (handoff?.schema !== "spinetree.spawn.handoff/v1" || !matchesScope(handoff.to.scopeBinding,
        input.sessionId, input.record.commit_id.thread, input.record.epoch, node.id) ||
        (result !== undefined && node.start >= result.start)) {
      throw new SpineTreeScopeError("binding-conflict", "Top-level Spawn requires its verified handoff before the inline result Scope");
    }
  }
}

/** Only the new session named by the typed reservation may replace its home memory. */
function isReexecutionOwner(branch: SpineTreeBranch, input: Pick<Receipt, "binding">): boolean {
  const execution = branch.reexecution;
  const binding = input.binding;
  const owner = execution?.binding;
  return execution?.schema === "spinetree.reexecution/v1" &&
    (execution.state === "running" || execution.state === "completed") &&
    binding !== undefined && owner !== undefined && owner.operationId === execution.id &&
    binding.agentId === owner.agentId && binding.sessionId === owner.sessionId &&
    binding.bindingId === owner.bindingId && binding.leaseId === owner.leaseId && binding.branch === branch.id &&
    (execution.state === "completed" ? branch.memoryVersion === execution.source.memoryVersion + 1
      : branch.memoryVersion === execution.source.memoryVersion && JSON.stringify(branch.memorySource) === JSON.stringify(execution.source.memorySource));
}

interface SpawnReservation {
  readonly schema: "spinetree.spawn.reservation/v1";
  readonly state: string;
  readonly batchId: string;
  readonly ordinal: number;
  readonly attempt: number;
  readonly parentBindingId: string;
  readonly parentBranch: string;
  readonly parentAgentId: string;
  readonly parentScope?: Omit<SpineTreeScopeBinding, "agentId">;
  readonly task: SpawnTask;
  readonly agentId: string;
  readonly sessionId?: string;
  readonly launchId: string;
  readonly outcome: string | null;
  readonly handoff?: {
    readonly schema: "spinetree.spawn.handoff/v1";
    readonly to: { readonly parent: string; readonly scopeBinding: SpineTreeScopeBinding };
  };
  readonly [key: string]: unknown;
}

/** Import only the already-ended child execution named by this Spawn result.
 * The caller mutates an isolated snapshot, so handoff, memory and watermark
 * become visible together in its single CAS; rejection cannot partially cap it.
 */
function handoffSpawnScope(
  snapshot: SpineTreeSnapshot,
  branch: SpineTreeBranch,
  node: NodeSnapshot,
  input: MappingReceipt,
  branchByNode: ReadonlyMap<string, string>,
): SpineTreeBranch | undefined {
  const reservation = branch.spawnReservation as SpawnReservation | undefined;
  const evidence = spawnEvidence(node);
  if (reservation === undefined || evidence.length === 0) return undefined;
  const reject = (reason: string): never => {
    throw new SpineTreeScopeError("binding-conflict", `Spawn handoff for ${branch.id}: ${reason}`);
  };
  const binding = input.binding;
  if (reservation.schema !== "spinetree.spawn.reservation/v1" || binding === undefined ||
      reservation.parentAgentId !== input.agentId || reservation.parentBindingId !== binding.bindingId ||
      branch.parent !== reservation.parentBranch || branch.status === "archived" ||
      !Number.isSafeInteger(reservation.ordinal) || reservation.ordinal < 0 ||
      !Number.isSafeInteger(reservation.attempt) || reservation.attempt < 0 ||
      reservation.launchId !== `${reservation.batchId}:${reservation.ordinal}:attempt-${reservation.attempt}` ||
      !["launched", "terminal"].includes(reservation.state)) {
    return reject("reservation does not authorize this parent binding");
  }
  const parentScope = reservation.parentScope;
  if (parentScope !== undefined && (parentScope.sessionId !== input.sessionId ||
      parentScope.thread !== input.record.commit_id.thread || parentScope.epoch !== input.record.epoch ||
      JSON.stringify(parentScope.nodeId) !== JSON.stringify(node.parent))) {
    return reject("Spawn parent differs from its reserved canonical Scope");
  }
  const executions = input.record.executions.filter(execution => execution.operation.type === "spawn" &&
    execution.origin.execution_ref === reservation.batchId);
  const execution = executions[0];
  if (executions.length !== 1 || execution?.operation.type !== "spawn") return reject("committed Spawn batch is missing or ambiguous");
  const operation = execution.operation;
  const task = operation.tasks[reservation.ordinal];
  const results = operation.terminal_results.filter(result => result.ordinal === reservation.ordinal);
  const result = results[0];
  const sameTask = (left: SpawnTask | undefined, right: SpawnTask) => left !== undefined &&
    left.summary === right.summary && left.prompt === right.prompt;
  const item = evidence[0];
  if (!isTerminalNode(node) || result === undefined || results.length !== 1 || evidence.length !== 1 ||
      !sameTask(task, reservation.task) || !sameTask(item?.task, reservation.task) ||
      item?.outcome !== result.outcome || item.execution_ref !== result.execution_ref ||
      JSON.stringify(item.owner_node) !== JSON.stringify(node.id) ||
      // Imported child sessions rebase canonical node boundaries; local
      // execution ordinals are a different coordinate space after import.
      item.source.start !== node.start || item.source.end !== node.end ||
      (reservation.state === "terminal" && reservation.outcome !== result.outcome)) {
    return reject("terminal evidence does not match the reserved task and ordinal");
  }
  const child = snapshot.registry?.[reservation.agentId] as SpineTreeWorkingBinding | undefined;
  const previous = branch.scopeBinding;
  if (child === undefined || child.agentId !== reservation.agentId || child.branch !== branch.id ||
      child.status !== "ended" || typeof child.bindingId !== "string" || typeof child.leaseId !== "string" ||
      result.execution_ref !== `${reservation.launchId}:${child.sessionId}` ||
      (reservation.sessionId !== undefined && reservation.sessionId !== child.sessionId) ||
      (previous !== undefined && (previous.agentId !== child.agentId || previous.sessionId !== child.sessionId ||
        previous.epoch !== child.epoch))) {
    return reject("child binding is active or differs from terminal execution identity");
  }
  if (previous !== undefined) {
    const imported = snapshot.scopeImports?.[JSON.stringify([previous.sessionId, previous.thread])];
    if (imported === undefined || imported.epoch !== previous.epoch) {
      return reject("child Scope has no matching canonical import");
    }
  }
  const parentNode = input.projection.nodes.find(candidate => JSON.stringify(candidate.id) === JSON.stringify(node.parent));
  const parent = node.parent === null ? undefined : branchByNode.get(JSON.stringify(node.parent)) ??
    Object.values(snapshot.branches).find(candidate => matchesScope(candidate.scopeBinding,
      input.sessionId, input.record.commit_id.thread, input.record.epoch, node.parent!))?.id;
  // The committed canonical parent owns the terminal task. Agent home remains
  // its stable lease, not the destination for every nested Spawn.
  const targetParent = parentNode?.kind === "Task" ? parent : binding.branch;
  if (targetParent === undefined || snapshot.branches[targetParent]?.status === "archived" ||
      snapshot.branches[targetParent] === undefined || targetParent === branch.id) {
    return reject("committed Spawn parent is not mapped to a live project branch");
  }
  if (targetParent !== reservation.parentBranch) {
    return reject("reserved Scope no longer maps to the launch ProjectBranch");
  }
  const to: SpineTreeScopeBinding = {
    agentId: input.agentId, sessionId: input.sessionId, thread: input.record.commit_id.thread,
    epoch: input.record.epoch, nodeId: [...node.id],
  };
  return {
    ...branch,
    spawnReservation: {
      ...reservation, state: "terminal", outcome: result.outcome,
      handoff: {
        schema: "spinetree.spawn.handoff/v1", transactionId: input.transactionId,
        commitId: structuredClone(input.record.commit_id),
        from: { binding: structuredClone(child), scopeBinding: structuredClone(previous ?? null), memorySource: structuredClone(branch.memorySource) },
        to: { parent: targetParent, scopeBinding: to },
      },
    },
  };
}

function isTerminalNode(node: NodeSnapshot): boolean {
  return node.status !== "Live" && node.status !== "Opened";
}

function matchesScope(bound: SpineTreeScopeBinding | undefined, sessionId: string, thread: string, epoch: number, nodeId: readonly number[]): boolean {
  return bound !== undefined && bound.sessionId === sessionId && bound.thread === thread && bound.epoch === epoch &&
    JSON.stringify(bound.nodeId) === JSON.stringify(nodeId);
}

function importNode(branch: SpineTreeBranch, node: NodeSnapshot, input: MappingReceipt): SpineTreeBranch {
  if (node.status === "Live" || node.status === "Opened") return branch;
  if (node.memory === null) throw new SpineTreeScopeError("unsupported-scope", "Terminal scope has no canonical memory");
  const source: SpineTreeScopeMemorySource = {
    ...branch.scopeBinding!, schema: "spinetree.scope.memory/v1", transactionId: input.transactionId,
    commitId: structuredClone(input.record.commit_id), postBoundary: structuredClone(input.record.post_boundary),
  };
  return {
    ...branch, status: "capped", memory: structuredClone(node.memory), memoryVersion: branch.memoryVersion + 1, memorySource: source,
  };
}
