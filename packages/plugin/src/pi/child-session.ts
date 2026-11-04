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

import { childState, type ChildLogItem } from "@spinejit/spine-sdk/host";

import { buildPiReplayPlan } from "./recovery.js";
import { isPiHostSystemMessage, sourceObservation, type PiAgentMessage } from "./messages.js";
import type { SpawnAcceptedDetails } from "./spawn-view.js";

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

/** The newest attempt's session file of a child, or null when none was saved. */
export async function latestChildSession(
  scope: ChildSessionScope,
  birth: ChildBirthRef,
): Promise<{ path: string; attempt: number } | null> {
  const stem = childSessionStem(birth).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${stem}(?:\\.attempt-(\\d+))?\\.jsonl$`);
  let names: string[];
  try {
    names = await readdir(childSessionDir(scope));
  } catch (cause) {
    // The directory is made with the first child session of this parent.
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
  return names
    .map((name) => ({ name, match: pattern.exec(name) }))
    .filter((item) => item.match !== null)
    .map((item) => ({ path: join(childSessionDir(scope), item.name), attempt: Number(item.match![1] ?? 0) }))
    .sort((left, right) => left.attempt - right.attempt)
    .at(-1) ?? null;
}

/**
 * Where a child stands, read from its session file by the Spawn end rule over
 * what the child itself wrote: its active branch past the birth prefix, whose
 * length the header records.
 */
export function readChildState(path: string): ReturnType<typeof childState> {
  const session = SessionManager.open(path);
  const { inheritedEntryCount } = session.getHeader() as unknown as { inheritedEntryCount: number };
  return childState(session.getBranch().slice(inheritedEntryCount).flatMap((entry) =>
    // System messages and summaries are the host's bookkeeping, not the child's conversation.
    sessionEntryToContextMessages(entry).filter((message) =>
      !isPiHostSystemMessage(message) && message.role !== "compactionSummary" && message.role !== "branchSummary")
      .map((message) => childLogItem(message as PiAgentMessage))));
}

function childLogItem(message: PiAgentMessage): ChildLogItem {
  if (message.role === "assistant" && message.stopReason === "error") {
    // Pi's AssistantMessage leaves errorMessage optional.
    return { type: "error", message: (message.errorMessage as string | undefined) ?? "the model request ended with stopReason error" };
  }
  if (message.role === "toolResult" && message.toolName === "spine_spawn" && !message.isError) {
    return { type: "spawn", births: (message.details as SpawnAcceptedDetails).tasks.length };
  }
  const { character } = sourceObservation(message, 0);
  if (character.type === "arrival") return { type: "arrival" };
  if (character.type === "message" && character.role === "reply") return { type: "reply", text: character.content };
  return { type: "other" };
}

export async function writeChildPrefixSession(options: {
  cwd: string;
  destPath: string;
  entries: readonly unknown[];
  birth: readonly number[];
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
    // Where the child's own entries begin: readChildState reads past it.
    inheritedEntryCount: options.entries.length,
    // The Spawn birth this child runs: it starts in the node its parent spawned it in.
    birth: options.birth,
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
  return `The previous execution attempt did not complete the assigned work. Continue the same active branch from the existing session history. Inspect the current state, finish the assignment, and end with a final reply that holds the complete terminal memory. Do not start a new branch or repeat work that is already complete.${fallback}${note}`;
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
