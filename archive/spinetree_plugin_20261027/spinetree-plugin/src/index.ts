import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { PiSessionAdapter, PluginManifest, PluginTool, SpinePlugin, SpinePluginContext } from "@spinejit/spine-host";
import { spineTreeManifestFor, spineTreeToolsFor } from "./loadable.js";
import { toolContracts } from "./tool-contracts.js";
export * from "./loadable.js";
import type { SpineTreeScopeBinding, SpineTreeScopeWatermark } from "./scopes.js";
export * from "./scopes.js";

export const SPINETREE_SNAPSHOT_SCHEMA = "spinetree.snapshot/v2" as const;
export const SPINETREE_READ_RESULT_SCHEMA = "spinetree.read.result/v2" as const;
export const SPINETREE_CHANGE_RESULT_SCHEMA = "spinetree.change.result/v1" as const;
export const SPINETREE_SEND_RESULT_SCHEMA = "spinetree.send.result/v2" as const;
export const SPINETREE_OBSERVE_RESULT_SCHEMA = "spinetree.observe.result/v1" as const;
const SPINETREE_REF_LOCK_TIMEOUT_MS = 1000;

export interface SpineTreeBranch {
  readonly id: string;
  readonly parent: string | null;
  readonly goal: string;
  readonly constraints: readonly unknown[];
  readonly skills: readonly unknown[];
  readonly tools: readonly unknown[];
  readonly memory: unknown;
  readonly memoryVersion: number;
  readonly memorySource: unknown;
  readonly status: string;
  readonly scopeBinding?: SpineTreeScopeBinding;
  readonly reexecution?: SpineTreeReexecution;
  /** Changes only when this ProjectBranch value changes. Absent means 0. */
  readonly revision?: number;
  readonly [key: string]: unknown;
}

/** A new execution of a ProjectBranch; canonical scopes themselves are never reopened. */
export interface SpineTreeReexecution {
  readonly schema: "spinetree.reexecution/v1";
  readonly id: string;
  readonly state: "reserved" | "running" | "completed" | "failed";
  readonly parent: string;
  readonly sourceHead: string;
  readonly source: {
    readonly memory: unknown;
    readonly memoryVersion: number;
    readonly memorySource: unknown;
    readonly scopeBinding?: SpineTreeScopeBinding;
  };
  readonly binding?: SpineTreeWorkingBinding;
  readonly terminalSource?: unknown;
}

export interface SpineTreeSnapshot {
  readonly schema: typeof SPINETREE_SNAPSHOT_SCHEMA;
  readonly branches: Readonly<Record<string, SpineTreeBranch>>;
  readonly registry?: Readonly<Record<string, SpineTreeAgentBinding>>;
  readonly mailbox?: SpineTreeMailboxState;
  readonly scopeImports?: Readonly<Record<string, SpineTreeScopeWatermark>>;
}

type DraftSpineTreeBranch = { -readonly [Key in keyof SpineTreeBranch]: SpineTreeBranch[Key] };

export interface SpineTreeSnapshotStore {
  head(): string | Promise<string>;
  readSnapshot(head: string): SpineTreeSnapshot | Promise<SpineTreeSnapshot>;
}

export interface SpineTreeSnapshotCommit {
  readonly parent: string;
  readonly head: string;
}

export interface SpineTreeSnapshotCommitStore extends SpineTreeSnapshotStore {
  commitSnapshot(
    expectedHead: string,
    snapshot: SpineTreeSnapshot,
    message?: string,
  ): SpineTreeSnapshotCommit | Promise<SpineTreeSnapshotCommit>;
}

export type SpineTreeChange =
  | { readonly type: "update"; readonly branch: string; readonly attributes: Readonly<Record<string, unknown>> }
  | { readonly type: "move"; readonly branch: string; readonly parent: string }
  | { readonly type: "archive"; readonly branch: string };

export interface SpineTreeChangeResult {
  readonly schema: typeof SPINETREE_CHANGE_RESULT_SCHEMA;
  readonly parent: string;
  readonly head: string;
  readonly changes: readonly SpineTreeChange[];
}

/** The model named a ProjectBranch value that is no longer current. Nothing was written. */
export interface SpineTreeBranchConflict {
  readonly schema: typeof SPINETREE_CHANGE_RESULT_SCHEMA;
  readonly applied: false;
  readonly branches: readonly SpineTreeBranch[];
}

export interface SpineTreeChangeStore extends SpineTreeSnapshotStore {
  change(expectedHead: string, changes: readonly SpineTreeChange[]): SpineTreeChangeResult | Promise<SpineTreeChangeResult>;
}

export interface SpineTreeAgentBinding {
  readonly agentId: string;
  readonly sessionId: string;
  readonly branch: string;
  readonly scope?: string;
  /** D3 WorkingBinding identity; required for binding-aware mailbox dispatch. */
  readonly bindingId?: string;
  readonly status: "running" | "paused" | "ended";
}

/** The non-optional execution lease required by an ordinary Agent launcher. */
export interface SpineTreeWorkingBinding extends SpineTreeAgentBinding {
  readonly bindingId: string;
  readonly leaseId: string;
  readonly operationId: string;
  readonly epoch: number;
  readonly scopeCursor: readonly number[];
}

export interface SpineTreeWorkingUpdate {
  readonly epoch: number;
  readonly scopeCursor: readonly number[];
}

export type SpineTreeAgentStatus = SpineTreeAgentBinding["status"];

export interface SpineTreeAgentRegistry {
  register(binding: SpineTreeAgentBinding): void | Promise<void>;
  resolve(agentId: string): SpineTreeAgentBinding | undefined | Promise<SpineTreeAgentBinding | undefined>;
}

export interface SpineTreeAgentLifecycleRegistry extends SpineTreeAgentRegistry {
  transition(agentId: string, status: SpineTreeAgentStatus): SpineTreeAgentBinding | Promise<SpineTreeAgentBinding>;
}

export interface SpineTreeAgentRegistryReader {
  list(branch?: string): readonly SpineTreeAgentBinding[] | Promise<readonly SpineTreeAgentBinding[]>;
}

export interface SpineTreeExclusiveAgentRegistry {
  registerExclusive(binding: SpineTreeAgentBinding): void | Promise<void>;
}

export interface SpineTreeWorkingAgentRegistry extends SpineTreeAgentLifecycleRegistry, SpineTreeAgentRegistryReader {
  registerWorkingExclusive(binding: SpineTreeWorkingBinding): void | Promise<void>;
  transitionWorking(agentId: string, leaseId: string, expected: SpineTreeAgentStatus, status: SpineTreeAgentStatus):
    SpineTreeWorkingBinding | Promise<SpineTreeWorkingBinding>;
  updateWorking(
    agentId: string,
    leaseId: string,
    update: SpineTreeWorkingUpdate,
  ): SpineTreeWorkingBinding | Promise<SpineTreeWorkingBinding>;
}

export class MemoryAgentRegistry implements SpineTreeWorkingAgentRegistry, SpineTreeExclusiveAgentRegistry {
  readonly #bindings = new Map<string, SpineTreeAgentBinding>();

  register(binding: SpineTreeAgentBinding): void {
    validateBinding(binding);
    if (this.#bindings.has(binding.agentId)) {
      throw new SpineTreeRegistryError("duplicate-agent", `Agent ${binding.agentId} is already registered`);
    }
    this.#bindings.set(binding.agentId, clone(binding));
  }

  resolve(agentId: string): SpineTreeAgentBinding | undefined {
    const binding = this.#bindings.get(agentId);
    return binding === undefined ? undefined : clone(binding);
  }

  transition(agentId: string, status: SpineTreeAgentStatus): SpineTreeAgentBinding {
    const binding = this.#bindings.get(agentId);
    if (binding === undefined) throw new SpineTreeRegistryError("unknown-agent", `Unknown Agent ${agentId}`);
    const next = transitionBinding(binding, status);
    this.#bindings.set(agentId, next);
    return clone(next);
  }

