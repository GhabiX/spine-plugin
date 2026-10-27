import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SPINE_CONFIG_URL = new URL("../../spine.toml", import.meta.url);

/** Loads the SpineConfig every host plugin passes as configToml. Missing file is an error. */
export function loadSpineConfigToml(): string {
  return readFileSync(fileURLToPath(SPINE_CONFIG_URL), "utf8");
}
