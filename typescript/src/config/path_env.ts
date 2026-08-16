import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LOGIN_SHELL_TIMEOUT_MS = 2500;
const LOGIN_SHELL_PATH_MARKER = "__OPENROAD_MCP_PATH__=";

export type PathEnvDeps = {
  env: NodeJS.ProcessEnv;
  isExecutable: (filePath: string) => boolean;
  dirExists: (dirPath: string) => boolean;
  extraBinDirs: () => string[];
  extraOrfsDirs: () => string[];
  readLoginShellPath: () => string | undefined;
};

export function isExecutableFile(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function dirExists(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

export function defaultExtraBinDirs(home: string, platform: NodeJS.Platform): string[] {
  const dirs = [
    path.join(home, ".local", "bin"),
    path.join(home, "OpenROAD", "build", "src"),
    path.join(home, "OpenROAD-flow-scripts", "tools", "install", "OpenROAD", "bin"),
    path.join(home, "miniconda3", "bin"),
    path.join(home, "anaconda3", "bin"),
    path.join(home, "miniforge3", "bin"),
    path.join(home, "mambaforge", "bin"),
    "/opt/conda/bin",
  ];
  if (platform === "darwin") {
    dirs.unshift("/opt/homebrew/bin", "/usr/local/bin");
  } else if (platform !== "win32") {
    dirs.unshift("/usr/local/bin");
  }
  return dirs;
}

export function defaultOrfsFlowCandidates(home: string): string[] {
  return [
    path.join(home, "OpenROAD-flow-scripts", "flow"),
    path.join(home, "src", "OpenROAD-flow-scripts", "flow"),
    path.join(home, "tools", "OpenROAD-flow-scripts", "flow"),
  ];
}

export function mergePathDirs(...groups: Array<string | string[] | undefined>): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const group of groups) {
    if (group === undefined) continue;
    const dirs = Array.isArray(group) ? group : group.split(path.delimiter);
    for (const dir of dirs) {
      const trimmed = dir.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out.join(path.delimiter);
}

export function findExecutable(
  name: string,
  pathEnv: string,
  isExecutable: (filePath: string) => boolean = isExecutableFile,
): string | undefined {
  for (const dir of pathEnv.split(path.delimiter)) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    const candidate = path.join(trimmed, name);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

export function parseLoginShellPath(stdout: string, marker = LOGIN_SHELL_PATH_MARKER): string | undefined {
  const idx = stdout.lastIndexOf(marker);
  if (idx === -1) return undefined;
  const rest = stdout.slice(idx + marker.length);
  const end = rest.search(/[\r\n]/);
  const value = (end === -1 ? rest : rest.slice(0, end)).trim();
  return value.length > 0 ? value : undefined;
}

export function readLoginShellPath(): string | undefined {
  if (process.platform === "win32") return undefined;
  const shell = process.env["SHELL"] || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  try {
    const result = spawnSync(shell, ["-lc", `printf '%s' '${LOGIN_SHELL_PATH_MARKER}'"$PATH"`], {
      encoding: "utf8",
      timeout: LOGIN_SHELL_TIMEOUT_MS,
      env: { ...process.env, TERM: "dumb", SHELL: shell },
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!result.stdout) return undefined;
    return parseLoginShellPath(result.stdout);
  } catch {
    return undefined;
  }
}

function orfsNearOpenroad(
  openroadBin: string,
  dirExistsFn: (dirPath: string) => boolean,
): string | undefined {
  let dir = path.dirname(openroadBin);
  for (let i = 0; i < 8; i++) {
    const flow = path.join(dir, "flow");
    if (dirExistsFn(path.join(flow, "designs")) && dirExistsFn(path.join(flow, "platforms"))) {
      return flow;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function looksLikeOrfsFlow(flowPath: string, dirExistsFn: (dirPath: string) => boolean): boolean {
  return dirExistsFn(path.join(flowPath, "designs")) && dirExistsFn(path.join(flowPath, "platforms"));
}

export function defaultPathEnvDeps(env: NodeJS.ProcessEnv = process.env): PathEnvDeps {
  const homedir = (): string => os.homedir();
  const platform = process.platform;
  return {
    env,
    isExecutable: isExecutableFile,
    dirExists,
    extraBinDirs: () => defaultExtraBinDirs(homedir(), platform),
    extraOrfsDirs: () => defaultOrfsFlowCandidates(homedir()),
    readLoginShellPath,
  };
}

export function enrichInheritedEnv(deps: PathEnvDeps): {
  path: string;
  openroad: string | undefined;
  orfsFlowPath: string | undefined;
} {
  const currentPath = deps.env["PATH"] ?? "";
  let openroad = findExecutable("openroad", currentPath, deps.isExecutable);
  let nextPath = currentPath;

  if (!openroad) {
    nextPath = mergePathDirs(deps.readLoginShellPath(), currentPath, deps.extraBinDirs());
    openroad = findExecutable("openroad", nextPath, deps.isExecutable);
    if (openroad) {
      nextPath = mergePathDirs([path.dirname(openroad)], nextPath);
    }
    deps.env["PATH"] = nextPath;
  }

  const existingOrfs = deps.env["ORFS_FLOW_PATH"]?.trim();
  let orfsFlowPath = existingOrfs && existingOrfs.length > 0 ? existingOrfs : undefined;
  if (!orfsFlowPath) {
    const near = openroad ? orfsNearOpenroad(openroad, deps.dirExists) : undefined;
    const found = near ?? deps.extraOrfsDirs().find((p) => looksLikeOrfsFlow(p, deps.dirExists));
    if (found) {
      orfsFlowPath = found;
      deps.env["ORFS_FLOW_PATH"] = found;
    }
  }

  return { path: deps.env["PATH"] ?? nextPath, openroad, orfsFlowPath };
}

export function applyInheritedEnv(env: NodeJS.ProcessEnv = process.env): void {
  enrichInheritedEnv(defaultPathEnvDeps(env));
}