  list(branch?: string): readonly SpineTreeAgentBinding[] {
    return [...this.#bindings.values()]
      .filter(binding => branch === undefined || binding.branch === branch)
      .map(binding => clone(binding));
  }

  registerExclusive(binding: SpineTreeAgentBinding): void {
    validateBinding(binding);
    if (this.#bindings.has(binding.agentId)) {
      throw new SpineTreeRegistryError("duplicate-agent", `Agent ${binding.agentId} is already registered`);
    }
    if ([...this.#bindings.values()].some(existing => existing.branch === binding.branch && existing.status !== "ended")) {
      throw new SpineTreeRegistryError("branch-occupied", `ProjectBranch ${binding.branch} already has an active Agent`);
    }
    this.#bindings.set(binding.agentId, clone(binding));
  }

  registerWorkingExclusive(binding: SpineTreeWorkingBinding): void {
    validateWorkingBinding(binding);
    this.registerExclusive(binding);
  }

  transitionWorking(agentId: string, leaseId: string, expected: SpineTreeAgentStatus, status: SpineTreeAgentStatus): SpineTreeWorkingBinding {
    const next = transitionWorkingBinding(this.#bindings.get(agentId), leaseId, expected, status);
    this.#bindings.set(agentId, next);
    return clone(next);
  }

  updateWorking(agentId: string, leaseId: string, update: SpineTreeWorkingUpdate): SpineTreeWorkingBinding {
    const binding = this.#bindings.get(agentId);
    if (binding === undefined) throw new SpineTreeRegistryError("unknown-agent", `Unknown Agent ${agentId}`);
    const next = updateWorkingBinding(binding, leaseId, update);
    this.#bindings.set(agentId, next);
    return clone(next);
  }
}

/** A registry persisted in the same immutable snapshot/HEAD as the tree. */
export class GitSpineTreeAgentRegistry implements SpineTreeWorkingAgentRegistry, SpineTreeExclusiveAgentRegistry {
  readonly store: SpineTreeSnapshotCommitStore;
  readonly #maxCasRetries: number;

  constructor(storeOrRoot: SpineTreeSnapshotCommitStore | string, options: { maxCasRetries?: number } = {}) {
    this.store = asCommitStore(storeOrRoot);
    this.#maxCasRetries = validateCasRetries(options.maxCasRetries);
  }

  async register(binding: SpineTreeAgentBinding): Promise<void> {
    validateBinding(binding);
    await mutateSnapshotWithRetry(
      this.store,
      this.#maxCasRetries,
      "spinetree: registry register",
      snapshot => {
        const registry = { ...(snapshot.registry ?? {}) };
        if (registry[binding.agentId] !== undefined) {
          throw new SpineTreeRegistryError("duplicate-agent", `Agent ${binding.agentId} is already registered`);
        }
        registry[binding.agentId] = clone(binding);
        return { snapshot: { ...snapshot, registry }, value: undefined };
      },
    );
  }

  async resolve(agentId: string): Promise<SpineTreeAgentBinding | undefined> {
    const head = await this.store.head();
    const snapshot = await this.store.readSnapshot(head);
    const binding = snapshot.registry?.[agentId];
    return binding === undefined ? undefined : clone(binding);
  }

  async transition(agentId: string, status: SpineTreeAgentStatus): Promise<SpineTreeAgentBinding> {
    validateAgentStatus(status);
    return mutateSnapshotWithRetry(
      this.store,
      this.#maxCasRetries,
      "spinetree: registry status transition",
      snapshot => {
        const registry = { ...(snapshot.registry ?? {}) };
        const binding = registry[agentId];
        if (binding === undefined) throw new SpineTreeRegistryError("unknown-agent", `Unknown Agent ${agentId}`);
        const next = transitionBinding(binding, status);
        if (next.status === binding.status) return { snapshot, value: clone(next) };
        registry[agentId] = next;
        return { snapshot: { ...snapshot, registry }, value: clone(next) };
      },
    );
  }

  async list(branch?: string): Promise<readonly SpineTreeAgentBinding[]> {
    const head = await this.store.head();
    const snapshot = await this.store.readSnapshot(head);
    return Object.values(snapshot.registry ?? {})
      .filter(binding => branch === undefined || binding.branch === branch)
      .map(binding => clone(binding));
  }

  async registerExclusive(binding: SpineTreeAgentBinding): Promise<void> {
    validateBinding(binding);
    await mutateSnapshotWithRetry(
      this.store,
      this.#maxCasRetries,
      "spinetree: registry exclusive register",
      snapshot => {
        const registry = { ...(snapshot.registry ?? {}) };
        if (registry[binding.agentId] !== undefined) {
          throw new SpineTreeRegistryError("duplicate-agent", `Agent ${binding.agentId} is already registered`);
        }
        if (activeBranchBindings(snapshot, binding.branch).length > 0 || snapshot.branches[binding.branch]?.reexecution?.state === "reserved") {
          throw new SpineTreeRegistryError("branch-occupied", `ProjectBranch ${binding.branch} already has an active Agent`);
        }
        registry[binding.agentId] = clone(binding);
        return { snapshot: { ...snapshot, registry }, value: undefined };
      },
    );
  }

  async rejuvenate(input: SpineTreeRejuvenateInput, rejuvenator: SpineTreeRejuvenator): Promise<SpineTreeRejuvenateResult> {
    return rejuvenateBranch(this.store, this.#maxCasRetries, input, rejuvenator);
  }

  async registerWorkingExclusive(binding: SpineTreeWorkingBinding): Promise<void> {
    validateWorkingBinding(binding);
    await this.registerExclusive(binding);
  }

  async transitionWorking(agentId: string, leaseId: string, expected: SpineTreeAgentStatus, status: SpineTreeAgentStatus): Promise<SpineTreeWorkingBinding> {
    return mutateSnapshotWithRetry(this.store, this.#maxCasRetries, "spinetree: working lease status transition", snapshot => {
      const next = transitionWorkingBinding(snapshot.registry?.[agentId], leaseId, expected, status);
      return { snapshot: { ...snapshot, registry: { ...snapshot.registry, [agentId]: next } }, value: clone(next) };
    });
  }

  async updateWorking(agentId: string, leaseId: string, update: SpineTreeWorkingUpdate): Promise<SpineTreeWorkingBinding> {
    return mutateSnapshotWithRetry(
      this.store,
      this.#maxCasRetries,
      "spinetree: registry working lease update",
      snapshot => {
        const registry = { ...(snapshot.registry ?? {}) };
        const binding = registry[agentId];
        if (binding === undefined) throw new SpineTreeRegistryError("unknown-agent", `Unknown Agent ${agentId}`);
        const next = updateWorkingBinding(binding, leaseId, update);
        registry[agentId] = next;
        return { snapshot: { ...snapshot, registry }, value: clone(next) };
      },
    );
  }
}

export class SpineTreeRegistryError extends Error {
  readonly code: "invalid-binding" | "invalid-working-binding" | "stale-lease" | "duplicate-agent" | "branch-occupied" | "unknown-agent" | "invalid-transition";

  constructor(code: SpineTreeRegistryError["code"], message: string) {
    super(message);
    this.name = "SpineTreeRegistryError";
    this.code = code;
  }
}

export type SpineTreeReceiptStatus = "queued" | "leased" | "delivered" | "observed" | "failed";

export interface SpineTreeReceipt {
  readonly id: string;
  readonly to: string;
  readonly from: string | null;
  readonly message: string;
  readonly requestId?: string;
  /** Exact endpoint admitted by a configured transport; never retargeted on retry. */
  readonly recipient?: SpineTreeRecipientBinding;
  readonly status: SpineTreeReceiptStatus;
  readonly attempt: number;
  readonly leaseId: string | null;
  /** Set when this delivery was leased against a D3 WorkingBinding. */
  readonly bindingId?: string;
  readonly leaseUntil: number | null;
  readonly nextAttemptAt: number | null;
  readonly lastError: string | null;
}

export interface SpineTreeMailboxState {
  readonly sequence: number;
  readonly leaseSequence: number;
  readonly receipts: Readonly<Record<string, SpineTreeReceipt>>;
  readonly requestIds: Readonly<Record<string, string>>;
}

export interface SpineTreeMailboxInput {
  readonly to: string;
  readonly from: string | null;
  readonly message: string;
  readonly requestId?: string;
  readonly recipient?: SpineTreeRecipientBinding;
}

export interface SpineTreeMailboxBinding {
  readonly agentId: string;
  readonly sessionId: string;
  readonly bindingId?: string;
  readonly leaseId?: string;
}

export interface SpineTreeRecipientBinding extends SpineTreeMailboxBinding {
  readonly bindingId: string;
  readonly leaseId: string;
}

/** Reachable endpoint identities, including owned sessions that are temporarily busy. */
export type SpineTreeTransportDomain = () => readonly SpineTreeRecipientBinding[] | Promise<readonly SpineTreeRecipientBinding[]>;

export interface SpineTreeMailbox {
  enqueue(input: SpineTreeMailboxInput): SpineTreeReceipt | Promise<SpineTreeReceipt>;
  lease(receiptId: string, binding?: SpineTreeMailboxBinding): SpineTreeReceipt | Promise<SpineTreeReceipt>;
  delivered(receiptId: string, leaseId: string, bindingId?: string): SpineTreeReceipt | Promise<SpineTreeReceipt>;
  release(receiptId: string, leaseId: string, error: string, bindingId?: string): SpineTreeReceipt | Promise<SpineTreeReceipt>;
  fail(receiptId: string, leaseId: string, error: string, bindingId?: string): SpineTreeReceipt | Promise<SpineTreeReceipt>;
  observed(receiptId: string, leaseId?: string, bindingId?: string): SpineTreeReceipt | Promise<SpineTreeReceipt>;
}

export interface SpineTreeMailboxReader {
  receipt(receiptId: string): SpineTreeReceipt | Promise<SpineTreeReceipt>;
}

export interface SpineTreeDispatchMailbox extends SpineTreeMailbox, SpineTreeMailboxReader {
  /** Filter recipients before limiting due queued receipts and expired leases. */
  pending(limit: number, recipients?: readonly SpineTreeRecipientBinding[]): readonly SpineTreeReceipt[] | Promise<readonly SpineTreeReceipt[]>;
}

export const SPINETREE_MESSAGE_SCHEMA = "spinetree.message/v1" as const;

/** Recipient-visible prompt payload; leaseId identifies this delivery attempt. */
export interface SpineTreeMessage {
  readonly schema: typeof SPINETREE_MESSAGE_SCHEMA;
  readonly receiptId: string;
  readonly leaseId: string;
  readonly bindingId?: string;
  readonly to: string;
  readonly from: string | null;
  readonly message: string;
}

export interface SpineTreeDispatchResult {
  readonly receipts: readonly SpineTreeReceipt[];
  readonly skipped: readonly string[];
}

export class SpineTreeMailboxError extends Error {
  readonly code: "unknown-receipt" | "invalid-state" | "lease-conflict";

  constructor(code: SpineTreeMailboxError["code"], message: string) {
    super(message);
    this.name = "SpineTreeMailboxError";
    this.code = code;
  }
}

/** A deterministic in-memory mailbox. It preserves receipt IDs across retries. */
export class MemorySpineTreeMailbox implements SpineTreeDispatchMailbox {
  #sequence = 0;
  #leaseSequence = 0;
  readonly #receipts = new Map<string, SpineTreeReceipt>();
  readonly #requestIds = new Map<string, string>();

  enqueue(input: SpineTreeMailboxInput): SpineTreeReceipt {
    validateMailboxInput(input);
    if (input.requestId !== undefined) {
      const existingId = this.#requestIds.get(input.requestId);
      if (existingId !== undefined) {
        const existing = this.#receipt(existingId);
        if (!sameMailboxInput(existing, input)) {
          throw new SpineTreeMailboxError("invalid-state", `Request ${input.requestId} is already bound to another message`);
        }
        return clone(existing);
      }
    }
    const receipt: SpineTreeReceipt = {
      id: `mail-${++this.#sequence}`,
      to: input.to,
      from: input.from,
      message: input.message,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      ...(input.recipient === undefined ? {} : { recipient: clone(input.recipient) }),
      status: "queued",
      attempt: 0,
      leaseId: null,
      leaseUntil: null,
      nextAttemptAt: null,
      lastError: null,
    };
    this.#receipts.set(receipt.id, receipt);
    if (input.requestId !== undefined) this.#requestIds.set(input.requestId, receipt.id);
    return clone(receipt);
  }

  lease(receiptId: string, binding?: SpineTreeMailboxBinding): SpineTreeReceipt {
    const receipt = this.receipt(receiptId);
    const now = Date.now();
    requireLeaseable(receipt, now);
    requireRecipient(receipt, binding);
    const next = {
      ...receipt,
      ...(binding?.bindingId === undefined ? {} : { bindingId: binding.bindingId }),
      status: "leased" as const,
      attempt: receipt.attempt + 1,
      leaseId: `lease-${++this.#leaseSequence}`,
      leaseUntil: now + 30_000,
      nextAttemptAt: null,
    };
    this.#receipts.set(receiptId, next);
    return clone(next);
  }

  delivered(receiptId: string, leaseId: string, bindingId?: string): SpineTreeReceipt {
    return this.#leaseMutation(receiptId, leaseId, "delivered", null, bindingId);
  }

  release(receiptId: string, leaseId: string, error: string, bindingId?: string): SpineTreeReceipt {
    return this.#leaseMutation(receiptId, leaseId, "queued", error, bindingId);
  }

  fail(receiptId: string, leaseId: string, error: string, bindingId?: string): SpineTreeReceipt {
    return this.#leaseMutation(receiptId, leaseId, "failed", error, bindingId);
  }

  #leaseMutation(receiptId: string, leaseId: string, status: "queued" | "delivered" | "failed", error: string | null, bindingId?: string): SpineTreeReceipt {
    const receipt = this.#receipt(receiptId);
    const next = completeDelivery(receipt, leaseId, status, error, bindingId);
    if (next !== receipt) this.#receipts.set(receiptId, next);
    return clone(next);
  }

  observed(receiptId: string, leaseId?: string, bindingId?: string): SpineTreeReceipt {
    const receipt = this.#receipt(receiptId);
    const next = observeReceipt(receipt, leaseId, bindingId);
    if (next !== receipt) this.#receipts.set(receiptId, next);
    return clone(next);
  }

  #receipt(receiptId: string): SpineTreeReceipt {
    const receipt = this.#receipts.get(receiptId);
    if (receipt === undefined) throw new SpineTreeMailboxError("unknown-receipt", `Unknown receipt ${receiptId}`);
    return receipt;
  }

  receipt(receiptId: string): SpineTreeReceipt {
    return clone(this.#receipt(receiptId));
  }

  pending(limit: number, recipients?: readonly SpineTreeRecipientBinding[]): readonly SpineTreeReceipt[] {
    return pendingReceipts(this.#receipts.values(), limit, Date.now(), recipients);
  }
}

/** A mailbox persisted in the same immutable snapshot/HEAD as the tree. */
export class GitSpineTreeMailbox implements SpineTreeDispatchMailbox {
  readonly store: SpineTreeSnapshotCommitStore;
  readonly #maxCasRetries: number;

  constructor(storeOrRoot: SpineTreeSnapshotCommitStore | string, options: { maxCasRetries?: number } = {}) {
    this.store = asCommitStore(storeOrRoot);
    this.#maxCasRetries = validateCasRetries(options.maxCasRetries);
  }

  async enqueue(input: SpineTreeMailboxInput): Promise<SpineTreeReceipt> {
    validateMailboxInput(input);
    return mutateSnapshotWithRetry(
      this.store,
      this.#maxCasRetries,
      "spinetree: mailbox enqueue",
      snapshot => {
        const state = mailboxState(snapshot.mailbox);
        if (input.requestId !== undefined) {
          const existingId = state.requestIds[input.requestId];
          if (existingId !== undefined) {
            const existing = receiptFromState(state, existingId);
            if (!sameMailboxInput(existing, input)) {
              throw new SpineTreeMailboxError("invalid-state", `Request ${input.requestId} is already bound to another message`);
            }
            return { snapshot, value: existing };
          }
        }
        if (input.recipient !== undefined) requireCurrentRecipient(input.recipient, snapshot);
        const receipt: SpineTreeReceipt = {
          id: `mail-${state.sequence + 1}`,
          to: input.to,
          from: input.from,
          message: input.message,
          ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
          ...(input.recipient === undefined ? {} : { recipient: clone(input.recipient) }),
          status: "queued",
          attempt: 0,
          leaseId: null,
          leaseUntil: null,
          nextAttemptAt: null,
          lastError: null,
        };
        state.sequence += 1;
        state.receipts[receipt.id] = receipt;
        if (input.requestId !== undefined) state.requestIds[input.requestId] = receipt.id;
        return { snapshot: { ...snapshot, mailbox: state }, value: clone(receipt) };
      },
    );
  }

  async lease(receiptId: string, binding?: SpineTreeMailboxBinding): Promise<SpineTreeReceipt> {
    return mutateSnapshotWithRetry(
      this.store,
      this.#maxCasRetries,
      "spinetree: mailbox lease",
      snapshot => {
        const state = mailboxState(snapshot.mailbox);
        const receipt = receiptFromState(state, receiptId);
        const now = Date.now();
        requireLeaseable(receipt, now);
        requireRecipient(receipt, binding);
        if (receipt.recipient !== undefined) requireCurrentRecipient(receipt.recipient, snapshot);
        const next: SpineTreeReceipt = {
          ...receipt,
          ...(binding?.bindingId === undefined ? {} : { bindingId: binding.bindingId }),
          status: "leased",
          attempt: receipt.attempt + 1,
          leaseId: `lease-${state.leaseSequence + 1}`,
          leaseUntil: now + 30_000,
          nextAttemptAt: null,
        };
        state.leaseSequence += 1;
        state.receipts[receiptId] = next;
        return { snapshot: { ...snapshot, mailbox: state }, value: clone(next) };
      },
    );
  }

  async delivered(receiptId: string, leaseId: string, bindingId?: string): Promise<SpineTreeReceipt> {
    return this.#leaseMutation(receiptId, leaseId, "delivered", null, "spinetree: mailbox delivered", bindingId);
  }

  async release(receiptId: string, leaseId: string, error: string, bindingId?: string): Promise<SpineTreeReceipt> {
    return this.#leaseMutation(receiptId, leaseId, "queued", error, "spinetree: mailbox release", bindingId);
  }

  async fail(receiptId: string, leaseId: string, error: string, bindingId?: string): Promise<SpineTreeReceipt> {
    return this.#leaseMutation(receiptId, leaseId, "failed", error, "spinetree: mailbox fail", bindingId);
  }

  async observed(receiptId: string, leaseId?: string, bindingId?: string): Promise<SpineTreeReceipt> {
    return mutateSnapshotWithRetry(
      this.store,
      this.#maxCasRetries,
      "spinetree: mailbox observed",
      snapshot => {
        const state = mailboxState(snapshot.mailbox);
        const receipt = receiptFromState(state, receiptId);
        if (receipt.recipient !== undefined) requireCurrentRecipient(receipt.recipient, snapshot);
        const next = observeReceipt(receipt, leaseId, bindingId);
        if (next === receipt) return { snapshot, value: receipt };
        state.receipts[receiptId] = next;
        return { snapshot: { ...snapshot, mailbox: state }, value: clone(next) };
      },
    );
  }

  async receipt(receiptId: string): Promise<SpineTreeReceipt> {
    const head = await this.store.head();
    const snapshot = await this.store.readSnapshot(head);
    return receiptFromState(mailboxState(snapshot.mailbox), receiptId);
  }

  async pending(limit: number, recipients?: readonly SpineTreeRecipientBinding[]): Promise<readonly SpineTreeReceipt[]> {
    validateDispatchLimit(limit);
    const now = Date.now();
    const head = await this.store.head();
    const snapshot = await this.store.readSnapshot(head);
    return pendingReceipts(Object.values(snapshot.mailbox?.receipts ?? {}), limit, now, recipients);
  }

  async #leaseMutation(
    receiptId: string,
    leaseId: string,
    status: "queued" | "delivered" | "failed",
    error: string | null,
    message: string,
    bindingId?: string,
  ): Promise<SpineTreeReceipt> {
    return mutateSnapshotWithRetry(
      this.store,
      this.#maxCasRetries,
      message,
      snapshot => {
        const state = mailboxState(snapshot.mailbox);
        const receipt = receiptFromState(state, receiptId);
        if (receipt.recipient !== undefined && receipt.status !== "observed") requireCurrentRecipient(receipt.recipient, snapshot);
        const next = completeDelivery(receipt, leaseId, status, error, bindingId);
        if (next === receipt) return { snapshot, value: receipt };
        state.receipts[receiptId] = next;
        return { snapshot: { ...snapshot, mailbox: state }, value: clone(next) };
      },
    );
  }
}

/** Dispatch one bounded batch. The caller owns scheduling and the session adapter. */
export async function dispatchSpineTreeMailbox(options: {
  readonly registry: SpineTreeAgentRegistry;
  readonly mailbox: SpineTreeDispatchMailbox;
  readonly sessions: PiSessionAdapter;
  readonly transportDomain?: SpineTreeTransportDomain;
  readonly limit?: number;
}): Promise<SpineTreeDispatchResult> {
  const { registry, mailbox, sessions, transportDomain, limit = 100 } = options;
  validateDispatchLimit(limit);
  const recipients = transportDomain === undefined ? undefined : validateRecipients(await transportDomain());
  const pending = await mailbox.pending(limit, recipients);
  const receipts: SpineTreeReceipt[] = [];
  const skipped: string[] = [];
  for (const candidate of pending.slice(0, limit)) {
    const target = await registry.resolve(candidate.to);
    if ((recipients !== undefined && (target?.status !== "running" ||
        !recipients.some(recipient => sameRecipient(recipient, target)))) ||
        (candidate.recipient !== undefined && !sameRecipient(candidate.recipient, target))) {
      skipped.push(candidate.id);
      continue;
    }
    let leased: SpineTreeReceipt;
    try {
      leased = await mailbox.lease(candidate.id, target);
    } catch (error) {
      if (error instanceof SpineTreeMailboxError && (error.code === "lease-conflict" || error.code === "invalid-state")) {
        skipped.push(candidate.id);
        continue;
      }
      throw error;
    }
    if (leased.bindingId !== undefined && target?.bindingId !== leased.bindingId) {
      skipped.push(candidate.id);
      continue;
    }
    if (target === undefined || target.status === "ended") {
      receipts.push(await mailbox.fail(leased.id, leased.leaseId!,
        target === undefined ? `Unknown Agent ${leased.to}` : `Agent ${leased.to} has ended`, leased.bindingId));
    } else {
      receipts.push(await deliverReceipt(mailbox, sessions, leased, target, () => registry.resolve(leased.to)));
    }
  }
  return { receipts, skipped };
}

export class SpineTreeChangeError extends Error {
  readonly code: "invalid-input" | "invalid-change" | "unknown-branch" | "unknown-head" | "stale-head";

  constructor(
    code: SpineTreeChangeError["code"],
    message: string,
  ) {
    super(message);
    this.name = "SpineTreeChangeError";
    this.code = code;
  }
}

/** A deterministic in-memory store for exercising immutable snapshots and CAS semantics. */
export class MemorySpineTreeStore implements SpineTreeChangeStore {
  #head: string;
  #revision = 0;
  readonly #snapshots = new Map<string, SpineTreeSnapshot>();

  constructor(snapshot: SpineTreeSnapshot, initialHead = "memory-0") {
    if (initialHead.length === 0) throw new TypeError("initialHead must be non-empty");
    this.#head = initialHead;
    this.#snapshots.set(initialHead, clone(parseSnapshot(snapshot)));
  }

  head(): string {
    return this.#head;
  }

  readSnapshot(head: string): SpineTreeSnapshot {
    const snapshot = this.#snapshots.get(head);
    if (snapshot === undefined) {
      throw new SpineTreeChangeError("unknown-head", `Unknown SpineTree HEAD ${head}`);
    }
    return clone(snapshot);
  }

  change(expectedHead: string, changes: readonly SpineTreeChange[]): SpineTreeChangeResult {
    if (expectedHead !== this.#head) {
      throw new SpineTreeChangeError(
        "stale-head",
        `SpineTree HEAD changed: expected ${expectedHead}, found ${this.#head}`,
      );
    }
    const current = this.#snapshots.get(this.#head);
    if (current === undefined) throw new SpineTreeChangeError("unknown-head", `Unknown SpineTree HEAD ${this.#head}`);
    const draft = clone(current);
    applyChanges(draft, changes);
    const parent = this.#head;
    const committed = this.commitSnapshot(parent, draft, "spinetree: change");
    return {
      schema: SPINETREE_CHANGE_RESULT_SCHEMA,
      parent,
      head: committed.head,
      changes: clone(changes),
    };
  }

  commitSnapshot(expectedHead: string, snapshot: SpineTreeSnapshot, _message = "spinetree: state"): SpineTreeSnapshotCommit {
    if (expectedHead !== this.#head) {
      throw new SpineTreeChangeError(
        "stale-head",
        `SpineTree HEAD changed: expected ${expectedHead}, found ${this.#head}`,
      );
    }
    const parent = this.#head;
    const previous = this.#snapshots.get(parent);
    if (previous === undefined) throw new SpineTreeChangeError("unknown-head", `Unknown SpineTree HEAD ${parent}`);
    const stamped = stampBranchRevisions(previous, parseSnapshot(snapshot));
    const head = `memory-${++this.#revision}`;
    this.#snapshots.set(head, clone(stamped));
    this.#head = head;
    return { parent, head };
  }
}

export class SpineTreeGitStoreError extends Error {
  readonly code: "invalid-root" | "not-initialized" | "invalid-head" | "invalid-snapshot" | "git-error";

  constructor(
    code: SpineTreeGitStoreError["code"],
    message: string,
  ) {
    super(message);
    this.name = "SpineTreeGitStoreError";
    this.code = code;
  }
}

/** A real `.spinetree` Git object store with immutable snapshots and ref-level CAS. */
export class GitSpineTreeStore implements SpineTreeChangeStore {
  readonly root: string;

  constructor(root: string) {
    if (typeof root !== "string" || root.length === 0) {
      throw new SpineTreeGitStoreError("invalid-root", "SpineTree Git root must be a non-empty path");
    }
    this.root = root;
    if (!existsSync(join(root, ".git"))) {
      throw new SpineTreeGitStoreError("not-initialized", `SpineTree Git root is not initialized: ${root}`);
    }
  }

  static initialize(root: string, snapshot: SpineTreeSnapshot): GitSpineTreeStore {
    if (typeof root !== "string" || root.length === 0) {
      throw new SpineTreeGitStoreError("invalid-root", "SpineTree Git root must be a non-empty path");
    }
    parseSnapshot(snapshot);
    mkdirSync(root, { recursive: true });
    const gitDir = join(root, ".git");
    if (existsSync(gitDir)) {
      throw new SpineTreeGitStoreError("invalid-root", `SpineTree Git root already exists: ${root}`);
    }
    runGit(root, ["init", "-q"]);
    runGit(root, ["config", "user.email", "spinetree@localhost"]);
    runGit(root, ["config", "user.name", "SpineTree"]);
    const store = new GitSpineTreeStore(root);
    const commit = store.#commitSnapshot(snapshot, "spinetree: initialize", null);
    runGit(root, ["update-ref", "HEAD", commit, "0".repeat(40)]);
    return store;
  }

  head(): string {
    try {
      return runGit(this.root, ["rev-parse", "HEAD"]).trim();
    } catch (error) {
      throw new SpineTreeChangeError("unknown-head", `SpineTree Git HEAD is unavailable: ${formatError(error)}`);
    }
  }

  readSnapshot(head: string): SpineTreeSnapshot {
    validateGitHead(head);
    let raw: string;
    try {
      raw = runGit(this.root, ["show", `${head}:state.json`]);
    } catch (error) {
      throw new SpineTreeChangeError("unknown-head", `Unknown SpineTree Git HEAD ${head}: ${formatError(error)}`);
    }
    try {
      return clone(parseSnapshot(JSON.parse(raw)));
    } catch (error) {
      if (error instanceof SpineTreeGitStoreError) throw error;
      throw new SpineTreeGitStoreError("invalid-snapshot", `Invalid snapshot at ${head}: ${formatError(error)}`);
    }
  }

  change(expectedHead: string, changes: readonly SpineTreeChange[]): SpineTreeChangeResult {
    validateGitHead(expectedHead);
    const currentHead = this.head();
    if (currentHead !== expectedHead) {
      throw new SpineTreeChangeError(
        "stale-head",
        `SpineTree HEAD changed: expected ${expectedHead}, found ${currentHead}`,
      );
    }
    const draft = clone(this.readSnapshot(expectedHead));
    applyChanges(draft, changes);
    const committed = this.commitSnapshot(expectedHead, draft, "spinetree: change");
    return {
      schema: SPINETREE_CHANGE_RESULT_SCHEMA,
      parent: expectedHead,
      head: committed.head,
      changes: clone(changes),
    };
  }

  commitSnapshot(expectedHead: string, snapshot: SpineTreeSnapshot, message = "spinetree: state"): SpineTreeSnapshotCommit {
    validateGitHead(expectedHead);
    const currentHead = this.head();
    if (currentHead !== expectedHead) {
      throw new SpineTreeChangeError(
        "stale-head",
        `SpineTree HEAD changed: expected ${expectedHead}, found ${currentHead}`,
      );
    }
    const nextHead = this.#commitSnapshot(stampBranchRevisions(this.readSnapshot(expectedHead), parseSnapshot(snapshot)), message, expectedHead);
    try {
      runGit(this.root, [
        "-c", `core.filesRefLockTimeout=${SPINETREE_REF_LOCK_TIMEOUT_MS}`,
        "update-ref", "HEAD", nextHead, expectedHead,
      ]);
    } catch (error) {
      const observed = this.head();
      if (observed !== expectedHead) {
        throw new SpineTreeChangeError(
          "stale-head",
          `SpineTree HEAD changed: expected ${expectedHead}, found ${observed}`,
        );
      }
      throw new SpineTreeGitStoreError("git-error", `Unable to publish SpineTree HEAD: ${formatError(error)}`);
    }
    return { parent: expectedHead, head: nextHead };
  }

  #commitSnapshot(snapshot: SpineTreeSnapshot, message: string, parent: string | null): string {
    const content = `${JSON.stringify(parseSnapshot(snapshot), null, 2)}\n`;
    const blob = runGit(this.root, ["hash-object", "-w", "--stdin"], content).trim();
    const tree = runGit(this.root, ["mktree"], `100644 blob ${blob}\tstate.json\n`).trim();
    const args = ["commit-tree", tree, "-m", message];
    if (parent !== null) args.push("-p", parent);
    return runGit(this.root, args).trim();
  }
}

/** An explicit adapter for a `.spinetree` root. */
export type SpineTreeRootAdapter = SpineTreeSnapshotStore;

export interface SpineTreeRejuvenateContext {
  readonly parent: SpineTreeBranch;
  readonly branch: SpineTreeBranch;
  readonly inherit: SpineTreeInheritance;
  readonly request?: string;
  readonly executionId: string;
  readonly sourceHead: string;
}

export interface SpineTreeRejuvenator {
  /** Allocate identity only; the branch is still reserved and must not sample. */
  provision(context: SpineTreeRejuvenateContext): SpineTreeWorkingBinding | Promise<SpineTreeWorkingBinding>;
  /** Attach an idle session after ownership and branch revival have committed. */
  ready?(binding: SpineTreeWorkingBinding, context: SpineTreeRejuvenateContext): void | Promise<void>;
  release?(binding: SpineTreeWorkingBinding, context: SpineTreeRejuvenateContext): void | Promise<void>;
}

export interface SpineTreeReexecutionRegistry {
  rejuvenate(input: SpineTreeRejuvenateInput, rejuvenator: SpineTreeRejuvenator): Promise<SpineTreeRejuvenateResult>;
}

export interface SpineTreePluginOptions {
  readonly store?: SpineTreeSnapshotStore;
  readonly root?: SpineTreeRootAdapter;
  readonly registry?: SpineTreeAgentRegistry;
  readonly mailbox?: SpineTreeMailbox;
  readonly rejuvenator?: SpineTreeRejuvenator;
  /** Omit only for queue-only hosts that do not promise a reachable endpoint. */
  readonly transportDomain?: SpineTreeTransportDomain;
  /** Omit to keep the historical project and collaboration tools. An empty list loads nothing. */
  readonly load?: readonly string[];
}

export interface SpineTreeSendInput {
  readonly to: string;
  readonly message: string;
  readonly from?: string;
  readonly requestId?: string;
}

export interface SpineTreeSendResult {
  readonly schema: typeof SPINETREE_SEND_RESULT_SCHEMA;
  readonly receipt: SpineTreeReceipt;
  readonly status: SpineTreeReceipt["status"];
  readonly to: string;
  readonly sessionId: string;
}

export interface SpineTreeObserveInput {
  readonly receiptId: string;
  readonly agentId: string;
  readonly leaseId?: string;
}

export interface SpineTreeObserveResult {
  readonly schema: typeof SPINETREE_OBSERVE_RESULT_SCHEMA;
  readonly receipt: SpineTreeReceipt;
  readonly agentId: string;
  readonly sessionId: string;
}

export const SPINETREE_REJUVENATE_RESULT_SCHEMA = "spinetree.rejuvenate.result/v1" as const;

export interface SpineTreeRejuvenateInput {
  readonly parent: string;
  readonly branch: string;
  readonly request?: string;
}

export interface SpineTreeRejuvenateResult {
  readonly schema: typeof SPINETREE_REJUVENATE_RESULT_SCHEMA;
  readonly parent: string;
  readonly branch: string;
  readonly binding: SpineTreeAgentBinding;
  readonly context: SpineTreeRejuvenateContext;
}

export class SpineTreeSendError extends Error {
  readonly code: "invalid-input" | "unknown-recipient" | "recipient-ended" | "recipient-unavailable" | "mailbox-error";

