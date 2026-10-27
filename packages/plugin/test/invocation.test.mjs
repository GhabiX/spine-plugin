import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { resolvePiInvocation } from "../dist/pi/invocation.js";

const exists = (path) => path === "/abs/cli.js" || path === "/abs/cli.ts";

test("npm dist/cli.js keeps an empty execArgv image", () => {
  assert.deepEqual(
    resolvePiInvocation(
      {
        execPath: "/usr/bin/node",
        execArgv: [],
        argv: ["/usr/bin/node", "/abs/cli.js", "--mode", "json"],
      },
      exists,
    ),
    { command: "/usr/bin/node", args: ["/abs/cli.js"] },
  );
});

test("tsx CLI plus cli.ts keeps the tsx prefix in front of the Pi entry", () => {
  assert.deepEqual(
    resolvePiInvocation(
      {
        execPath: "/usr/bin/node",
        execArgv: [],
        argv: [
          "/usr/bin/node",
          "/abs/tsx",
          "--tsconfig",
          "/abs/tsconfig.json",
          "/abs/cli.ts",
          "--print",
        ],
      },
      exists,
    ),
    {
      command: "/usr/bin/node",
      args: ["/abs/tsx", "--tsconfig", "/abs/tsconfig.json", "/abs/cli.ts"],
    },
  );
});

test("tsx loaders stay in front of cli.ts", () => {
  assert.deepEqual(
    resolvePiInvocation(
      {
        execPath: "/usr/bin/node",
        execArgv: [
          "--require",
          "/abs/tsx/preflight.cjs",
          "--import",
          "file:///abs/tsx/loader.mjs",
        ],
        argv: ["/usr/bin/node", "/abs/cli.ts", "--print"],
      },
      exists,
    ),
    {
      command: "/usr/bin/node",
      args: [
        "--require",
        "/abs/tsx/preflight.cjs",
        "--import",
        "file:///abs/tsx/loader.mjs",
        "/abs/cli.ts",
      ],
    },
  );
});

test("experimental strip-types is copied", () => {
  assert.deepEqual(
    resolvePiInvocation(
      {
        execPath: "/usr/bin/node",
        execArgv: ["--experimental-strip-types"],
        argv: ["/usr/bin/node", "/abs/cli.ts"],
      },
      exists,
    ),
    {
      command: "/usr/bin/node",
      args: ["--experimental-strip-types", "/abs/cli.ts"],
    },
  );
});

test("inspector flags are dropped including a separate --inspect-port value", () => {
  assert.deepEqual(
    resolvePiInvocation(
      {
        execPath: "/usr/bin/node",
        execArgv: [
          "--inspect-brk=127.0.0.1:9229",
          "--inspect-port",
          "9230",
          "--require",
          "/abs/tsx/preflight.cjs",
        ],
        argv: ["/usr/bin/node", "/abs/cli.ts"],
      },
      exists,
    ),
    {
      command: "/usr/bin/node",
      args: ["--require", "/abs/tsx/preflight.cjs", "/abs/cli.ts"],
    },
  );
});

test("bun compiled image falls back to execPath", () => {
  assert.deepEqual(
    resolvePiInvocation(
      {
        execPath: "/abs/pi-binary",
        execArgv: [],
        argv: ["/abs/pi-binary", "/$bunfs/root/cli"],
      },
      () => true,
    ),
    { command: "/abs/pi-binary", args: [] },
  );
});

test("node without a script falls back to pi on PATH", () => {
  assert.deepEqual(
    resolvePiInvocation(
      {
        execPath: "/usr/bin/node",
        execArgv: [],
        argv: ["/usr/bin/node"],
      },
      exists,
    ),
    { command: "pi", args: [] },
  );
});

const here = dirname(fileURLToPath(import.meta.url));
const piRoot = join(here, "../../../../pi-home/pi");
const preflight = join(piRoot, "node_modules/tsx/dist/preflight.cjs");
const loaderFile = join(piRoot, "node_modules/tsx/dist/loader.mjs");
const cli = join(piRoot, "packages/coding-agent/src/cli.ts");
const dump = join(here, "dump-invocation.mjs");
// These run against the Pi source checkout next to this workspace (scaffold/pi-home/pi);
// a clone without it, such as CI, skips them.
const localPi = existsSync(piRoot) ? {} : { skip: "no Pi source checkout at ../pi-home/pi" };

test("live tsx execArgv plus script reconstructs the parent image", localPi, () => {
  assert.equal(existsSync(preflight), true);
  assert.equal(existsSync(loaderFile), true);
  assert.equal(existsSync(dump), true);
  const loader = pathToFileURL(loaderFile).href;
  const result = spawnSync(
    process.execPath,
    ["--require", preflight, "--import", loader, dump],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    command: process.execPath,
    args: ["--require", preflight, "--import", loader, dump],
  });
});

test("PI cli.ts --help from a foreign cwd retains execArgv and TSX_TSCONFIG_PATH", localPi, () => {
  assert.equal(existsSync(cli), true);
  const env = { ...process.env, TSX_TSCONFIG_PATH: join(piRoot, "tsconfig.json") };
  // Recent Node versions can run this TypeScript entry without a loader.
  // Verify the inherited invocation actually works; bare-entry failure is not
  // part of the invocation contract.
  const loader = pathToFileURL(loaderFile).href;
  const invocation = resolvePiInvocation(
    {
      execPath: process.execPath,
      execArgv: ["--require", preflight, "--import", loader],
      argv: [process.execPath, cli],
    },
    existsSync,
  );
  const fixed = spawnSync(invocation.command, [...invocation.args, "--help"], {
    encoding: "utf8",
    cwd: here,
    env,
  });
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.match(fixed.stdout, /Usage|usage|Commands|Options/i);
});
