// Real CLI + package-manifest discovery + RPC + deterministic loopback provider.
// No SDK-created session, hand-built ExtensionRunner, real model or credentials.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const [root, installed] = process.argv.slice(2);
const agent = join(root, "agent");
const cwd = join(root, "cli-cwd");
await mkdir(cwd);
const probe = join(agent, "release-host-probe.mjs");
await cp(fileURLToPath(new URL("release-host-probe.mjs", import.meta.url)), probe);
const probeLog = join(root, "cli-probe.jsonl");
const neighbor = join(agent, "extensions", "release-neighbor.js");
await mkdir(join(agent, "extensions"));
await cp(fileURLToPath(new URL("release-local-extension.mjs", import.meta.url)), neighbor);
const neighborLog = join(root, "cli-neighbor.jsonl");
const requests = [];
let serverError;
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/chat/completions");
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    requests.push(payload);
    assert.ok(requests.length <= 4, "Unexpected extra provider call");
    assert.equal(payload.model, "release-local");
    assert.equal(payload.stream, true);
    const index = requests.length;
    const tool = index === 1 ? { name: "spine_open", arguments: JSON.stringify({ goal: "release gate scope" }) }
      : index === 2 ? { name: "spine_close", arguments: JSON.stringify({ memory: "release gate memory" }) }
      : index === 3 ? { name: "release_neighbor_ping", arguments: "{}" } : null;
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const chunk = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({
      id: `release-${index}`, object: "chat.completion.chunk", created: 1, model: "release-local",
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`);
    chunk({ role: "assistant" });
    if (tool) chunk({ tool_calls: [{ index: 0, id: `release-call-${index}`, type: "function", function: tool }] });
    else chunk({ content: "SPINE_RELEASE_LOCAL_OK" });
    chunk({}, tool ? "tool_calls" : "stop");
    response.end("data: [DONE]\n\n");
  } catch (error) {
    serverError = error;
    response.writeHead(500);
    response.end(String(error));
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + "\n");
await save(join(agent, "settings.json"), {
  packages: [installed], extensions: [probe], quietStartup: true,
  compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: { enabled: false },
});
await save(join(agent, "models.json"), { providers: { "spine-release-local": {
  baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "not-a-secret",
  models: [{ id: "release-local", name: "Deterministic release fixture", reasoning: false, input: ["text"],
    contextWindow: 200000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
} } });
const bindings = JSON.parse(await readFile(join(root, "consumer-bindings.json"), "utf8"));
const hostDirectory = bindings.bindings["@earendil-works/pi-coding-agent"].directory;
const hostManifest = JSON.parse(await readFile(join(hostDirectory, "package.json"), "utf8"));
const cli = join(hostDirectory, typeof hostManifest.bin === "string" ? hostManifest.bin : hostManifest.bin.pi);
const args = [cli, "--mode", "rpc", "--no-session", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
  "--no-mcp", "--no-approve", "--provider", "spine-release-local", "--model", "release-local", "--thinking", "off"];
await save(join(root, "cli-command.json"), { command: process.execPath, args, cwd, host: hostManifest.version });
const child = spawn(process.execPath, args, { cwd, env: { ...process.env, SPINE_RELEASE_PROBE_LOG: probeLog,
  SPINE_RELEASE_NEIGHBOR_LOG: neighborLog }, stdio: ["pipe", "pipe", "pipe"] });
const records = [];
let stdout = "", stderr = "", pending = "", parseError, exit;
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", chunk => {
  stdout += chunk;
  pending += chunk;
  let boundary;
  while ((boundary = pending.indexOf("\n")) >= 0) {
    const line = pending.slice(0, boundary).replace(/\r$/, "");
    pending = pending.slice(boundary + 1);
    if (line) try { records.push(JSON.parse(line)); } catch (error) { parseError = error; }
  }
});
child.stderr.on("data", chunk => { stderr += chunk; });
const exited = new Promise(resolve => {
  child.on("error", error => { parseError = error; });
  child.on("close", (code, signal) => { exit = { code, signal }; resolve(exit); });
});
async function until(predicate) {
  const deadline = Date.now() + 90_000;
  while (!predicate()) {
    assert.ifError(parseError);
    assert.ifError(serverError);
    assert.equal(records.find(record => record.type === "extension_error"), undefined, JSON.stringify(records));
    assert.ok(!exit, `CLI exited early: ${JSON.stringify(exit)}\n${stderr}`);
    assert.ok(Date.now() < deadline, `RPC deadline exceeded\n${stderr}\n${stdout.slice(-4000)}`);
    await sleep(10);
  }
}
let serial = 0;
async function command(type, fields = {}) {
  const id = `release-${++serial}`;
  child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
  await until(() => records.some(record => record.type === "response" && record.id === id));
  const response = records.find(record => record.type === "response" && record.id === id);
  assert.equal(response.success, true, JSON.stringify(response));
  return response.data;
}
async function inspect() {
  const start = records.length;
  await command("prompt", { message: "/spine-release-inspect" });
  const notification = records.slice(start).find(record => record.type === "extension_ui_request" && record.message?.startsWith("SPINE_RELEASE_PROBE:"));
  assert.ok(notification, "The actual host must execute the independently discovered probe command");
  const state = JSON.parse(notification.message.slice("SPINE_RELEASE_PROBE:".length));
  assert.deepEqual(state.tools.map(tool => tool.name).sort(), ["spine_close", "spine_next", "spine_open", "spine_spawn"]);
  for (const tool of state.tools) {
    assert.equal(tool.parameters.type, "object");
    assert.ok(tool.description.length > 0);
    if (tool.sourceInfo) assert.equal(tool.sourceInfo.path, join(installed, "dist/pi/extension.js"));
  }
  assert.equal(state.neighborTools.length, 1, "Unrelated auto-discovered extension tool must coexist");
  assert.equal(state.neighborTools[0].sourceInfo.path, neighbor);
  return state;
}
try {
  const commands = await command("get_commands");
  const tree = commands.commands.find(command => command.name === "spine-tree");
  assert.ok(tree, "CLI must discover the tarball-installed Pi package from settings, not -e entry injection");
  assert.equal(tree.sourceInfo?.path ?? tree.path, join(installed, "dist/pi/extension.js"));
  const neighborCommand = commands.commands.find(command => command.name === "release-neighbor");
  assert.equal(neighborCommand?.sourceInfo?.path ?? neighborCommand?.path, neighbor);
  const commandStart = records.length;
  await command("prompt", { message: "/release-neighbor" });
  assert.ok(records.slice(commandStart).some(record => record.message === "RELEASE_NEIGHBOR_COMMAND_OK"));
  const before = await inspect();
  assert.equal(before.archives.length, 0);
  assert.equal(before.neighborEntries.length, 1);
  await command("prompt", { message: "Exercise the release fixture only." });
  await until(() => records.some(record => record.type === "agent_settled"));
  const after = await inspect();
  assert.equal(after.sessionId, before.sessionId);
  assert.equal(requests.length, 4);
  assert.deepEqual(after.neighborEntries, before.neighborEntries, "Spine must preserve unrelated durable entries");
  for (const request of requests) {
    const text = JSON.stringify(request.messages);
    assert.match(text, /spine_instruction/);
    assert.match(text, /\[U1\]/);
    assert.ok(request.tools.some(tool => tool.function.name === "release_neighbor_ping"));
    assert.deepEqual(request.tools.filter(tool => tool.function.name.startsWith("spine_")).map(tool => tool.function.name).sort(),
      ["spine_close", "spine_next", "spine_open", "spine_spawn"]);
  }
  const executions = records.filter(record => record.type === "tool_execution_end");
  assert.deepEqual(executions.map(record => [record.toolName, record.isError]),
    [["spine_open", false], ["spine_close", false], ["release_neighbor_ping", false]]);
  assert.ok(records.some(record => record.type === "message_end" && record.message?.content?.some?.(part => part.text === "SPINE_RELEASE_LOCAL_OK")));
  assert.equal(after.archives.some(entry => entry.customType === "spine.fault.v1"), false);
  assert.deepEqual(after.archives.filter(entry => entry.customType === "spine.archive.v1").map(entry => entry.data.record.type),
    Array.from({ length: 4 }, () => ["sampling_started", "sampling_commit"]).flat());
  await command("prompt", { message: "/spine-tree" }); // RPC must not attempt terminal-only custom UI.
  const replaced = await command("new_session");
  assert.equal(replaced.cancelled, false);
  const fresh = await inspect();
  assert.notEqual(fresh.sessionId, before.sessionId);
  assert.equal(fresh.archives.length, 0);
  assert.equal(fresh.neighborEntries.length, 0);
  await command("prompt", { message: "/spine-release-quit" });
  await Promise.race([exited, sleep(10_000).then(() => { throw new Error("CLI did not shut down gracefully"); })]);
  assert.equal(exit.code, 0, stderr);
  assert.equal(pending, "", "Incomplete final JSONL record");
  assert.ifError(parseError);
  const events = (await readFile(probeLog, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  // Both supported hosts emit session_start(new) twice; assert ordering and
  // identity without incorrectly demanding exactly one start notification.
  const lifecycle = events.filter(event => ["session_start", "session_shutdown"].includes(event.event));
  assert.deepEqual(lifecycle[0], { event: "session_start", reason: "startup", sessionId: before.sessionId });
  assert.deepEqual(lifecycle.filter(event => event.event === "session_shutdown"), [
    { event: "session_shutdown", reason: "new", sessionId: before.sessionId },
    { event: "session_shutdown", reason: "quit", sessionId: fresh.sessionId },
  ]);
  const newIndex = lifecycle.findIndex(event => event.event === "session_shutdown" && event.reason === "new");
  assert.ok(lifecycle.slice(newIndex + 1, -1).length >= 1);
  for (const event of lifecycle.slice(newIndex + 1, -1)) {
    assert.deepEqual(event, { event: "session_start", reason: "new", sessionId: fresh.sessionId });
  }
  for (const [name, count] of [["before_agent_start", 1], ["context", 4], ["turn_end", 4], ["agent_settled", 1]]) {
    assert.equal(events.filter(event => event.event === name && event.sessionId === before.sessionId).length, count, name);
  }
  for (const name of ["tool_call", "tool_result"]) {
    assert.deepEqual(events.filter(event => event.event === name).map(event => event.toolName),
      ["spine_open", "spine_close", "release_neighbor_ping"], name);
  }
  const neighborEvents = (await readFile(neighborLog, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(neighborEvents.filter(event => event.event === "execute" && event.sessionId === before.sessionId).length, 1);
  for (const name of ["context", "turn_end"]) assert.equal(neighborEvents.filter(event => event.event === name).length, 4, name);
  assert.ok(!/Failed to load extension|Error loading extension/i.test(stderr), stderr);
  await save(join(root, "cli-result.json"), { status: "passed", cli, host: hostManifest.version,
    providerRequests: requests.length, tools: executions.map(record => record.toolName),
    lifecycle, neighbor: { path: neighbor, command: neighborCommand, events: neighborEvents }, packageCommand: tree });
} finally {
  if (!exit) {
    child.stdin.end();
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(timer);
  }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await writeFile(join(root, "cli.stdout.jsonl"), stdout);
  await writeFile(join(root, "cli.stderr.log"), stderr);
  await save(join(root, "provider-requests.json"), requests);
}
console.log(`PASS: real Pi ${hostManifest.version} CLI package discovery, tool transactions, session replacement and shutdown`);
