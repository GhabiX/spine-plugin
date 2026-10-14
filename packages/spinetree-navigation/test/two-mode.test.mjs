import assert from "node:assert/strict";
import test from "node:test";
import navigation from "../dist/extension.js";

for (const order of ["l1-first", "navigation-first"]) {
  test(`navigation suppresses SDK tree in frozen st mode (${order})`, async () => {
    const listeners = new Map(), handlers = new Map(), commands = new Map(), notices = [];
    let treeQueries = 0, mode = "st", sessionId = "st-session";
    const pi = {
      events: {
        on(name, handler) { listeners.set(name, handler); },
        emit(name, query) {
          if (name === "spinejit:tree-view:v1") treeQueries++;
          listeners.get(name)?.(query);
        },
      },
      on(name, handler) { handlers.set(name, handler); },
      registerCommand(name, command) { commands.set(name, command); },
    };
    const ctx = {cwd: "/isolated", mode: "tui", hasUI: true,
      sessionManager: {getSessionId: () => sessionId}, ui: {notify(text) { notices.push(text); }} };
    const respond = () => pi.events.on("spinetree:mode", query => { query.mode = mode; });
    if (order === "l1-first") respond();
    navigation(pi);
    if (order === "navigation-first") respond();
    await handlers.get("session_start")({}, ctx);
    await commands.get("spine-tree").handler("", ctx);
    assert.equal(treeQueries, 0);
    assert.match(notices[0], /uses SpineTree/);
    mode = "sdk";
    await handlers.get("session_start")({}, ctx);
    await commands.get("spine-tree").handler("", ctx);
    assert.equal(treeQueries, 0); // Same session does not change.
    sessionId = "sdk-session";
    await handlers.get("session_start")({}, ctx);
    await commands.get("spine-tree").handler("", ctx);
    assert.equal(treeQueries, 1);
    assert.match(notices.at(-1), /SpineJIT.*required/);
  });
}

test("without SpineTree provider SDK navigation keeps its original discovery", async () => {
  let handler, startup, queries = 0;
  const pi = {events: {emit(name) { if (name === "spinejit:tree-view:v1") queries++; }},
    on(_name, cb) { startup = cb; }, registerCommand(_name, command) { handler = command.handler; }};
  const ctx = {cwd: "/isolated", mode: "tui", hasUI: true,
    sessionManager: {getSessionId: () => "sdk"}, ui: {notify() {}}};
  navigation(pi);
  await startup({}, ctx);
  await handler("", ctx);
  assert.equal(queries, 1);
});
