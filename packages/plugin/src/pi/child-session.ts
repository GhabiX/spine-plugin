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

import { SPINE_CHILD_RETURN_TOOL } from "@spinejit/spine-sdk/host";

import { buildPiReplayPlan } from "./recovery.js";
import type { PiAgentMessage } from "./messages.js";

export interface ChildSessionScope {
  /** The parent Pi session id; birth ids are unique only within it. */
  parentSessionId: string;
  parentSessionFile?: string;
}

/**
 * A birth within its parent session. Birth ids repeat across Pi tree branches
 * of one session, so the birth is named by the Pi entry of the sampling that
 * bore it (`origin`) together with its id.
 */
export interface ChildBirthRef {
  origin: string;
  producer: readonly number[];
}

/** A child's session file for one attempt, named by its birth. */
export function childSessionPath(
  scope: ChildSessionScope,
  birth: ChildBirthRef,
  attempt = 0,
): string {
  const stem = childSessionStem(birth);
  return join(childSessionDir(scope), attempt === 0 ? `${stem}.jsonl` : `${stem}.attempt-${attempt}.jsonl`);
}

function childSessionStem(birth: ChildBirthRef): string {
  return `${safeSegment(birth.origin)}.${birth.producer.join(".")}`;
}

function childSessionDir(scope: ChildSessionScope): string {
  const root = scope.parentSessionFile === undefined
    ? join(tmpdir(), "pi-spine-spawn")
    : join(dirname(scope.parentSessionFile), "spine-spawn");
  return join(root, safeSegment(scope.parentSessionId));
}

/**
 * The child's own durable result: the memory of the latest attempt that
 * returned, or null when no attempt returned. `latest` is the newest attempt's
 * session file, if any.
 */
export async function readChildReturn(
  scope: ChildSessionScope,
  birth: ChildBirthRef,
): Promise<{ memory: string | null; latest: { path: string; attempt: number } | null }> {
  const stem = childSessionStem(birth).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${stem}(?:\\.attempt-(\\d+))?\\.jsonl$`);
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
    const accepted = acceptedChildReturns(await readFile(attempt.path, "utf8"));
    if (accepted.length === 1) memory = accepted[0]!;
  }
  return { memory, latest: attempts.at(-1) ?? null };
}

/**
 * The memories a child's session accepted as its typed return: each
 * spine_child_return call whose own tool result succeeded. A call the
 * child's admission blocked has an error result and returns nothing.
 */
export function acceptedChildReturns(sessionJsonl: string): string[] {
  const calls = new Map<string, string>();
  const accepted: string[] = [];
  for (const line of sessionJsonl.split("\n")) {
    if (line.trim().length === 0) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const message = isRecord(entry) && entry.type === "message" && isRecord(entry.message) ? entry.message : null;
    if (message === null) continue;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const item of message.content) {
        if (
          isRecord(item) && item.type === "toolCall" && item.name === SPINE_CHILD_RETURN_TOOL &&
          typeof item.id === "string" && isRecord(item.arguments) &&
          typeof item.arguments.memory === "string" && item.arguments.memory.trim().length > 0
        ) {
          calls.set(item.id, item.arguments.memory);
        }
      }
    }
    if (
      message.role === "toolResult" && message.toolName === SPINE_CHILD_RETURN_TOOL &&
      message.isError === false && typeof message.toolCallId === "string"
    ) {
      const memory = calls.get(message.toolCallId);
      if (memory !== undefined) accepted.push(memory);
    }
  }
  return accepted;
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
  return `The previous execution attempt did not complete the assigned work. Continue the same active branch from the existing session history. Inspect the current state, finish the assignment, and call ${SPINE_CHILD_RETURN_TOOL} exactly once with the complete terminal memory. Do not start a new branch or repeat work that is already complete.${fallback}${note}`;
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
