// Bundle the browser half into dist/client.js and its source map, over tsc's
// unbundled output: CommonJS inside the web client's module-loader wrapper,
// with React's JSX runtime taken from the host.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
await build({
  entryPoints: [fileURLToPath(new URL("../src/client.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("../dist/client.js", import.meta.url)),
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  external: ["react", "react/jsx-runtime"],
  sourcemap: "linked",
  banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => {\nvar module = { exports: {} };\nvar exports = module.exports;` },
  footer: { js: "return module.exports;\n} });" },
});
