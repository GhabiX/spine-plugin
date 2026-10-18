import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { watchParent } from "../dist/pi/parent-watch.js";

test("parent watch stays silent while the parent is unchanged", async () => {
  let calls = 0;
  const stop = watchParent({ expectedParent: 4242, ppid: () => 4242, onOrphaned: () => calls++, intervalMs: 5 });
  await sleep(40);
  stop();
  assert.equal(calls, 0);
});

test("parent watch fires once when the child is reparented", async () => {
  let ppid = 4242;
  let calls = 0;
  watchParent({ expectedParent: 4242, ppid: () => ppid, onOrphaned: () => calls++, intervalMs: 5 });
  ppid = 1;
  await sleep(40);
  ppid = 77;
  await sleep(20);
  assert.equal(calls, 1);
});

test("a child already adopted by a subreaper before the watch starts is orphaned at once", () => {
  let calls = 0;
  watchParent({ expectedParent: 4242, ppid: () => 77, onOrphaned: () => calls++, intervalMs: 5 });
  assert.equal(calls, 1);
});

test("stop prevents a later orphan callback", async () => {
  let ppid = 4242;
  let calls = 0;
  const stop = watchParent({ expectedParent: 4242, ppid: () => ppid, onOrphaned: () => calls++, intervalMs: 5 });
  stop();
  ppid = 1;
  await sleep(30);
  assert.equal(calls, 0);
});

// Real processes: SIGKILL the parent (no cleanup can run there) and require the
// child, which watches the parent PID it was given, to exit by itself.
test("child exits after its parent is SIGKILLed", async (t) => {
  const marker = join(mkdtempSync(join(tmpdir(), "parent-watch-")), "orphaned");
  const watch = pathToFileURL(join(import.meta.dirname, "../dist/pi/parent-watch.js")).href;
  const child = `
    import { writeFileSync } from "node:fs";
    const { watchParent } = await import(${JSON.stringify(watch)});
    watchParent({ expectedParent: Number(process.argv[1]), ppid: () => process.ppid, intervalMs: 50,
      onOrphaned: () => { writeFileSync(${JSON.stringify(marker)}, ""); process.exit(1); } });
    process.stdout.write("ready\\n");
    setInterval(() => {}, 1000); // stands in for a long-running agent turn
  `;
  const parent = `
    import { spawn } from "node:child_process";
    const c = spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(child)}, String(process.pid)],
      { stdio: ["ignore", "pipe", "inherit"] });
    c.stdout.once("data", () => console.log(c.pid));
    setInterval(() => {}, 1000);
  `;
  const p = spawn(process.execPath, ["--input-type=module", "-e", parent], { stdio: ["ignore", "pipe", "inherit"] });
  let childPid = 0;
  t.after(() => {
    p.kill("SIGKILL");
    if (childPid > 0 && running(childPid)) process.kill(childPid, "SIGKILL");
  });
  childPid = Number(await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("child never reported ready")), 10_000);
    p.once("exit", (code) => reject(new Error(`parent exited early (${code})`)));
    p.stdout.once("data", (d) => { clearTimeout(timer); resolve(String(d).trim()); });
  }));
  assert.ok(running(childPid));
  p.kill("SIGKILL");
  for (let i = 0; i < 60 && running(childPid); i++) await sleep(50);
  assert.equal(running(childPid), false, "orphaned child kept running");
  assert.ok(existsSync(marker), "child did not take the orphan path");
});

/** Running, not merely present: a reaped or zombie process counts as gone. */
function running(pid) {
  const r = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  const stat = r.stdout.trim();
  return stat.length > 0 && !stat.startsWith("Z");
}