  constructor(code: SpineTreeSendError["code"], message: string) {
    super(message);
    this.name = "SpineTreeSendError";
    this.code = code;
  }
}

export class SpineTreeObserveError extends Error {
  readonly code: "invalid-input" | "unknown-agent" | "agent-ended" | "unknown-receipt" | "not-recipient" | "invalid-state" | "lease-conflict" | "mailbox-error";

  constructor(code: SpineTreeObserveError["code"], message: string) {
    super(message);
    this.name = "SpineTreeObserveError";
    this.code = code;
  }
}

export class SpineTreeRejuvenateError extends Error {
  readonly code:
    | "invalid-input"
    | "unavailable"
    | "unknown-branch"
    | "branch-not-capped"
    | "invalid-parent"
    | "branch-occupied"
    | "invalid-binding"
    | "registry-error";

  constructor(code: SpineTreeRejuvenateError["code"], message: string) {
    super(message);
    this.name = "SpineTreeRejuvenateError";
    this.code = code;
  }
}

export interface SpineTreeReadInput {
  readonly branch: string;
}

export interface SpineTreeInheritedValue {
  readonly value: unknown;
  readonly source: string;
}

export interface SpineTreeInheritance {
  readonly path: readonly string[];
  readonly constraints: readonly SpineTreeInheritedValue[];
  readonly skills: readonly SpineTreeInheritedValue[];
  readonly tools: readonly SpineTreeInheritedValue[];
  readonly memories: readonly {
    branch: string;
    memory: unknown;
    memoryVersion: number;
  }[];
}

export type SpineTreeBinding = SpineTreeAgentBinding;

export interface SpineTreeReadResult {
  readonly schema: typeof SPINETREE_READ_RESULT_SCHEMA;
  readonly head: string;
  readonly revision: number;
  readonly branch: SpineTreeBranch;
  readonly inherit: SpineTreeInheritance;
  readonly children: readonly string[];
  readonly binding: SpineTreeBinding | null;
}

export class SpineTreeReadError extends Error {
  readonly code: "invalid-input" | "store-unavailable" | "unknown-branch" | "ambiguous-binding";

