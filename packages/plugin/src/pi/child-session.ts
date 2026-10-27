import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  CURRENT_SESSION_VERSION,
  SessionManager,
  sessionEntryToContextMessages,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";

import { buildPiReplayPlan } from "./recovery.js";
import type { PiAgentMessage } from "./messages.js";

export const CHILD_RETURN_TOOL = "spine_child_return";

export interface ChildAssignmentTask {
  summary: string;
  prompt: string;
}

/** FormularDef 2.5 Δ_child: identity, peers, inherited-scope rules, and typed return. */
export function buildChildAssignment(
  task: ChildAssignmentTask,
  peers: readonly ChildAssignmentTask[],
): string {
  const identity = task.summary.trim();
  const peerLines = peers
    .map((peer) => peer.summary.trim())
    .filter((summary) => summary !== identity)
    .map((summary) => `- ${summary}`);
  const peersBlock = peerLines.length === 0 ? "- (none)" : peerLines.join("\n");
  return `You are a spawned execution branch. Your role is to complete exactly the assignment below and return bounded terminal memory to the spawning continuation.

You are: ${identity}

Peer branches in this spawn:
${peersBlock}

The assignment is already an active branch scope. Begin the assigned work directly. Use spine_open, spine_close, and spine_next only to manage genuine descendant work within this assignment. Use spine_spawn only when this assignment itself has two or more independent parallel sub-assignments.

Executable work is defined by the assignment. Inherited context supplies constraints and evidence for that work.

When the assignment declares a collaboration contract, follow its named root, peer roles, artifact format, update/read protocol, synchronization points, and bounded fallback. Inspect the coordination root before substantive work. Coordinate through it to minimize unnecessary duplicate work: respect assigned scopes, share reusable evidence early, and independently verify load-bearing or disputed claims. Within the coordination root, write only your declared single-writer artifact and read peer artifacts through the declared protocol, even when the investigated source and evidence are otherwise read-only. Unless the contract provides locking or atomic append, preserve your artifact append-only. Publish findings, conflicts, or requests useful to peers at the declared synchronization points. Before returning your final memory, perform the declared final peer read and state which peer deltas you incorporated. Never write a peer artifact, let collaboration expand the assignment, make completion depend on peer state, or treat collaboration artifacts as correctness-critical evidence. If the root or peer state is unavailable or incomplete, use the declared bounded fallback; do not invent another coordination path.

Other shared-workspace changes remain context for the assignment and do not add executable work. Production-file ownership and any integration responsibility remain exactly as declared in the assignment.

Complete this branch by calling ${CHILD_RETURN_TOOL} exactly once with the complete continuation memory. After that call, execution ends.

Assignment:
${task.prompt}`;
}

export interface ChildSessionScope {
  /** The parent Pi session id; birth ids are unique only within it. */
  parentSessionId: string;
  parentSessionFile?: string;
}

/** A child's session file for one attempt, named by its birth id. */
export function childSessionPath(
  scope: ChildSessionScope,
  producer: readonly number[],
  attempt = 0,
): string {
  const name = attempt === 0
    ? `${producer.join(".")}.jsonl`
    : `${producer.join(".")}.attempt-${attempt}.jsonl`;
  return join(childSessionDir(scope), name);
}

function childSessionDir(scope: ChildSessionScope): string {
  const root = scope.parentSessionFile === undefined
    ? join(tmpdir(), "pi-spine-spawn")
    : join(dirname(scope.parentSessionFile), "spine-spawn");
  return join(root, safeSegment(scope.parentSessionId));
}

/**
 * The child's own durable result: the memory of its last spine_child_return
 * across attempts, or null when no attempt returned. `latest` is the newest
 * attempt's session file, if any.
 */
export async function readChildReturn(
  scope: ChildSessionScope,
  producer: readonly number[],
): Promise<{ memory: string | null; latest: { path: string; attempt: number } | null }> {
  const pattern = new RegExp(`^${producer.join("\\.")}(?:\\.attempt-(\\d+))?\\.jsonl$`);
  let names: string[];
  try {
    names = await readdir(childSessionDir(scope));
  } catch {
    return { memory: null, latest: null };
  }
  const attempts = names
    .map((name) => ({ name, match: pattern.exec(name) }))
    .filter((item) => item.match !== null)
    .map((item) => ({ path: join(childSessionDir(scope), item.name), attempt: Number(item.match![1] ?? 0) }))
    .sort((left, right) => left.attempt - right.attempt);
  let memory: string | null = null;
  for (const attempt of attempts) {
    memory = returnedMemory(await readFile(attempt.path, "utf8")) ?? memory;
  }
  return { memory, latest: attempts.at(-1) ?? null };
}

