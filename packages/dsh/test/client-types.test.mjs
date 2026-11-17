// The client entry's types, compiled by a consumer outside this workspace.
// Only the package's declared dependencies are installed there, so a type
// import that only the workspace's dev setup satisfies fails, as it would for
// a user who installed the package.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(join(packageRoot, "package.json"));

/** Where the workspace installed a package, as npm would have installed it for a user. */
function installedDir(name) {
  for (const base of require.resolve.paths(name) ?? []) {
    const dir = join(base, name);
    if (existsSync(join(dir, "package.json"))) return dir;
  }
  throw new Error(`not installed in the workspace: ${name}`);
}

test("a consumer outside the workspace resolves the client types from the declared dependencies", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "spinejit-client-types-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pkg = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));

  // The published half: the manifest and dist, with the client bundle's types.
  const installed = join(dir, "node_modules", "@spinejit", "dsh-spinejit");
  await mkdir(installed, { recursive: true });
  await cp(join(packageRoot, "package.json"), join(installed, "package.json"));
  await cp(join(packageRoot, "dist"), join(installed, "dist"), { recursive: true });
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    const link = join(dir, "node_modules", name);
    await mkdir(dirname(link), { recursive: true });
    await symlink(installedDir(name), link, "dir");
  }

  const consumer = join(dir, "consumer.ts");
  await writeFile(consumer, [
    'import type { SpineDockProps } from "@spinejit/dsh-spinejit/client";',
    "",
    "export const props: SpineDockProps = {",
    "  useProjection: () => ({ tree: null, legacy: false }),",
    '  sessionId: "session",',
    "  setBlock: (_sessionId, _reason) => {},",
    "  newSession: () => {},",
    "};",
    "",
  ].join("\n"));

  const tsc = join(dirname(require.resolve("typescript")), "tsc.js");
  let diagnostics = null;
  try {
    await run(process.execPath, [
      tsc,
      "--noEmit",
      "--strict",
      "--module",
      "nodenext",
      "--moduleResolution",
      "nodenext",
      "--target",
      "es2022",
      consumer,
    ], { cwd: dir });
  } catch (error) {
    diagnostics = error.stdout || error.stderr || error.message;
  }
  assert.equal(diagnostics, null, `the consumer's type check failed:\n${diagnostics}`);
});