  constructor(code: SpineTreeReadError["code"], message: string) {
    super(message);
    this.name = "SpineTreeReadError";
    this.code = code;
  }
}

export const SPINETREE_PLUGIN_MANIFEST: PluginManifest = {
  schema: "spine-host/v1",
  id: "@spinetree/plugin",
  version: "0.1.0",
  requires: ["@spinejit/pi-spinejit"],
  owns: ["spinetree.project-state"],
  toolNamespace: "spinetree",
  commandNamespace: "spinetree",
  storageNamespace: "spinetree",
};

export function createSpineTreePlugin(options: SpineTreePluginOptions = {}): SpinePlugin {
  if (options.store !== undefined && options.root !== undefined) {
    throw new TypeError("SpineTree plugin accepts either store or root, not both");
  }
  const selectedTools = (options.load === undefined
    ? ["read", "change", "send", "observe", "rejuvenate"]
    : spineTreeToolsFor(options.load)) as Array<keyof typeof toolContracts>;
  const store = options.store ?? options.root;
  const changeStore = options.store !== undefined && isCommitStore(options.store) ? options.store : undefined;
  const sendReady = options.registry !== undefined && options.mailbox !== undefined;
  const observeReady = sendReady && isMailboxReader(options.mailbox!);
  const rejuvenateReady = store !== undefined && options.registry !== undefined &&
    isReexecutionRegistry(options.registry) && options.rejuvenator !== undefined;
  return {
    manifest: options.load === undefined ? SPINETREE_PLUGIN_MANIFEST : spineTreeManifestFor(options.load),
    activate(context) {
      for (const operation of selectedTools) {
        context.tools.register(
          operation,
          operation === "read" && store !== undefined
            ? readTool(store)
            : operation === "change" && changeStore !== undefined
              ? changeTool(changeStore)
            : operation === "send" && sendReady
              ? sendTool(options.registry!, options.mailbox!, options.transportDomain)
            : operation === "observe" && observeReady
              ? observeTool(options.registry!, options.mailbox!, options.mailbox!)
            : operation === "rejuvenate" && rejuvenateReady
              ? rejuvenateTool(options.registry! as SpineTreeAgentRegistry & SpineTreeReexecutionRegistry, options.rejuvenator!)
            : contractTool(context, operation),
        );
      }
      if (selectedTools.length > 0) {
        context.commands.register("status", {
          description: "Inspect the SpineTree plugin contract status",
          execute: async () => ({ status: "contract-only" }),
        });
      }
    },
    dispose() {},
  };
}

function sendTool(
  registry: SpineTreeAgentRegistry,
  mailbox: SpineTreeMailbox,
  transportDomain?: SpineTreeTransportDomain,
): PluginTool {
  return {
    ...toolContracts.send,
    description: toolContracts.send.description + (transportDomain === undefined
      ? " This host is queue-only: no endpoint reachability is promised."
      : " This host accepts only its configured transport endpoints; unsupported or stale recipients fail before enqueue."),
    execute: async (input: unknown) => {
      const parsed = parseSendInput(input);
      const target = await registry.resolve(parsed.to);
      if (target === undefined) {
        throw new SpineTreeSendError("unknown-recipient", `Unknown Agent ${parsed.to}`);
      }
      if (target.status === "ended") {
        throw new SpineTreeSendError("recipient-ended", `Agent ${parsed.to} has ended`);
      }
      let recipient: SpineTreeRecipientBinding | undefined;
      if (transportDomain !== undefined) {
        const recipients = validateRecipients(await transportDomain());
        const current = await registry.resolve(parsed.to);
        recipient = recipients.find(item => sameRecipient(item, target) && sameRecipient(item, current));
        if (target.status !== "running" || current?.status !== "running" || recipient === undefined) {
          throw new SpineTreeSendError("recipient-unavailable", `Agent ${parsed.to} has no matching endpoint in this host's transport domain`);
        }
      }
      if (parsed.from !== undefined) {
        const source = await registry.resolve(parsed.from);
        if (source === undefined) throw new SpineTreeSendError("unknown-recipient", `Unknown Agent ${parsed.from}`);
        if (source.status === "ended") throw new SpineTreeSendError("recipient-ended", `Agent ${parsed.from} has ended`);
      }
      try {
        const receipt = await mailbox.enqueue({
          to: parsed.to,
          from: parsed.from ?? null,
          message: parsed.message,
          ...(parsed.requestId === undefined ? {} : { requestId: parsed.requestId }),
          ...(recipient === undefined ? {} : { recipient }),
        });
        return sendResult(receipt, target.sessionId);
      } catch (error) {
        if (error instanceof SpineTreeSendError) throw error;
        if (error instanceof SpineTreeMailboxError) {
          throw new SpineTreeSendError("mailbox-error", error.message);
        }
        throw error;
      }
    },
  };
}

async function deliverReceipt(
  mailbox: SpineTreeDispatchMailbox,
  sessions: PiSessionAdapter,
  leased: SpineTreeReceipt,
  target: SpineTreeAgentBinding,
  resolveCurrent: () => Promise<SpineTreeAgentBinding | undefined> | SpineTreeAgentBinding | undefined,
): Promise<SpineTreeReceipt> {
  const leaseId = leased.leaseId;
  const bindingId = leased.bindingId;
  let accepted: boolean;
  try {
    const response = await sessions.request({
      targetSessionId: target.sessionId,
      operation: "prompt",
      text: JSON.stringify({
        schema: SPINETREE_MESSAGE_SCHEMA,
        receiptId: leased.id,
        leaseId: leased.leaseId!,
        ...(leased.bindingId === undefined ? {} : { bindingId: leased.bindingId }),
        to: leased.to,
        from: leased.from,
        message: leased.message,
      } satisfies SpineTreeMessage),
      requestId: leased.id,
    });
    accepted = response.accepted;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return isPermanentError(error)
      ? mailbox.fail(leased.id, leased.leaseId!, message, leased.bindingId)
      : mailbox.release(leased.id, leased.leaseId!, message, leased.bindingId);
  }
  const current = await resolveCurrent();
  const stored = await mailbox.receipt(leased.id);
  if (current?.sessionId !== target.sessionId || current.bindingId !== target.bindingId ||
      stored.leaseId !== leaseId || stored.bindingId !== bindingId ||
      (leased.recipient !== undefined && !sameRecipient(leased.recipient, current))) {
    throw new SpineTreeMailboxError("lease-conflict", `Agent ${leased.to} binding changed during delivery`);
  }
  return accepted
    ? mailbox.delivered(leased.id, leaseId!, bindingId)
    : mailbox.release(leased.id, leaseId!, "session request was not accepted", bindingId);
}

function sendResult(receipt: SpineTreeReceipt, sessionId: string): SpineTreeSendResult {
  return {
    schema: SPINETREE_SEND_RESULT_SCHEMA,
    receipt: clone(receipt),
    status: receipt.status,
    to: receipt.to,
    sessionId,
  };
}

function observeTool(
  registry: SpineTreeAgentRegistry,
  mailbox: SpineTreeMailbox,
  reader: SpineTreeMailboxReader,
): PluginTool {
  return {
    ...toolContracts.observe,
    execute: async (input: unknown) => {
      const parsed = parseObserveInput(input);
      const agent = await registry.resolve(parsed.agentId);
      if (agent === undefined) {
        throw new SpineTreeObserveError("unknown-agent", `Unknown Agent ${parsed.agentId}`);
      }
      if (agent.status === "ended") {
        throw new SpineTreeObserveError("agent-ended", `Agent ${parsed.agentId} has ended`);
      }
      let current: SpineTreeReceipt;
      try {
        current = await reader.receipt(parsed.receiptId);
      } catch (error) {
        throw observeMailboxError(error, parsed.receiptId);
      }
      if (current.to !== parsed.agentId) {
        throw new SpineTreeObserveError(
          "not-recipient",
          `Agent ${parsed.agentId} is not the recipient of receipt ${parsed.receiptId}`,
        );
      }
      if (current.recipient !== undefined && !sameRecipient(current.recipient, agent)) {
        throw new SpineTreeObserveError("lease-conflict", `Agent ${parsed.agentId} no longer owns receipt ${parsed.receiptId}`);
      }
      try {
        const receipt = await mailbox.observed(parsed.receiptId, parsed.leaseId, agent.bindingId);
        return {
          schema: SPINETREE_OBSERVE_RESULT_SCHEMA,
          receipt: clone(receipt),
          agentId: parsed.agentId,
          sessionId: agent.sessionId,
        } satisfies SpineTreeObserveResult;
      } catch (error) {
        throw observeMailboxError(error, parsed.receiptId);
      }
    },
  };
}

function parseObserveInput(input: unknown): SpineTreeObserveInput {
  if (input === null || typeof input !== "object") {
    throw new SpineTreeObserveError("invalid-input", "spinetree_observe requires an object input");
  }
  const value = input as { receiptId?: unknown; agentId?: unknown; leaseId?: unknown };
  if (typeof value.receiptId !== "string" || value.receiptId.length === 0 || typeof value.agentId !== "string" || value.agentId.length === 0) {
    throw new SpineTreeObserveError("invalid-input", "spinetree_observe requires non-empty receiptId and agentId strings");
  }
  if (value.leaseId !== undefined && (typeof value.leaseId !== "string" || value.leaseId.length === 0)) {
    throw new SpineTreeObserveError("invalid-input", "leaseId must be a non-empty string when supplied");
  }
  return { receiptId: value.receiptId, agentId: value.agentId, ...(value.leaseId === undefined ? {} : { leaseId: value.leaseId }) };
}

function observeMailboxError(error: unknown, receiptId: string): SpineTreeObserveError {
  if (error instanceof SpineTreeMailboxError) {
    if (error.code === "unknown-receipt") {
      return new SpineTreeObserveError("unknown-receipt", error.message);
    }
    if (error.code === "invalid-state" || error.code === "lease-conflict") {
      return new SpineTreeObserveError(error.code, error.message);
    }
    return new SpineTreeObserveError("mailbox-error", error.message);
  }
  return new SpineTreeObserveError("mailbox-error", `Could not observe receipt ${receiptId}: ${error instanceof Error ? error.message : String(error)}`);
}

function isReexecutionRegistry(registry: SpineTreeAgentRegistry): registry is SpineTreeAgentRegistry & SpineTreeReexecutionRegistry {
  return typeof (registry as Partial<SpineTreeReexecutionRegistry>).rejuvenate === "function";
}

function rejuvenateTool(registry: SpineTreeReexecutionRegistry, rejuvenator: SpineTreeRejuvenator): PluginTool {
  return { ...toolContracts.rejuvenate, execute: input => registry.rejuvenate(parseRejuvenateInput(input), rejuvenator) };
}

async function rejuvenateBranch(
  store: SpineTreeSnapshotCommitStore, retries: number, parsed: SpineTreeRejuvenateInput, rejuvenator: SpineTreeRejuvenator,
): Promise<SpineTreeRejuvenateResult> {
  const executionId = randomUUID();
  const context = await mutateSnapshotWithRetry(store, retries, "spinetree: reserve reexecution", (snapshot, head) => {
    const target = snapshot.branches[parsed.branch];
    if (target === undefined) throw new SpineTreeRejuvenateError("unknown-branch", `Unknown ProjectBranch ${parsed.branch}`);
    const parent = snapshot.branches[parsed.parent];
    if (parent === undefined || parent.id === target.id || !isDescendant(snapshot, target.id, parent.id)) {
      throw new SpineTreeRejuvenateError("invalid-parent", `ProjectBranch ${parsed.parent} is not an ancestor of ${parsed.branch}`);
    }
    if (target.status !== "capped") throw new SpineTreeRejuvenateError("branch-not-capped", `ProjectBranch ${target.id} is not capped`);
    if (activeBranchBindings(snapshot, target.id).length > 0 || target.reexecution?.state === "reserved" || target.reexecution?.state === "running") {
      throw new SpineTreeRejuvenateError("branch-occupied", `ProjectBranch ${target.id} already has an execution`);
    }
    const reexecution: SpineTreeReexecution = {
      schema: "spinetree.reexecution/v1", id: executionId, state: "reserved", parent: parent.id, sourceHead: head,
      source: { memory: clone(target.memory), memoryVersion: target.memoryVersion, memorySource: clone(target.memorySource),
        ...(target.scopeBinding === undefined ? {} : { scopeBinding: clone(target.scopeBinding) }) },
    };
    const context: SpineTreeRejuvenateContext = {
      executionId, sourceHead: head, parent: clone(parent), branch: clone(target), inherit: inheritance(snapshot, target),
      ...(parsed.request === undefined ? {} : { request: parsed.request }),
    };
    return { snapshot: { ...snapshot, branches: { ...snapshot.branches, [target.id]: { ...target, reexecution } } }, value: context };
  });
  let binding: SpineTreeWorkingBinding | undefined;
  let published = false;
  try {
    binding = clone(await rejuvenator.provision(clone(context)));
    validateWorkingBinding(binding);
    if (binding.branch !== parsed.branch || binding.status !== "running" || binding.operationId !== executionId) {
      throw new SpineTreeRejuvenateError("invalid-binding", "Provisioned WorkingBinding must name this running reexecution");
    }
    const fixedBinding = clone(binding);
    await mutateSnapshotWithRetry(store, retries, "spinetree: start reexecution", snapshot => {
      const target = snapshot.branches[parsed.branch];
      const execution = target?.reexecution;
      if (target?.status !== "capped" || execution?.id !== executionId || execution.state !== "reserved" ||
          target.memoryVersion !== context.branch.memoryVersion || revisionOf(target) !== revisionOf(context.branch) + 1 ||
          JSON.stringify(target.memory) !== JSON.stringify(context.branch.memory) || JSON.stringify(target.memorySource) !== JSON.stringify(context.branch.memorySource)) {
        throw new SpineTreeRejuvenateError("invalid-binding", "Reexecution reservation no longer matches its source");
      }
      if (snapshot.registry?.[fixedBinding.agentId] !== undefined || activeBranchBindings(snapshot, target.id).length > 0) {
        throw new SpineTreeRejuvenateError("branch-occupied", "Reexecution identity or branch is already occupied");
      }
      const { scopeBinding: _oldScope, ...branch } = target;
      return { snapshot: { ...snapshot,
        branches: { ...snapshot.branches, [target.id]: { ...branch, status: "live", reexecution: { ...execution, state: "running", binding: fixedBinding } } },
        registry: { ...snapshot.registry, [fixedBinding.agentId]: fixedBinding },
      }, value: undefined };
    });
    published = true;
    await rejuvenator.ready?.(clone(binding), clone(context));
    return { schema: SPINETREE_REJUVENATE_RESULT_SCHEMA, parent: parsed.parent, branch: parsed.branch, binding: clone(binding), context };
  } catch (cause) {
    // Only this reservation can be released. Preserve its provenance on failure;
    // no live Agent is manufactured for a failed allocation.
    const failed = await mutateSnapshotWithRetry(store, retries, "spinetree: fail reexecution", snapshot => {
      const target = snapshot.branches[parsed.branch];
      const execution = target?.reexecution;
      if (target === undefined || execution?.id !== executionId || (execution.state !== "reserved" && execution.state !== "running")) return { snapshot, value: false };
      if (target.memoryVersion !== context.branch.memoryVersion || JSON.stringify(target.memorySource) !== JSON.stringify(context.branch.memorySource)) {
        throw new SpineTreeRejuvenateError("invalid-binding", "Cannot roll back reexecution after canonical memory changed");
      }
      const current = binding === undefined ? undefined : snapshot.registry?.[binding.agentId];
      if (target.status !== (published ? "live" : "capped") || execution.state !== (published ? "running" : "reserved") ||
          (published ? ![current, execution.binding].every(owner => owner !== undefined && isWorkingBinding(owner) &&
            sameRecipient(binding!, owner) && owner.branch === binding!.branch && owner.scope === binding!.scope &&
            owner.operationId === executionId && owner.status === "running" && owner.epoch === binding!.epoch &&
            JSON.stringify(owner.scopeCursor) === JSON.stringify(binding!.scopeCursor)) : current !== undefined)) {
        throw new SpineTreeRejuvenateError("invalid-binding", "Cannot release a replaced execution binding");
      }
      const { scopeBinding: _failedScope, ...branch } = target;
      return { snapshot: { ...snapshot,
        branches: { ...snapshot.branches, [target.id]: { ...branch, status: "capped",
          ...(execution.source.scopeBinding === undefined ? {} : { scopeBinding: clone(execution.source.scopeBinding) }),
          reexecution: { ...execution, state: "failed" } } },
        ...(published ? { registry: { ...snapshot.registry, [binding!.agentId]: { ...current!, status: "ended" as const } } } : {}),
      }, value: true };
    });
    // The CAS above fences stale owners before any external cleanup. The adapter
    // receives the original identity and must release only that allocation.
    try { if (failed && binding !== undefined) await rejuvenator.release?.(clone(binding), clone(context)); }
    catch (cleanupError) { throw new AggregateError([cause, cleanupError], "Reexecution and session cleanup failed"); }
    throw cause;
  }
}

function parseRejuvenateInput(input: unknown): SpineTreeRejuvenateInput {
  if (input === null || typeof input !== "object") {
    throw new SpineTreeRejuvenateError("invalid-input", "spinetree_rejuvenate requires an object input");
  }
  const value = input as { parent?: unknown; branch?: unknown; request?: unknown };
  if (typeof value.parent !== "string" || value.parent.length === 0 || typeof value.branch !== "string" || value.branch.length === 0) {
    throw new SpineTreeRejuvenateError("invalid-input", "spinetree_rejuvenate requires non-empty parent and branch strings");
  }
  if (value.request !== undefined && (typeof value.request !== "string" || value.request.length === 0)) {
    throw new SpineTreeRejuvenateError("invalid-input", "spinetree_rejuvenate request must be a non-empty string");
  }
  return {
    parent: value.parent,
    branch: value.branch,
    ...(value.request === undefined ? {} : { request: value.request }),
  };
}

function parseSendInput(input: unknown): SpineTreeSendInput {
  if (input === null || typeof input !== "object") {
    throw new SpineTreeSendError("invalid-input", "spinetree_send requires an object input");
  }
  const value = input as { to?: unknown; message?: unknown; from?: unknown; requestId?: unknown };
  if (typeof value.to !== "string" || value.to.length === 0 || typeof value.message !== "string" || value.message.length === 0) {
    throw new SpineTreeSendError("invalid-input", "spinetree_send requires non-empty to and message strings");
  }
  if (value.from !== undefined && (typeof value.from !== "string" || value.from.length === 0)) {
    throw new SpineTreeSendError("invalid-input", "spinetree_send from must be a non-empty string");
  }
  if (value.requestId !== undefined && (typeof value.requestId !== "string" || value.requestId.length === 0)) {
    throw new SpineTreeSendError("invalid-input", "spinetree_send requestId must be a non-empty string");
  }
  return {
    to: value.to,
    message: value.message,
    ...(value.from === undefined ? {} : { from: value.from }),
    ...(value.requestId === undefined ? {} : { requestId: value.requestId }),
  };
}

function isPermanentError(error: unknown): boolean {
  return error !== null && typeof error === "object" && (error as { permanent?: unknown }).permanent === true;
}

function validateBinding(binding: SpineTreeAgentBinding): void {
  if (
    binding === null ||
    typeof binding !== "object" ||
    typeof binding.agentId !== "string" || binding.agentId.length === 0 ||
    typeof binding.sessionId !== "string" || binding.sessionId.length === 0 ||
    typeof binding.branch !== "string" || binding.branch.length === 0 ||
    !["running", "paused", "ended"].includes(binding.status)
  ) {
    throw new SpineTreeRegistryError("invalid-binding", "Agent binding requires non-empty agentId, sessionId, branch and valid status");
  }
  if (binding.scope !== undefined && (typeof binding.scope !== "string" || binding.scope.length === 0)) {
    throw new SpineTreeRegistryError("invalid-binding", "Agent binding scope must be a non-empty string");
  }
}

function validateWorkingBinding(binding: SpineTreeWorkingBinding): void {
  validateBinding(binding);
  if (
    typeof binding.bindingId !== "string" || binding.bindingId.length === 0 ||
    typeof binding.leaseId !== "string" || binding.leaseId.length === 0 ||
    typeof binding.operationId !== "string" || binding.operationId.length === 0 ||
    !Number.isSafeInteger(binding.epoch) || binding.epoch < 0 ||
    !Array.isArray(binding.scopeCursor) || binding.scopeCursor.some(value => !Number.isSafeInteger(value) || value < 0)
  ) {
    throw new SpineTreeRegistryError(
      "invalid-working-binding",
      "WorkingBinding requires bindingId, leaseId, operationId, non-negative epoch and scopeCursor",
    );
  }
}

function validateWorkingUpdate(update: SpineTreeWorkingUpdate, currentEpoch: number): void {
  if (
    update === null || typeof update !== "object" ||
    !Number.isSafeInteger(update.epoch) || update.epoch < currentEpoch ||
    !Array.isArray(update.scopeCursor) || update.scopeCursor.some(value => !Number.isSafeInteger(value) || value < 0)
  ) {
    throw new SpineTreeRegistryError(
      "invalid-working-binding",
      "WorkingBinding update must preserve epoch order and provide a valid scopeCursor",
    );
  }
}

/** Pure lease update shared by cursor-only registry writes and atomic Scope imports. */
export function updateWorkingBinding(binding: SpineTreeAgentBinding, leaseId: string,
  update: SpineTreeWorkingUpdate): SpineTreeWorkingBinding {
  assertWorkingLease(binding, leaseId);
  validateWorkingUpdate(update, binding.epoch);
  return { ...binding, epoch: update.epoch, scopeCursor: [...update.scopeCursor] };
}

/** Complete lease shape shared by registry and committed Scope admission. */
export function isWorkingBinding(binding: SpineTreeAgentBinding): binding is SpineTreeWorkingBinding {
  const candidate = binding as Partial<SpineTreeWorkingBinding>;
  return typeof candidate.bindingId === "string" && candidate.bindingId.length > 0 &&
    typeof candidate.leaseId === "string" && candidate.leaseId.length > 0 &&
    typeof candidate.operationId === "string" && candidate.operationId.length > 0 &&
    typeof candidate.epoch === "number" && Number.isSafeInteger(candidate.epoch) && candidate.epoch >= 0 &&
    Array.isArray(candidate.scopeCursor);
}

function assertWorkingLease(binding: SpineTreeAgentBinding, leaseId: string): asserts binding is SpineTreeWorkingBinding {
  if (binding.status !== "running" || !isWorkingBinding(binding) || binding.leaseId !== leaseId) {
    throw new SpineTreeRegistryError("stale-lease", `Agent ${binding.agentId} does not hold the active WorkingBinding lease`);
  }
}

function validateAgentStatus(status: unknown): asserts status is SpineTreeAgentStatus {
  if (!(["running", "paused", "ended"] as readonly unknown[]).includes(status)) {
    throw new SpineTreeRegistryError("invalid-transition", `Invalid Agent status ${String(status)}`);
  }
}

function transitionBinding(binding: SpineTreeAgentBinding, status: SpineTreeAgentStatus): SpineTreeAgentBinding {
  validateAgentStatus(status);
  if (binding.status === "ended" && status !== "ended") {
    throw new SpineTreeRegistryError(
      "invalid-transition",
      `Ended Agent ${binding.agentId} cannot transition to ${status}`,
    );
  }
  return { ...binding, status };
}

function transitionWorkingBinding(binding: SpineTreeAgentBinding | undefined, leaseId: string,
  expected: SpineTreeAgentStatus, status: SpineTreeAgentStatus): SpineTreeWorkingBinding {
  validateAgentStatus(expected);
  if (binding === undefined || !isWorkingBinding(binding) || binding.leaseId !== leaseId || binding.status !== expected) {
    throw new SpineTreeRegistryError("stale-lease", "WorkingBinding lease or expected status no longer matches");
  }
  return { ...binding, ...transitionBinding(binding, status) };
}

function contractTool(context: SpinePluginContext, operation: keyof typeof toolContracts): PluginTool {
  return {
    ...toolContracts[operation],
    description: `${toolContracts[operation].description} Unavailable in this host: required adapters are not configured; returns contract-only without performing the operation.`,
    execute: async () => ({
      schema: "spinetree.operation.result/v1",
      operation,
      status: "contract-only",
      storageNamespace: context.manifest.storageNamespace ?? null,
    }),
  };
}

function readTool(store: SpineTreeSnapshotStore): PluginTool {
  return {
    ...toolContracts.read,
    execute: async (input: unknown) => readSpineTreeBranch(store, input),
  };
}

const MODEL_CHANGE_CAS_RETRIES = 8;

function changeTool(store: SpineTreeSnapshotCommitStore): PluginTool {
  return {
    ...toolContracts.change,
    execute: async (input: unknown) => changeByBranchRevision(store, parseModelChanges(input)),
  };
}

async function changeByBranchRevision(
  store: SpineTreeSnapshotCommitStore,
  changes: readonly { expectedRevision: number; change: SpineTreeChange }[],
): Promise<(SpineTreeChangeResult & { applied: true }) | SpineTreeBranchConflict> {
  let lastStale: unknown;
  for (let attempt = 0; attempt < MODEL_CHANGE_CAS_RETRIES; attempt += 1) {
    const head = await store.head();
    const snapshot = await store.readSnapshot(head);
    const conflicts: SpineTreeBranch[] = [];
    for (const item of changes) {
      const branch = snapshot.branches[item.change.branch];
      if (branch === undefined) {
        throw new SpineTreeChangeError("unknown-branch", `Unknown ProjectBranch ${item.change.branch}`);
      }
      if (revisionOf(branch) !== item.expectedRevision) {
        const current = clone(branch) as DraftSpineTreeBranch;
        current.revision = revisionOf(branch);
        conflicts.push(current);
      }
    }
    if (conflicts.length > 0) return { schema: SPINETREE_CHANGE_RESULT_SCHEMA, applied: false, branches: conflicts };
    const draft = clone(snapshot);
    applyChanges(draft, changes.map(item => item.change));
    try {
      const committed = await store.commitSnapshot(head, draft, "spinetree: change");
      return {
        schema: SPINETREE_CHANGE_RESULT_SCHEMA,
        applied: true,
        parent: head,
        head: committed.head,
        changes: changes.map(item => clone(item.change)),
      };
    } catch (error) {
      if (!isStaleHead(error)) throw error;
      lastStale = error;
    }
  }
  throw lastStale ?? new SpineTreeChangeError("stale-head", "SpineTree snapshot changed during persistent mutation");
}

function parseModelChanges(input: unknown): readonly { expectedRevision: number; change: SpineTreeChange }[] {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new SpineTreeChangeError("invalid-input", "spinetree_change requires an object input");
  }
  const value = input as { changes?: unknown };
  if (!Array.isArray(value.changes) || value.changes.length === 0) {
    throw new SpineTreeChangeError("invalid-input", "spinetree_change requires a non-empty changes array");
  }
  return value.changes.map(item => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new SpineTreeChangeError("invalid-change", "Every change requires an object");
    }
    const record = item as { expectedRevision?: unknown };
    if (typeof record.expectedRevision !== "number" || !Number.isSafeInteger(record.expectedRevision) || record.expectedRevision < 0) {
      throw new SpineTreeChangeError("invalid-input", "spinetree_change requires a non-negative expectedRevision integer on every change");
    }
    const { expectedRevision, ...change } = record;
    return { expectedRevision, change: change as SpineTreeChange };
  });
}

