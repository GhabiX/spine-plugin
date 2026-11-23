// Copied next to the snapshot/installed package.json, so ESM resolution has
// exactly the same ancestry as the code and unchanged tests being validated.
import assert from "node:assert/strict";
import { readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const [host, output] = process.argv.slice(2);
const root = dirname(output);
const bindings = {};
for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "@earendil-works/pi-tui", "typebox", "@spinejit/spine-sdk", "@spinejit/spine-host", "@spinejit/pi-spinejit"]) {
  const specifier = name === "@spinejit/pi-spinejit" ? `${name}/pi/extension` : name;
  const entry = await realpath(fileURLToPath(import.meta.resolve(specifier)));
  assert.ok(entry.startsWith(root + sep), `Dependency escaped private install: ${name}: ${entry}`);
  let directory = dirname(entry);
  let manifest;
  while (true) {
    try {
      const candidate = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      if (candidate.name === name) { manifest = candidate; break; }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const parent = dirname(directory);
    assert.notEqual(parent, directory, `Cannot locate manifest for ${name}`);
    directory = parent;
  }
  if (name.startsWith("@earendil-works/")) assert.equal(manifest.version, host, `${name} must match the actual host`);
  bindings[name] = { version: manifest.version, entry, directory };
}
const familyDirectory = dirname(bindings["@earendil-works/pi-coding-agent"].directory);
const family = {};
for (const name of await readdir(familyDirectory)) {
  if (!name.startsWith("pi-") && name !== "chord") continue;
  const manifest = JSON.parse(await readFile(join(familyDirectory, name, "package.json"), "utf8"));
  assert.equal(manifest.version, host, `Mixed release family: ${manifest.name}`);
  family[manifest.name] = manifest.version;
}
const agent = await import("@earendil-works/pi-coding-agent");
for (const name of ["SessionManager", "discoverAndLoadExtensions", "convertToLlm"]) assert.equal(typeof agent[name], "function", name);
await writeFile(output, JSON.stringify({ node: process.version, bindings, family }, null, 2) + "\n");
console.log(JSON.stringify(bindings, null, 2));
