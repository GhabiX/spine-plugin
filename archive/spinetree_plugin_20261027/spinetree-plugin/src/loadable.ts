import type { PluginManifest } from "@spinejit/spine-host";

export const SPINETREE_LOADABLE_SCHEMA = "spinetree.loadable/v1" as const;

export interface SpineTreeLoadablePlugin {
  readonly schema: typeof SPINETREE_LOADABLE_SCHEMA;
  readonly id: string;
  readonly version: string;
  readonly packageName: string;
  readonly requires: readonly string[];
  readonly capability: string;
  readonly namespace: string | null;
  readonly tools: readonly string[];
  readonly migration: string;
}

export const SPINETREE_LOADABLE_PLUGINS: readonly SpineTreeLoadablePlugin[] = [
  {
    schema: SPINETREE_LOADABLE_SCHEMA,
    id: "@spinetree/project",
    version: "0.1.0",
    packageName: "@spinetree/plugin",
    requires: ["@spinejit/spine-host"],
    capability: "spinetree.project-state",
    namespace: "spinetree",
    tools: ["read", "change", "rejuvenate"],
    migration: "Pass store to createSpineTreePlugin. read and change become real; rejuvenate also needs registry and rejuvenator.",
  },
  {
    schema: SPINETREE_LOADABLE_SCHEMA,
    id: "@spinetree/collaboration",
    version: "0.1.0",
    packageName: "@spinetree/plugin",
    requires: ["@spinetree/project"],
    capability: "spinetree.mailbox",
    namespace: "spinetree",
    tools: ["send", "observe"],
    migration: "Pass registry and mailbox to the same plugin. observe also needs mailbox.receipt. Dispatch stays caller-owned.",
  },
  {
    schema: SPINETREE_LOADABLE_SCHEMA,
    id: "@spinetree/pi-adapter",
    version: "0.1.0",
    packageName: "@spinejit/spine-host",
    requires: ["@spinetree/collaboration"],
    capability: "spinetree.pi-session",
    namespace: null,
    tools: [],
    migration: "Pass sessions to SpinePluginHost and dispatchSpineTreeMailbox. createPiSessionAdapter is the Pi session boundary.",
  },
  {
    schema: SPINETREE_LOADABLE_SCHEMA,
    id: "@spinejit/spinetree-navigation",
    version: "0.1.0",
    packageName: "@spinejit/spinetree-navigation",
    requires: ["@spinejit/pi-spinejit"],
    capability: "spinetree.navigation",
    namespace: "spine-tree",
    tools: [],
    migration: "Load the package pi.extensions entry. It does not register spinetree tools or own the canonical runtime.",
  },
];

const LOADABLE_BY_ID = new Map(SPINETREE_LOADABLE_PLUGINS.map(plugin => [plugin.id, plugin]));

export class SpineTreeLoadError extends Error {
  readonly code: "invalid-load" | "unknown-plugin" | "duplicate-plugin" | "missing-dependency";

  constructor(code: SpineTreeLoadError["code"], message: string) {
    super(message);
    this.name = "SpineTreeLoadError";
    this.code = code;
  }
}

export function selectSpineTreePlugins(ids: readonly string[]): readonly SpineTreeLoadablePlugin[] {
  if (!Array.isArray(ids)) {
    throw new SpineTreeLoadError("invalid-load", "load must be an array of plugin ids");
  }
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || !LOADABLE_BY_ID.has(id)) {
      throw new SpineTreeLoadError("unknown-plugin", `Unknown loadable plugin ${String(id)}`);
    }
    if (seen.has(id)) {
      throw new SpineTreeLoadError("duplicate-plugin", `Loadable plugin ${id} is repeated`);
    }
    seen.add(id);
  }
  const selected = SPINETREE_LOADABLE_PLUGINS.filter(plugin => seen.has(plugin.id));
  for (const plugin of selected) {
    for (const requirement of plugin.requires) {
      if (LOADABLE_BY_ID.has(requirement) && !seen.has(requirement)) {
        throw new SpineTreeLoadError("missing-dependency", `${plugin.id} requires ${requirement}`);
      }
    }
  }
  return selected;
}

export function spineTreeManifestFor(ids: readonly string[]): PluginManifest {
  const owns = selectSpineTreePlugins(ids)
    .filter(plugin => plugin.packageName === "@spinetree/plugin")
    .map(plugin => plugin.capability);
  return {
    schema: "spine-host/v1",
    id: "@spinetree/plugin",
    version: "0.1.0",
    requires: ["@spinejit/pi-spinejit"],
    owns,
    ...(owns.length === 0 ? {} : {
      toolNamespace: "spinetree",
      commandNamespace: "spinetree",
      storageNamespace: "spinetree",
    }),
  };
}

export function spineTreeToolsFor(ids: readonly string[]): readonly string[] {
  return selectSpineTreePlugins(ids)
    .filter(plugin => plugin.packageName === "@spinetree/plugin")
    .flatMap(plugin => [...plugin.tools]);
}

export function migrateSpineTreeLoad(load?: readonly string[]): readonly string[] {
  return (load === undefined
    ? SPINETREE_LOADABLE_PLUGINS.filter(plugin => plugin.packageName === "@spinetree/plugin")
    : selectSpineTreePlugins(load)).map(plugin => plugin.id);
}