function isCommitStore(store: SpineTreeSnapshotStore): store is SpineTreeSnapshotCommitStore {
  return typeof (store as Partial<SpineTreeSnapshotCommitStore>).commitSnapshot === "function";
}

function isMailboxReader(mailbox: SpineTreeMailbox): mailbox is SpineTreeMailbox & SpineTreeMailboxReader {
  return typeof (mailbox as Partial<SpineTreeMailboxReader>).receipt === "function";
}

function asCommitStore(storeOrRoot: SpineTreeSnapshotCommitStore | string): SpineTreeSnapshotCommitStore {
  if (typeof storeOrRoot === "string") return new GitSpineTreeStore(storeOrRoot);
  if (storeOrRoot !== null && typeof storeOrRoot.commitSnapshot === "function") return storeOrRoot;
  throw new TypeError("SpineTree persistent adapters require a commit-capable snapshot store");
}

function validateCasRetries(value: number | undefined): number {
  if (value === undefined) return 8;
  if (!Number.isInteger(value) || value < 1) throw new TypeError("maxCasRetries must be a positive integer");
  return value;
}

interface MutableMailboxState {
  sequence: number;
  leaseSequence: number;
  receipts: Record<string, SpineTreeReceipt>;
  requestIds: Record<string, string>;
}

