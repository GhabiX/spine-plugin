// Builds the browser half (client/) the way the web client loads it: one
// CommonJS file in the module-loader wrapper, with React and the shell's atom
// library taken from the shell. tsc still builds the host half into the same
// dist.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
) as { name: string };

export default defineConfig({
  build: {
    outDir: "dist",
    // dist also holds tsc's host output; only the client bundle is replaced.
    emptyOutDir: false,
    target: "es2022",
    sourcemap: true,
    // The web client runs this file as loaded; keep it readable in its devtools.
    minify: false,
    lib: {
      entry: fileURLToPath(new URL("./client/client.ts", import.meta.url)),
      formats: ["cjs"],
      fileName: () => "client.js",
    },
    rollupOptions: {
      external: ["react", "react/jsx-runtime", "@deepseek-ai/dsh-client-ui-primitives"],
      output: {
        banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => {\nvar module = { exports: {} };\nvar exports = module.exports;`,
        footer: "return module.exports;\n} });",
      },
    },
  },
});
