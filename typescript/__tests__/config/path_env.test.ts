import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  mergePathDirs,
  findExecutable,
  parseLoginShellPath,
  enrichInheritedEnv,
  defaultExtraBinDirs,
  defaultOrfsFlowCandidates,
  type PathEnvDeps,
} from "../../src/config/path_env.js";

function makeExecutable(dir: string, name: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, "#!/bin/sh\n");
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

function makeOrfsFlow(root: string): string {
  const flow = path.join(root, "flow");
  fs.mkdirSync(path.join(flow, "designs"), { recursive: true });
  fs.mkdirSync(path.join(flow, "platforms"), { recursive: true });
  return flow;
}

describe("path_env", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openroad-path-env-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("mergePathDirs", () => {
    it("deduplicates and skips empty segments while preserving first-seen order", () => {
      expect(mergePathDirs(
        ["/a", "/b"].join(path.delimiter),
        ["/b", "/c"],
        "",
        `  ${path.delimiter}/a`,
      )).toBe(["/a", "/b", "/c"].join(path.delimiter));
    });
  });

  describe("findExecutable", () => {
    it("returns the first executable named on PATH", () => {
      const bin = path.join(tmpDir, "bin");
      const openroad = makeExecutable(bin, "openroad");
      expect(findExecutable("openroad", ["/usr/bin", bin].join(path.delimiter))).toBe(openroad);
    });

    it("returns undefined when the binary is missing", () => {
      expect(findExecutable("openroad", "/usr/bin")).toBeUndefined();
    });
  });

  describe("parseLoginShellPath", () => {
    it("reads the marker even when the shell printed a banner first", () => {
      expect(parseLoginShellPath("Welcome!\n__OPENROAD_MCP_PATH__=/opt/homebrew/bin:/usr/bin\n")).toBe(
        "/opt/homebrew/bin:/usr/bin",
      );
    });

    it("returns undefined when the marker is absent", () => {
      expect(parseLoginShellPath("/opt/homebrew/bin")).toBeUndefined();
    });
  });

  describe("default location lists", () => {
    it("puts Homebrew first on macOS", () => {
      expect(defaultExtraBinDirs("/Users/me", "darwin")[0]).toBe("/opt/homebrew/bin");
    });

    it("includes the default ORFS checkout", () => {
      expect(defaultOrfsFlowCandidates("/home/me")[0]).toBe(
        path.join("/home/me", "OpenROAD-flow-scripts", "flow"),
      );
    });
  });

  describe("enrichInheritedEnv", () => {
    function deps(overrides: Partial<PathEnvDeps> & { env: NodeJS.ProcessEnv }): PathEnvDeps {
      return {
        isExecutable: (p) => {
          try {
            fs.accessSync(p, fs.constants.X_OK);
            return fs.statSync(p).isFile();
          } catch {
            return false;
          }
        },
        dirExists: (p) => {
          try {
            return fs.statSync(p).isDirectory();
          } catch {
            return false;
          }
        },
        extraBinDirs: () => [],
        extraOrfsDirs: () => [],
        readLoginShellPath: () => undefined,
        ...overrides,
      };
    }

    it("leaves PATH unchanged when openroad is already on it", () => {
      const bin = path.join(tmpDir, "already");
      makeExecutable(bin, "openroad");
      const current = [bin, "/usr/bin"].join(path.delimiter);
      const env: NodeJS.ProcessEnv = { PATH: current };
      let loginCalled = false;
      const result = enrichInheritedEnv(
        deps({
          env,
          extraBinDirs: () => ["/opt/homebrew/bin"],
          readLoginShellPath: () => {
            loginCalled = true;
            return "/opt/homebrew/bin";
          },
        }),
      );
      expect(env.PATH).toBe(current);
      expect(result.openroad).toBe(path.join(bin, "openroad"));
      expect(loginCalled).toBe(false);
    });

    it("prepends the login-shell directory that contains openroad", () => {
      const loginBin = path.join(tmpDir, "login-bin");
      makeExecutable(loginBin, "openroad");
      const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
      const result = enrichInheritedEnv(
        deps({
          env,
          readLoginShellPath: () => [loginBin, "/usr/bin"].join(path.delimiter),
        }),
      );
      expect(result.openroad).toBe(path.join(loginBin, "openroad"));
      expect(env.PATH?.split(path.delimiter)[0]).toBe(loginBin);
    });

    it("finds openroad in extra bin dirs used by Homebrew/conda/local builds", () => {
      const brewBin = path.join(tmpDir, "homebrew");
      makeExecutable(brewBin, "openroad");
      const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
      const result = enrichInheritedEnv(deps({ env, extraBinDirs: () => [brewBin] }));
      expect(result.openroad).toBe(path.join(brewBin, "openroad"));
      expect(env.PATH?.split(path.delimiter)[0]).toBe(brewBin);
    });

    it("does not overwrite an explicit ORFS_FLOW_PATH", () => {
      const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", ORFS_FLOW_PATH: "/custom/flow" };
      const flow = makeOrfsFlow(path.join(tmpDir, "OpenROAD-flow-scripts"));
      const result = enrichInheritedEnv(deps({ env, extraOrfsDirs: () => [flow] }));
      expect(result.orfsFlowPath).toBe("/custom/flow");
      expect(env.ORFS_FLOW_PATH).toBe("/custom/flow");
    });

    it("sets ORFS_FLOW_PATH when a candidate flow tree exists", () => {
      const flow = makeOrfsFlow(path.join(tmpDir, "OpenROAD-flow-scripts"));
      const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
      const result = enrichInheritedEnv(deps({ env, extraOrfsDirs: () => [flow] }));
      expect(result.orfsFlowPath).toBe(flow);
      expect(env.ORFS_FLOW_PATH).toBe(flow);
    });

    it("detects ORFS next to a local openroad install", () => {
      const root = path.join(tmpDir, "OpenROAD-flow-scripts");
      const flow = makeOrfsFlow(root);
      const bin = path.join(root, "tools", "install", "OpenROAD", "bin");
      makeExecutable(bin, "openroad");
      const env: NodeJS.ProcessEnv = { PATH: bin };
      const result = enrichInheritedEnv(deps({ env, extraOrfsDirs: () => [] }));
      expect(result.orfsFlowPath).toBe(flow);
      expect(env.ORFS_FLOW_PATH).toBe(flow);
    });
  });
});
