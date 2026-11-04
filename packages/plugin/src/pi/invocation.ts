import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";

export interface ProcessImage {
  execPath: string;
  execArgv: readonly string[];
  argv: readonly string[];
}

export interface PiInvocation {
  command: string;
  args: string[];
}

/**
 * Reconstruct the running Node/Bun image so a Spawn child can load TypeScript
 * the same way the parent did. Copy execArgv (tsx loaders, strip-types, ...);
 * drop only inspector flags so a debug parent does not bind the same port.
 * The parent's choice of what loads (extensions, MCP, project trust) goes
 * along, so the child loads the same set rather than rediscovering it.
 */
export function resolvePiInvocation(
  image: ProcessImage,
  exists: (path: string) => boolean = existsSync,
): PiInvocation {
  const selection = loadFlags(image.argv);
  const cliIndex = findPiCliIndex(image.argv, exists);
  if (cliIndex >= 1) {
    return {
      command: image.execPath,
      args: [...childExecArgv(image.execArgv), ...image.argv.slice(1, cliIndex + 1), ...selection],
    };
  }
  const script = image.argv[1];
  if (script !== undefined && !script.startsWith("/$bunfs/root/") && exists(script)) {
    return {
      command: image.execPath,
      args: [...childExecArgv(image.execArgv), script, ...selection],
    };
  }
  const executable = basename(image.execPath).toLowerCase();
  return /^(node|bun)(\.exe)?$/.test(executable)
    ? { command: "pi", args: selection }
    : { command: image.execPath, args: selection };
}

/**
 * Pi's flags that choose what loads (cli/args.ts spellings; `--` ends options).
 * Pi resolves a relative -e against the directory it started in, while the child
 * starts in the session's cwd, so a relative path goes as resolved here.
 */
function loadFlags(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < argv.length && argv[i] !== "--"; i += 1) {
    const arg = argv[i]!;
    if (arg === "--no-extensions" || arg === "-ne") {
      out.push("--no-extensions");
    } else if (arg === "--no-mcp") {
      out.push("--no-mcp");
    } else if (arg === "--approve" || arg === "-a") {
      out.push("--approve");
    } else if (arg === "--no-approve" || arg === "-na") {
      out.push("--no-approve");
    } else if ((arg === "--extension" || arg === "-e") && i + 1 < argv.length) {
      const path = argv[++i]!;
      // A source with a scheme (npm:, builtin:, file:), ~ or an absolute path means the same in any cwd.
      out.push("--extension", /^(?:[a-z][a-z0-9+.-]*:|~|\/)/i.test(path) ? path : resolve(path));
    }
  }
  return out;
}

function findPiCliIndex(argv: readonly string[], exists: (path: string) => boolean): number {
  for (let i = argv.length - 1; i >= 1; i -= 1) {
    const arg = argv[i]!;
    if (arg.startsWith("-") || arg.startsWith("/$bunfs/root/")) {
      continue;
    }
    const name = basename(arg);
    if ((name === "cli.ts" || name === "cli.js") && exists(arg)) {
      return i;
    }
  }
  return -1;
}

function childExecArgv(execArgv: readonly string[]): string[] {
  const args: string[] = [];
  for (let i = 0; i < execArgv.length; i += 1) {
    const arg = execArgv[i]!;
    if (!isInspectorFlag(arg)) {
      args.push(arg);
      continue;
    }
    if (inspectorTakesSeparateValue(arg)) {
      const next = execArgv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        i += 1;
      }
    }
  }
  return args;
}

function isInspectorFlag(arg: string): boolean {
  return /^(?:--inspect(?:-brk|-port)?|--debug(?:-brk)?)(?:=.*)?$/.test(arg);
}

function inspectorTakesSeparateValue(arg: string): boolean {
  return arg === "--inspect-port";
}
