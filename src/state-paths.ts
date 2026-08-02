import { homedir, platform } from "node:os";
import { resolve } from "node:path";
import { stableHash } from "./utils.ts";

export interface StatePaths {
  root: string;
  memory: string;
  telemetry: string;
}

export function resolveStatePaths(cwd: string, projectId?: string): StatePaths {
  const base = stateBaseDirectory();
  const namespace = projectId ?? stableHash(resolve(cwd)).slice(0, 24);
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(namespace) ||
    namespace === "." ||
    namespace === ".."
  ) {
    throw new Error("projectId must be a bounded filesystem-safe identifier");
  }
  const root = resolve(base, "super-router", "projects", namespace);
  return {
    root,
    memory: resolve(root, "memory"),
    telemetry: resolve(root, "telemetry"),
  };
}

function stateBaseDirectory(): string {
  if (process.env.SUPER_ROUTER_STATE_DIR) return resolve(process.env.SUPER_ROUTER_STATE_DIR);
  if (process.env.XDG_STATE_HOME) return resolve(process.env.XDG_STATE_HOME);
  if (platform() === "darwin") return resolve(homedir(), "Library", "Application Support");
  if (platform() === "win32" && process.env.LOCALAPPDATA) {
    return resolve(process.env.LOCALAPPDATA);
  }
  return resolve(homedir(), ".local", "state");
}