function returnedMemory(sessionJsonl: string): string | null {
  let memory: string | null = null;
  for (const line of sessionJsonl.split("\n")) {
    if (line.trim().length === 0) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const message = isRecord(entry) && entry.type === "message" && isRecord(entry.message) ? entry.message : null;
    if (message === null || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const item of message.content) {
      if (
        isRecord(item) && item.type === "toolCall" && item.name === CHILD_RETURN_TOOL &&
        isRecord(item.arguments) && typeof item.arguments.memory === "string" &&
        item.arguments.memory.trim().length > 0
      ) {
        memory = item.arguments.memory;
      }
    }
  }
  return memory;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function writeChildPrefixSession(options: {
  cwd: string;
  destPath: string;
  entries: readonly unknown[];
  parentSession?: string;
}): Promise<string> {
  await mkdir(dirname(options.destPath), { recursive: true });
  const id = randomUUID();
  const header: Record<string, unknown> = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id,
    timestamp: new Date().toISOString(),
    cwd: options.cwd,
  };
  if (options.parentSession !== undefined) {
    header.parentSession = options.parentSession;
  }
  const lines = [JSON.stringify(header)];
  for (const entry of options.entries) {
    lines.push(JSON.stringify(entry));
  }
  await writeFile(options.destPath, `${lines.join("\n")}\n`);
  return id;
}

export async function readChildSessionIdentity(destPath: string): Promise<string> {
  const firstLine = (await readFile(destPath, "utf8")).split("\n", 1)[0]?.trim();
  if (firstLine === undefined || firstLine.length === 0) {
    throw new Error(`Pi Spawn child session is empty: ${destPath}`);
  }
  let header: unknown;
  try {
    header = JSON.parse(firstLine);
  } catch (cause) {
    throw new Error(`Pi Spawn child session header is invalid: ${destPath}`, { cause });
  }
  const record = header !== null && typeof header === "object"
    ? header as Record<string, unknown>
    : null;
  if (
    record === null ||
    record.type !== "session" ||
    typeof record.id !== "string" ||
    record.id.trim().length === 0
  ) {
    throw new Error(`Pi Spawn child session header is missing identity: ${destPath}`);
  }
  return record.id;
}

export async function inspectChildSession(options: {
  cwd: string;
  destPath: string;
  expectedId: string;
  assignment: string;
}): Promise<{ id: string; assignmentPresent: boolean }> {
  const id = await readChildSessionIdentity(options.destPath);
  if (id !== options.expectedId) {
    throw new Error(`Pi Spawn child session identity changed: ${options.destPath}`);
  }
  const session = SessionManager.open(options.destPath, undefined, options.cwd);
  const header = session.getHeader();
  if (header === null || header.id !== options.expectedId) {
    throw new Error(`Pi Spawn child session header is inconsistent: ${options.destPath}`);
  }
  const branch = session.getBranch();
  try {
    buildPiReplayPlan({
      currentSessionId: session.getSessionId(),
      branch,
      messagesForEntry: (entry) =>
        sessionEntryToContextMessages(entry as SessionEntry) as PiAgentMessage[],
    });
  } catch (cause) {
    throw new Error(
      `Pi Spawn child session cannot continue after Spine recovery validation: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }
  const assignmentPresent = branch.some((entry) =>
    sessionEntryContainsText(entry, options.assignment),
  );
  return { id, assignmentPresent };
}

export function buildChildContinuation(guidance?: string, fallbackAssignment?: string): string {
  const fallback = fallbackAssignment === undefined
    ? ""
    : `\n\nThe original assignment was not present in the active session context. Use the following only to restore task context; inspect the existing state first and do not repeat work that is already complete.\n\nAssignment context:\n${fallbackAssignment}`;
  const note = guidance === undefined ? "" : `\n\nUser guidance:\n${guidance}`;
  return `The previous execution attempt did not complete the assigned work. Continue the same active branch from the existing session history. Inspect the current state, finish the assignment, and call ${CHILD_RETURN_TOOL} exactly once with the complete terminal memory. Do not start a new branch or repeat work that is already complete.${fallback}${note}`;
}

function sessionEntryContainsText(entry: SessionEntry, text: string): boolean {
  if (entry.type !== "message" || entry.message.role !== "user") return false;
  const content = entry.message.content;
  if (typeof content === "string") return content.includes(text);
  if (!Array.isArray(content)) return false;
  return content.some((item) =>
    typeof item === "object" && item !== null &&
    "type" in item && item.type === "text" &&
    "text" in item && typeof item.text === "string" && item.text.includes(text),
  );
}

function safeSegment(value: string): string {
  const trimmed = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._-]+|[._-]+$/g, "");
  return (trimmed.length === 0 ? "call" : trimmed).slice(0, 64);
}
