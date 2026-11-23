// Clean-install gate. Usage: node packages/plugin/scripts/verify-release.mjs
//   /absolute/NEW/evidence-directory [1.1.0|1.5.1|all] [expected-plugin-version]
// Run once under Node 22.19+ and once under Node 25 (CI supplies the matrix).
// All snapshots, installs, tarballs and logs are retained, including on failure.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const [destination, requested, expectedPluginVersion] = process.argv.slice(2);
const hosts = ["1.1.0", "1.5.1"];
assert.ok(destination && isAbsolute(destination) && (!requested || requested === "all" || hosts.includes(requested)),
  "Usage: node packages/plugin/scripts/verify-release.mjs /absolute/NEW/directory [1.1.0|1.5.1|all] [expected-plugin-version]");
assert.ok(!resolve(destination).startsWith(resolve(repo) + sep), "Evidence must be outside the source checkout");
assert.ok([22, 25].includes(Number(process.versions.node.split(".")[0])), "Run with Node 22.19+ or 25");
if (process.versions.node.startsWith("22.")) assert.ok(Number(process.versions.node.split(".")[1]) >= 19);
await mkdir(destination); // Deliberately fail on EEXIST: never reuse stale output.
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const json = async path => JSON.parse(await readFile(path, "utf8"));
const save = async (path, value) => writeFile(path, JSON.stringify(value, null, 2) + "\n");
// Freeze the gate itself too: no live helper imports halfway through a matrix.
const gateScripts = join(destination, "gate-scripts");
await cp(fileURLToPath(new URL("./", import.meta.url)), gateScripts, { recursive: true, errorOnExist: true, force: false });
const results = [];
let firstSnapshot;
let commandIndex = 0;

