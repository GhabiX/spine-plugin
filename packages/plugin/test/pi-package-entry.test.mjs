import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { loadSpineConfigToml } from "@spinejit/spine-sdk/host";
import { createNodeSpineRuntime } from "@spinejit/spine-sdk/node";

const execFileAsync = promisify(execFile);
const packageDir = fileURLToPath(new URL("../", import.meta.url));
const workspaceDir = resolve(packageDir, "../..");

test("packed Pi manifest loads the same complete tool catalog as the local package", async () => {
  const minute = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13).replace("T", "_");
  const artifactRoot = process.env.SPINE_PACKAGE_TEST_ARTIFACT_DIR
    ?? join(workspaceDir, "temp/null", minute, "pi-package-entry");
  await mkdir(artifactRoot, { recursive: true });
  const artifacts = await mkdtemp(join(artifactRoot, "run-"));
  const { stdout, stderr } = await execFileAsync("npm", [
    "pack", "--dry-run", "--ignore-scripts", "--offline", "--json", "--workspaces=false",
    "--cache", join(artifacts, "npm-cache"),
    "--logs-dir", join(artifacts, "npm-logs"),
  ], { cwd: packageDir, maxBuffer: 4 * 1024 * 1024 });
  await writeFile(join(artifacts, "pack.json"), stdout);
  await writeFile(join(artifacts, "pack.stderr"), stderr);
  const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
  // npm 10 prints an array of packs; npm 12 keys them by package name.
  const packed = JSON.parse(stdout);
  const pack = Array.isArray(packed) ? packed[0] : packed[manifest.name];
  const files = new Set(pack.files.map(({ path }) => path));
  assert.ok(manifest.pi.extensions.length > 0);
  for (const entry of manifest.pi.extensions) {
    assert.ok(files.has(entry.replace(/^\.\//, "")), `Pi entry absent from npm pack: ${entry}`);
  }

  // Copy the actual packlist. Dependencies remain external, just as declared by
  // package.json; link the already installed workspace dependencies explicitly.
  const packedDir = join(artifacts, "package");
  for (const { path } of pack.files) {
    const destination = join(packedDir, path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(packageDir, path), destination);
  }
  await symlink(relative(packedDir, join(workspaceDir, "node_modules")), join(packedDir, "node_modules"), "dir");
  const cwd = join(artifacts, "workspace");
  const agentDir = join(artifacts, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  const configToml = loadSpineConfigToml();
  const runtime = createNodeSpineRuntime({ thread: "package-entry-test", features: ["jit", "spawn"], configToml });
  try {
    const expected = runtime.toolCatalog().map(({ id, description, parameters }) => ({
      name: `spine_${id}`, description, parameters,
    }));
    for (const source of [packageDir, packedDir]) {
      const loaded = await discoverAndLoadExtensions([source], cwd, agentDir);
      assert.deepEqual(loaded.errors, []);
      assert.equal(loaded.extensions.length, manifest.pi.extensions.length);
      const definitions = loaded.extensions.flatMap((extension) => [...extension.tools.values()]
        .map(({ definition: { name, description, parameters } }) => ({ name, description, parameters })));
      // TypeBox's private symbols are not part of the model-facing JSON schema.
      assert.deepEqual(JSON.parse(JSON.stringify(definitions)), expected);
    }
  } finally {
    runtime.dispose();
  }
});
