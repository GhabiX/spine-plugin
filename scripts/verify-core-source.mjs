import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The core source is the declared SpineCodex revision: the core directory and
// the workspace files it inherits must match that commit exactly.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = JSON.parse(readFileSync(join(root, "core-source.json"), "utf8"));
assert.equal(source.schema, "spine-core-source/v2");

// An optional checkout root verifies another SpineCodex checkout without building.
const sourceRoot = process.argv[2] === undefined
  ? resolve(root, source.developmentPath, ...source.subdirectory.split("/").map(() => ".."))
  : resolve(process.argv[2]);
if (process.argv[2] === undefined) {
  const metadata = JSON.parse(execFileSync("cargo", [
    "metadata", "--locked", "--offline", "--no-deps", "--format-version", "1",
    "--manifest-path", join(root, "Cargo.toml"),
  ], { encoding: "utf8" }));
  const binding = metadata.packages.find((pkg) => pkg.name === "spine-wasm");
  const dependency = binding.dependencies.find((dep) => dep.name === source.package);
  assert.equal(resolve(dependency.path), join(sourceRoot, source.subdirectory),
    "Cargo must use the declared core source");
}

const paths = [source.subdirectory, ...source.inherited];
const git = (...args) => execFileSync("git", ["-C", sourceRoot, ...args], { encoding: "utf8" });
const changed = git("diff", "--name-only", source.revision, "--", ...paths).trim();
assert.equal(changed, "", `core source differs from ${source.revision}`);
const extra = git("status", "--porcelain", "--untracked-files=all", "--ignored", "--", ...paths).trim();
assert.equal(extra, "", "core source has untracked or ignored files");
console.log(JSON.stringify({ source: sourceRoot, revision: source.revision, paths }));