// Do not inherit agent homes, session identity, provider secrets, loaders or npm
// workspace settings. In particular, never open the invoking agent's config.
function environment(root) {
  return {
    PATH: `${dirname(process.execPath)}${sep === "/" ? ":" : ";"}${process.env.PATH ?? ""}`,
    HOME: join(root, "home"), USERPROFILE: join(root, "home"),
    TMPDIR: join(root, "tmp"), TMP: join(root, "tmp"), TEMP: join(root, "tmp"),
    LANG: "en_US.UTF-8", CI: "1", NO_COLOR: "1",
    npm_config_cache: join(root, "npm-cache"), npm_config_logs_dir: join(root, "npm-logs"),
    npm_config_userconfig: join(root, "empty.npmrc"), npm_config_ignore_scripts: "true",
    npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false",
    PI_CODING_AGENT_DIR: join(root, "agent"), PI_SKIP_VERSION_CHECK: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0",
    SPINE_PACKAGE_TEST_ARTIFACT_DIR: join(root, "package-entry-artifacts"),
  };
}
function run(root, cwd, command, args) {
  const prefix = join(root, "logs", `${String(++commandIndex).padStart(3, "0")}-${command === process.execPath ? "node" : command}`);
  console.log(`\n[${cwd}] ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd, env: environment(root), encoding: "utf8",
    timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
  return (async () => {
    await writeFile(`${prefix}.stdout.log`, result.stdout ?? "");
    await writeFile(`${prefix}.stderr.log`, result.stderr ?? "");
    await save(`${prefix}.command.json`, { cwd, command, args, node: process.version, status: result.status, signal: result.signal });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${command} failed; see ${prefix}.*.log\n${result.stderr}\n${result.stdout?.slice(-6000)}`);
    return result.stdout;
  })();
}
async function hashes(root, prefix = "") {
  const rows = {};
  for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    assert.ok(!entry.isSymbolicLink(), `Unexpected symlink: ${root}/${name}`);
    if (entry.isDirectory()) Object.assign(rows, await hashes(root, name));
    else rows[name] = sha(await readFile(join(root, name)));
  }
  return rows;
}
async function pack(root, build, name) {
  const directory = join(build, "packages", name);
  const manifest = await json(join(directory, "package.json"));
  const args = ["pack", "--ignore-scripts", "--json", "--workspaces=false", "--pack-destination", join(root, "packs")];
  const dryOutput = JSON.parse(await run(root, directory, "npm", [...args, "--dry-run"]));
  const dryMetadata = Array.isArray(dryOutput) ? dryOutput[0] : dryOutput[manifest.name];
  await save(join(root, "packs", `${name}.dry-run.json`), dryMetadata);
  const output = JSON.parse(await run(root, directory, "npm", args));
  const metadata = Array.isArray(output) ? output[0] : output[manifest.name];
  for (const field of ["name", "version", "filename", "files", "entryCount", "unpackedSize"]) {
    assert.deepEqual(metadata[field], dryMetadata[field], `npm pack dry-run differs from actual pack: ${name}.${field}`);
  }
  assert.equal(metadata.name, manifest.name);
  assert.equal(metadata.version, manifest.version);
  const expected = {};
  for (const { path } of metadata.files) {
    assert.ok(!path.split("/").includes("..") && !isAbsolute(path));
    assert.ok(["package.json", "README.md", "LICENSE"].includes(path) || path.startsWith("dist/") ||
      (name === "sdk" && (path.startsWith("wasm/node/") || path === "spine.toml")), `Unexpected packed file: ${path}`);
    assert.ok(!/(^|\/)(node_modules|src|test|scripts|\.pi|\.env)(\/|$)|checkpoint|preset/i.test(path), path);
    if (name !== "sdk") assert.ok(!/\.wasm$/.test(path), path);
    expected[path] = sha(await readFile(join(directory, path)));
  }
  const files = new Set(Object.keys(expected));
  assert.ok(files.has("README.md") && files.has("LICENSE") && files.has("package.json"));
  for (const entry of Object.values(manifest.exports).flatMap(value => typeof value === "string" ? [value] : Object.values(value))) {
    assert.ok(files.has(entry.replace(/^\.\//, "")), `Missing export ${entry}`);
  }
  for (const entry of manifest.pi?.extensions ?? []) assert.ok(files.has(entry.replace(/^\.\//, "")), `Missing Pi entry ${entry}`);
  if (name === "sdk") for (const file of ["wasm/node/spine_wasm.cjs", "wasm/node/spine_wasm_bg.wasm", "spine.toml"]) assert.ok(files.has(file), file);
  if (name === "plugin") {
    assert.deepEqual(manifest.pi.extensions, ["./dist/pi/extension.js"]);
    for (const dependency of Object.keys(manifest.dependencies)) assert.ok(!dependency.startsWith("@earendil-works/") && dependency !== "typebox");
  }
  const tarball = join(root, "packs", metadata.filename);
  const listing = (await run(root, root, "tar", ["-tzf", tarball])).trim().split("\n").filter(path => !path.endsWith("/"));
  assert.deepEqual(listing.map(path => path.replace(/^package\//, "")).sort(), [...files].sort(), "Actual tarball entries must match npm pack metadata");
  await save(join(root, "packs", `${name}.json`), { ...metadata, sha256: sha(await readFile(tarball)), fileSha256: expected });
  return { manifest, tarball, expected };
}
async function assertInstalled(directory, packed) {
  const actual = await realpath(directory);
  assert.equal(actual, directory, "Installed package must not be a workspace symlink");
  assert.deepEqual(await hashes(directory), packed.expected, `Installed bytes differ: ${directory}`);
}
try {
  await save(join(destination, "gate-script-hashes.json"), await hashes(gateScripts));
  for (const host of requested && requested !== "all" ? [requested] : hosts) {
    const root = join(destination, `pi-${host}`);
    for (const directory of ["logs", "home", "tmp", "agent", "packs", "build/packages", "consumer"]) await mkdir(join(root, directory), { recursive: true });
    await writeFile(join(root, "empty.npmrc"), "ignore-scripts=true\n");
    const build = join(root, "build");
    // Pi 1.1.0 uses caret ranges internally. Pin the whole release family in
    // these disposable manifests, not just the top-level CLI/TUI versions.
    const hostPins = Object.fromEntries(["pi-coding-agent", "pi-tui", "pi-ai", "pi-agent-core", "pi-codemode", "pi-mcp", "pi-telemetry",
      ...(host === "1.1.0" ? ["chord"] : ["pi-schema"])].map(name => [`@earendil-works/${name}`, host]));
    const inventory = {};
    for (const name of ["sdk", "host", "plugin"]) {
      const target = join(build, "packages", name);
      await mkdir(target);
      for (const file of ["src", "test", "tsconfig.json", "README.md", "LICENSE", ...(name === "sdk" ? ["wasm", "spine.toml"] : [])]) {
        await cp(join(repo, "packages", name, file), join(target, file), { recursive: true, errorOnExist: true, force: false });
      }
      const manifest = await json(join(repo, "packages", name, "package.json"));
      if (name === "plugin") {
        if (expectedPluginVersion) assert.equal(manifest.version, expectedPluginVersion, "Refusing to validate the wrong release version");
        for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) manifest.devDependencies[name] = host;
      }
      await save(join(target, "package.json"), manifest);
      inventory[name] = await hashes(target);
    }
    await cp(join(repo, "fixtures"), join(build, "fixtures"), { recursive: true });
    await cp(join(repo, "tsconfig.base.json"), join(build, "tsconfig.base.json"));
    await save(join(root, "snapshot.json"), inventory);
    const comparableSnapshot = structuredClone(inventory);
    for (const name of ["sdk", "host", "plugin"]) {
      const manifest = await json(join(build, "packages", name, "package.json"));
      // Only these two deliberate host-matrix substitutions may differ.
      if (name === "plugin") for (const dependency of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
        manifest.devDependencies[dependency] = "<matrix-host>";
      }
      comparableSnapshot[name]["package.json"] = sha(JSON.stringify(manifest));
    }
    comparableSnapshot.fixtures = await hashes(join(build, "fixtures"));
    comparableSnapshot.tsconfig = sha(await readFile(join(build, "tsconfig.base.json")));
    await save(join(root, "comparable-snapshot.json"), comparableSnapshot);
    if (firstSnapshot) assert.deepEqual(comparableSnapshot, firstSnapshot, "Source/test snapshot changed during the host matrix; rerun against a stable checkout");
    firstSnapshot = comparableSnapshot;
    await save(join(build, "package.json"), { private: true, type: "module", workspaces: ["packages/*"], overrides: hostPins,
      devDependencies: { "@types/node": "22.10.2", typescript: "5.9.2", ...hostPins, typebox: "1.3.27" } });
    await run(root, build, "npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"]);
    const bindingScript = join(gateScripts, "release-bindings.mjs");
    await cp(bindingScript, join(build, "packages/plugin/release-bindings.mjs"));
    // Serial dependency order, only private build directories: no shared dist.
    for (const name of ["sdk", "host", "plugin"]) {
      await run(root, join(build, "packages", name), "npm", ["run", "check"]);
      await run(root, join(build, "packages", name), "npm", ["run", "build"]);
    }
    await run(root, build, process.execPath, [join(build, "packages/plugin/release-bindings.mjs"), host, join(root, "build-bindings.json")]);
    const packed = [];
    for (const name of ["sdk", "host", "plugin"]) packed.push(await pack(root, build, name));
    const consumer = join(root, "consumer");
    await save(join(consumer, "package.json"), { name: "pi-release-clean-consumer", private: true, type: "module", overrides: hostPins,
      dependencies: { ...hostPins, typebox: "1.3.27",
        ...Object.fromEntries(packed.map(pack => [pack.manifest.name, `file:${pack.tarball}`])) } });
    await run(root, consumer, "npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"]);
    for (const pack of packed) await assertInstalled(join(consumer, "node_modules", pack.manifest.name), pack);
    await run(root, consumer, "npm", ["ls", "--all", "--json"]);
    const installed = join(consumer, "node_modules/@spinejit/pi-spinejit");
    await cp(bindingScript, join(installed, "release-bindings.mjs"));
    await run(root, consumer, process.execPath, [join(installed, "release-bindings.mjs"), host, join(root, "consumer-bindings.json")]);
    // Run every unchanged existing Pi test against installed dist. The older
    // package-entry test assumes ../../node_modules and ../../../fixtures:
    // adapt only that private fixture layout, never link checkout dependencies.
    await cp(join(build, "packages/plugin/test"), join(installed, "test"), { recursive: true });
    await cp(join(build, "fixtures"), join(consumer, "node_modules/fixtures"), { recursive: true });
    await symlink(".", join(consumer, "node_modules/node_modules"), "dir");
    const tests = (await readdir(join(installed, "test"))).filter(name => name.endsWith(".test.mjs")).sort();
    await save(join(root, "test-inventory.json"), { files: tests, hashes: await hashes(join(installed, "test")), executedAgainst: join(installed, "dist") });
    await run(root, installed, process.execPath, ["--test", "--test-reporter=tap", ...tests.map(name => `test/${name}`)]);
    const cliScript = join(gateScripts, "release-cli.mjs");
    await run(root, consumer, process.execPath, [cliScript, root, installed]);
    // Test helpers must not mutate shipped bytes.
    for (const pack of packed) for (const [path, expected] of Object.entries(pack.expected)) {
      assert.equal(sha(await readFile(join(consumer, "node_modules", pack.manifest.name, path))), expected, path);
    }
    results.push({ host, node: process.version, status: "passed", testFiles: tests.length, root });
    await save(join(root, "result.json"), results.at(-1));
  }
  await save(join(destination, "result.json"), { status: "passed", results });
} catch (error) {
  await save(join(destination, "result.json"), { status: "failed", results, error: error.stack });
  throw error;
}
console.log(`\nPASS: retained evidence at ${destination}`);