function mailboxState(value: SpineTreeMailboxState | undefined): MutableMailboxState {
  if (value === undefined) return { sequence: 0, leaseSequence: 0, receipts: {}, requestIds: {} };
  if (
    !Number.isInteger(value.sequence) || value.sequence < 0 ||
    !Number.isInteger(value.leaseSequence) || value.leaseSequence < 0 ||
    !isRecord(value.receipts) || !isRecord(value.requestIds)
  ) {
    throw new SpineTreeMailboxError("invalid-state", "Invalid persisted SpineTree mailbox state");
  }
  return {
    sequence: value.sequence,
    leaseSequence: value.leaseSequence,
    receipts: clone(value.receipts) as Record<string, SpineTreeReceipt>,
    requestIds: clone(value.requestIds) as Record<string, string>,
  };
}

function validateMailboxInput(input: SpineTreeMailboxInput): void {
  if (
    input === null || typeof input !== "object" ||
    typeof input.to !== "string" || input.to.length === 0 ||
    typeof input.message !== "string" || input.message.length === 0 ||
    (input.from !== null && (typeof input.from !== "string" || input.from.length === 0)) ||
    (input.requestId !== undefined && (typeof input.requestId !== "string" || input.requestId.length === 0))
  ) {
    throw new SpineTreeMailboxError("invalid-state", "Mailbox input requires non-empty to/message and valid from/requestId");
  }
  if (input.recipient !== undefined && (!isRecipient(input.recipient) || input.recipient.agentId !== input.to)) {
    throw new SpineTreeMailboxError("invalid-state", "Mailbox recipient must name the exact target endpoint");
  }
}

