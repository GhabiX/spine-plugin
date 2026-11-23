// Install and test source snapshots against real, peer-aligned DSH releases.
// A fresh explicit destination is required; nothing is deleted or reused.
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const source = fileURLToPath(new URL("../", import.meta.url));
const [destination, requested] = process.argv.slice(2);
const hosts = ["0.2.1-rc.2", "0.2.2-rc.5"];
if (!destination || !isAbsolute(destination) || (requested && !hosts.includes(requested))) {
  throw new Error("Usage: node scripts/test-host-matrix.mjs /absolute/fresh/directory [0.2.1-rc.2|0.2.2-rc.5]");
}
await mkdir(destination); // EEXIST deliberately prevents stale evidence.
for (const host of requested ? [requested] : hosts) {
  const root = join(destination, host);
  const pkg = join(root, "packages", "dsh");
  await mkdir(pkg, { recursive: true });
  for (const name of ["src", "test", "scripts", "tsconfig.json", "README.md", "LICENSE", "cordis.patch.yml", "screenshots.json"]) {
    await cp(join(source, name), join(pkg, name), { recursive: true });
  }
  await cp(resolve(source, "../../tsconfig.base.json"), join(root, "tsconfig.base.json"));
  const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  for (const name of Object.keys(manifest.devDependencies)) {
    if (name.startsWith("@deepseek-ai/dsh-")) manifest.devDependencies[name] = host;
  }
  manifest.devDependencies["@deepseek-ai/cordis"] = host === hosts[0] ? "~4.0.5" : "~4.1.0";
  manifest.devDependencies["@deepseek-ai/cordis-plugin-loader"] = host === hosts[0] ? "~1.0.6" : "~1.1.0";
  // These are normally supplied by the workspace root.
  manifest.devDependencies["@types/node"] = "22.10.2";
  manifest.devDependencies.typescript = "5.9.2";
  await writeFile(join(pkg, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`\n=== DSH ${host}, ${process.version}: ${pkg} ===`);
  for (const args of [["install", "--no-audit", "--no-fund"], ["run", "check"], ["run", "build"], ["test"]]) {
    const run = spawnSync("npm", args, { cwd: pkg, env: process.env, stdio: "inherit" });
    if (run.error) throw run.error;
    if (run.status !== 0) process.exit(run.status ?? 1);
    if (args[0] === "install") {
      for (const name of Object.keys(manifest.devDependencies).filter((name) => name.startsWith("@deepseek-ai/dsh-"))) {
        const actual = JSON.parse(await readFile(join(pkg, "node_modules", name, "package.json"), "utf8"));
        if (actual.version !== host) throw new Error(`${name}: expected ${host}, got ${actual.version}`);
      }
    }
  }
}