function isRecipient(value: SpineTreeRecipientBinding): boolean {
  return value !== null && typeof value === "object" &&
    [value.agentId, value.sessionId, value.bindingId, value.leaseId].every(item => typeof item === "string" && item.length > 0);
}

function validateRecipients(values: readonly SpineTreeRecipientBinding[]): readonly SpineTreeRecipientBinding[] {
  if (!Array.isArray(values) || values.some(value => !isRecipient(value)) ||
      new Set(values.map(value => value.agentId)).size !== values.length) {
    throw new TypeError("Transport domain requires unique Agent endpoint identities");
  }
  return values.map(({ agentId, sessionId, bindingId, leaseId }) => ({ agentId, sessionId, bindingId, leaseId }));
}

function sameRecipient(left: SpineTreeRecipientBinding, right: SpineTreeMailboxBinding | undefined): boolean {
  return right !== undefined && left.agentId === right.agentId && left.sessionId === right.sessionId &&
    left.bindingId === right.bindingId && left.leaseId === right.leaseId;
}

function sameMailboxInput(receipt: SpineTreeReceipt, input: SpineTreeMailboxInput): boolean {
  return receipt.to === input.to && receipt.from === input.from && receipt.message === input.message &&
    (receipt.recipient === undefined ? input.recipient === undefined : sameRecipient(receipt.recipient, input.recipient));
}

function requireRecipient(receipt: SpineTreeReceipt, binding: SpineTreeMailboxBinding | undefined): void {
  if (receipt.recipient !== undefined && !sameRecipient(receipt.recipient, binding)) {
    throw new SpineTreeMailboxError("lease-conflict", `Recipient endpoint no longer matches receipt ${receipt.id}`);
  }
}

function requireCurrentRecipient(recipient: SpineTreeRecipientBinding, snapshot: SpineTreeSnapshot): void {
  const current = snapshot.registry?.[recipient.agentId];
  if (current?.status !== "running" || !sameRecipient(recipient, current)) {
    throw new SpineTreeMailboxError("lease-conflict", `Agent ${recipient.agentId} no longer owns the recipient endpoint`);
  }
}

function receiptFromState(state: MutableMailboxState, receiptId: string): SpineTreeReceipt {
  const receipt = state.receipts[receiptId];
  if (receipt === undefined) throw new SpineTreeMailboxError("unknown-receipt", `Unknown receipt ${receiptId}`);
  return clone(receipt);
}

// A receiver can acknowledge while prompt is still running. That terminal state
// wins over completion/rejection, but only for the same delivery attempt.
function completeDelivery(
  receipt: SpineTreeReceipt,
  leaseId: string,
  status: "queued" | "delivered" | "failed",
  error: string | null,
  bindingId?: string,
): SpineTreeReceipt {
  if ((receipt.status !== "leased" && receipt.status !== "observed") || receipt.leaseId !== leaseId ||
      (receipt.bindingId !== undefined && bindingId !== undefined && receipt.bindingId !== bindingId)) {
    throw new SpineTreeMailboxError("lease-conflict", `Lease ${leaseId} does not own receipt ${receipt.id}`);
  }
  if (receipt.status === "observed") return receipt;
  return {
    ...receipt, status, leaseId: status === "delivered" ? leaseId : null, leaseUntil: null,
    nextAttemptAt: status === "queued" ? Date.now() : null, lastError: error,
  };
}

function observeReceipt(receipt: SpineTreeReceipt, leaseId?: string, bindingId?: string): SpineTreeReceipt {
  if (receipt.status !== "leased" && receipt.status !== "delivered" && receipt.status !== "observed") {
    throw new SpineTreeMailboxError("invalid-state", `Receipt ${receipt.id} cannot be observed from ${receipt.status}`);
  }
  if ((receipt.status === "leased" && leaseId === undefined) ||
      (leaseId !== undefined && receipt.leaseId !== leaseId) ||
      (receipt.bindingId !== undefined && bindingId !== undefined && receipt.bindingId !== bindingId)) {
    throw new SpineTreeMailboxError("lease-conflict", `Lease ${leaseId} does not own receipt ${receipt.id}`);
  }
  if (receipt.status === "observed") return receipt;
  return { ...receipt, status: "observed", leaseUntil: null, nextAttemptAt: null, lastError: null };
}

function isPending(receipt: SpineTreeReceipt, now: number): boolean {
  return receipt.status === "queued"
    ? receipt.nextAttemptAt === null || receipt.nextAttemptAt <= now
    : receipt.status === "leased" && (receipt.leaseUntil === null || receipt.leaseUntil <= now);
}

function requireLeaseable(receipt: SpineTreeReceipt, now: number): void {
  if (receipt.status !== "queued" && receipt.status !== "leased") {
    throw new SpineTreeMailboxError("invalid-state", `Receipt ${receipt.id} cannot be leased from ${receipt.status}`);
  }
  if (!isPending(receipt, now)) {
    throw new SpineTreeMailboxError("lease-conflict", `Receipt ${receipt.id} is leased or not yet due`);
  }
}

function validateDispatchLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("Mailbox dispatch limit must be a positive safe integer");
}

function pendingReceipts(receipts: Iterable<SpineTreeReceipt>, limit: number, now: number,
  recipients?: readonly SpineTreeRecipientBinding[]): readonly SpineTreeReceipt[] {
  validateDispatchLimit(limit);
  const domain = recipients === undefined ? undefined : new Map(validateRecipients(recipients).map(item => [item.agentId, item]));
  const pending: SpineTreeReceipt[] = [];
  for (const receipt of receipts) {
    if (domain !== undefined) {
      const target = domain.get(receipt.to);
      if (target === undefined || (receipt.recipient !== undefined && !sameRecipient(receipt.recipient, target))) continue;
    }
    if (isPending(receipt, now)) pending.push(clone(receipt));
    if (pending.length === limit) break;
  }
  return pending;
}

async function mutateSnapshotWithRetry<T>(
  store: SpineTreeSnapshotCommitStore,
  maxCasRetries: number,
  message: string,
  mutate: (snapshot: SpineTreeSnapshot, head: string) => { snapshot: SpineTreeSnapshot; value: T },
): Promise<T> {
  let lastStale: unknown;
  for (let attempt = 0; attempt < maxCasRetries; attempt += 1) {
    const head = await store.head();
    const snapshot = await store.readSnapshot(head);
    const result = mutate(snapshot, head);
    if (result.snapshot === snapshot) return result.value;
    try {
      await store.commitSnapshot(head, result.snapshot, message);
      return result.value;
    } catch (error) {
      if (!isStaleHead(error)) throw error;
      lastStale = error;
    }
  }
  throw lastStale ?? new SpineTreeChangeError("stale-head", "SpineTree snapshot changed during persistent mutation");
}

function isStaleHead(error: unknown): boolean {
  return error instanceof SpineTreeChangeError && error.code === "stale-head";
}

const CHANGEABLE_ATTRIBUTES = new Set(["goal", "constraints", "skills", "tools"]);

function applyChanges(snapshot: SpineTreeSnapshot, changes: readonly SpineTreeChange[]): void {
  if (!Array.isArray(changes) || changes.length === 0) {
    throw new SpineTreeChangeError("invalid-input", "spinetree_change requires a non-empty changes array");
  }
  for (const change of changes) {
    if (change === null || typeof change !== "object" || typeof change.branch !== "string" || change.branch.length === 0) {
      throw new SpineTreeChangeError("invalid-change", "Every change requires a non-empty branch string");
    }
    const branch = snapshot.branches[change.branch] as DraftSpineTreeBranch | undefined;
    if (branch === undefined) {
      throw new SpineTreeChangeError("unknown-branch", `Unknown ProjectBranch ${change.branch}`);
    }
    if (change.type === "update") {
      applyUpdate(branch, change.attributes);
    } else if (change.type === "move") {
      applyMove(snapshot, branch, change.parent);
    } else if (change.type === "archive") {
      if (hasLiveWork(snapshot, branch.id)) {
        throw new SpineTreeChangeError("invalid-change", `Cannot archive live work ${branch.id}`);
      }
      branch.status = "archived";
    } else {
      throw new SpineTreeChangeError("invalid-change", `Unknown change type ${(change as { type?: unknown }).type ?? ""}`);
    }
  }
}

function applyUpdate(branch: DraftSpineTreeBranch, attributes: Readonly<Record<string, unknown>>): void {
  if (attributes === null || typeof attributes !== "object" || Array.isArray(attributes)) {
    throw new SpineTreeChangeError("invalid-change", "update attributes must be an object");
  }
  for (const key of Object.keys(attributes)) {
    if (!CHANGEABLE_ATTRIBUTES.has(key)) {
      throw new SpineTreeChangeError("invalid-change", `Cannot update ${key}`);
    }
    if (key === "goal" && (typeof attributes[key] !== "string" || attributes[key].length === 0)) {
      throw new SpineTreeChangeError("invalid-change", "goal must be a non-empty string");
    }
    if (key !== "goal" && !Array.isArray(attributes[key])) {
      throw new SpineTreeChangeError("invalid-change", `${key} must be an array`);
    }
  }
  Object.assign(branch, clone(attributes));
}

function applyMove(snapshot: SpineTreeSnapshot, branch: DraftSpineTreeBranch, parent: unknown): void {
  if (typeof parent !== "string" || parent.length === 0) {
    throw new SpineTreeChangeError("invalid-change", "move requires a non-empty parent string");
  }
  if (branch.id === "root") throw new SpineTreeChangeError("invalid-change", "Cannot move root");
  if (branch.status === "live" || branch.reexecution?.state === "reserved") throw new SpineTreeChangeError("invalid-change", `Cannot move active branch ${branch.id}`);
  if (snapshot.branches[parent] === undefined) {
    throw new SpineTreeChangeError("unknown-branch", `Unknown ProjectBranch ${parent}`);
  }
  if (parent === branch.id || isDescendant(snapshot, parent, branch.id)) {
    throw new SpineTreeChangeError("invalid-change", "Move would create a cycle");
  }
  branch.parent = parent;
}

function isDescendant(snapshot: SpineTreeSnapshot, candidate: string, ancestor: string): boolean {
  let current: string | null = candidate;
  while (current !== null) {
    if (current === ancestor) return true;
    current = snapshot.branches[current]?.parent ?? null;
  }
  return false;
}

function hasLiveWork(snapshot: SpineTreeSnapshot, branchId: string): boolean {
  return Object.values(snapshot.branches).some(candidate =>
    (candidate.status === "live" || candidate.reexecution?.state === "reserved") && (candidate.id === branchId || isDescendant(snapshot, candidate.id, branchId)),
  );
}

export async function readSpineTreeBranch(
  store: SpineTreeSnapshotStore,
  input: unknown,
): Promise<SpineTreeReadResult> {
  const branchId = parseBranchId(input);
  const head = await store.head();
  const snapshot = await store.readSnapshot(head);
  const branch = snapshot.branches[branchId];
  if (branch === undefined) {
    throw new SpineTreeReadError("unknown-branch", `Unknown ProjectBranch ${branchId}`);
  }
  return {
    schema: SPINETREE_READ_RESULT_SCHEMA,
    head,
    revision: revisionOf(branch),
    branch: clone(branch),
    inherit: inheritance(snapshot, branch),
    children: Object.values(snapshot.branches)
      .filter(candidate => candidate.parent === branch.id)
      .map(candidate => candidate.id),
    binding: binding(snapshot, branch.id),
  };
}

function parseBranchId(input: unknown): string {
  if (
    input === null ||
    typeof input !== "object" ||
    typeof (input as { branch?: unknown }).branch !== "string" ||
    (input as { branch: string }).branch.length === 0
  ) {
    throw new SpineTreeReadError("invalid-input", "spinetree_read requires a non-empty branch string");
  }
  return (input as { branch: string }).branch;
}

function inheritance(snapshot: SpineTreeSnapshot, branch: SpineTreeBranch): SpineTreeInheritance {
  const path = pathTo(snapshot, branch.id);
  return {
    path: path.map(item => item.id),
    constraints: path.flatMap(item => item.constraints.map(value => ({ value: clone(value), source: item.id }))),
    skills: overlay(path, "skills"),
    tools: overlay(path, "tools"),
    memories: path.map(item => ({
      branch: item.id,
      memory: clone(item.memory),
      memoryVersion: item.memoryVersion,
    })),
  };
}

function pathTo(snapshot: SpineTreeSnapshot, branchId: string): SpineTreeBranch[] {
  const path: SpineTreeBranch[] = [];
  let current: SpineTreeBranch | undefined = snapshot.branches[branchId];
  while (current !== undefined) {
    path.push(current);
    current = current.parent === null ? undefined : snapshot.branches[current.parent];
  }
  return path.reverse();
}

function overlay(path: readonly SpineTreeBranch[], key: "skills" | "tools"): SpineTreeInheritedValue[] {
  const values = new Map<string, SpineTreeInheritedValue>();
  for (const branch of path) {
    for (const item of branch[key]) {
      const name = typeof item === "string"
        ? item
        : item !== null && typeof item === "object" && typeof (item as { name?: unknown }).name === "string"
          ? (item as { name: string }).name
          : JSON.stringify(item);
      values.set(name, { value: clone(item), source: branch.id });
    }
  }
  return [...values.values()];
}

function binding(snapshot: SpineTreeSnapshot, branchId: string): SpineTreeBinding | null {
  const branch = snapshot.branches[branchId]!;
  if (branch.scopeBinding !== undefined && branch.status !== "live") return null;
  const bindings = activeBranchBindings(snapshot, branchId);
  if (bindings.length > 1) {
    throw new SpineTreeReadError("ambiguous-binding", `ProjectBranch ${branchId} has multiple active Agents`);
  }
  return bindings[0] === undefined ? null : clone(bindings[0]);
}

/** Scope ownership supplements the Agent's immutable home-branch identity. */
function activeBranchBindings(snapshot: SpineTreeSnapshot, branchId: string): SpineTreeAgentBinding[] {
  const branch = snapshot.branches[branchId];
  const mapped = branch?.scopeBinding;
  return Object.values(snapshot.registry ?? {}).filter(candidate => {
    if (candidate.status === "ended") return false;
    return candidate.branch === branchId || (candidate.agentId === mapped?.agentId &&
      branch?.status === "live" && candidate.sessionId === mapped.sessionId);
  });
}

function validateGitHead(head: string): void {
  if (typeof head !== "string" || !/^[0-9a-f]{40,64}$/.test(head)) {
    throw new SpineTreeGitStoreError("invalid-head", "SpineTree Git HEAD must be a hexadecimal object id");
  }
}

function parseSnapshot(value: unknown): SpineTreeSnapshot {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as { schema?: unknown }).schema !== SPINETREE_SNAPSHOT_SCHEMA ||
    !isRecord((value as { branches?: unknown }).branches) ||
    Object.prototype.hasOwnProperty.call(value, "agents")
  ) {
    throw new SpineTreeGitStoreError("invalid-snapshot", "SpineTree snapshot requires spinetree.snapshot/v2 and a branches map, without legacy agents");
  }
  const snapshot = value as SpineTreeSnapshot;
  for (const branch of Object.values(snapshot.branches)) revisionOf(branch);
  return snapshot;
}

function revisionOf(branch: { revision?: unknown }): number {
  if (branch.revision === undefined) return 0;
  if (typeof branch.revision !== "number" || !Number.isSafeInteger(branch.revision) || branch.revision < 0) {
    throw new SpineTreeChangeError("invalid-change", "ProjectBranch revision must be a non-negative safe integer");
  }
  return branch.revision;
}

function stampBranchRevisions(previous: SpineTreeSnapshot, next: SpineTreeSnapshot): SpineTreeSnapshot {
  const branches: Record<string, SpineTreeBranch> = {};
  for (const [id, branch] of Object.entries(next.branches)) {
    const old = previous.branches[id];
    const revision = old === undefined
      ? 0
      : canonicalBranch(old) === canonicalBranch(branch) ? revisionOf(old) : revisionOf(old) + 1;
    const stamped = clone(branch) as DraftSpineTreeBranch;
    if (revision === 0) delete stamped.revision;
    else stamped.revision = revision;
    branches[id] = stamped;
  }
  return { ...next, branches };
}

function canonicalBranch(branch: SpineTreeBranch): string {
  const value = clone(branch) as Record<string, unknown>;
  delete value.revision;
  return canonicalJson(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function runGit(cwd: string, args: readonly string[], input?: string): string {
  try {
    return execFileSync("git", [...args], {
      cwd,
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    throw new SpineTreeGitStoreError("git-error", formatError(error));
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
