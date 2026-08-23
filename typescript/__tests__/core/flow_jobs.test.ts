import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../../src/config/settings.js", () => {
  const state = { runLogDir: "", maxJobs: 2, flowTimeout: 3600, flowPath: "" };
  return {
    getSettings: vi.fn(() => ({
      LOG_LEVEL: "SILENT",
      RUN_LOG_DIR: state.runLogDir,
      MAX_FLOW_JOBS: state.maxJobs,
      FLOW_RUN_TIMEOUT: state.flowTimeout,
      flowPath: state.flowPath,
    })),
    __state: state,
  };
});

import { getSettings } from "../../src/config/settings.js";
import { FlowJobRegistry, FlowJobLimitError, buildMakeArgv } from "../../src/core/flow_jobs.js";
import type { FlowJobSpec } from "../../src/core/flow_jobs.js";

let tmpDir: string;
let registry: FlowJobRegistry;

function setSettings(over: Partial<{ MAX_FLOW_JOBS: number; FLOW_RUN_TIMEOUT: number }> = {}): void {
  (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
    LOG_LEVEL: "SILENT",
    RUN_LOG_DIR: path.join(tmpDir, "runs"),
    MAX_FLOW_JOBS: over.MAX_FLOW_JOBS ?? 2,
    FLOW_RUN_TIMEOUT: over.FLOW_RUN_TIMEOUT ?? 3600,
    flowPath: tmpDir,
  });
}

function spec(over: Partial<FlowJobSpec> = {}): FlowJobSpec {
  return {
    platform: "nangate45", design: "gcd", variant: "base",
    target: "cts", overrides: {}, ...over,
  };
}

/**
 * Write an executable stub standing in for `make`.
 *
 * Real binaries are a poor stand-in: `sleep` rejects make's argv, and `false`
 * is not at the same path on every OS. A stub ignores its arguments and does
 * exactly what the test needs.
 */
function stub(name: string, body: string): string {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

/** Wait until the job leaves `running`, or fail the test. */
async function settle(reg: FlowJobRegistry, jobId: string, ms = 8000) {
  const job = await reg.waitFor(jobId, ms);
  expect(job.status).not.toBe("running");
  return job;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-jobs-test-"));
  setSettings();
});

afterEach(async () => {
  await registry?.shutdown();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("buildMakeArgv", () => {
  it("puts overrides on the command line, where they beat env and the Makefile", () => {
    const argv = buildMakeArgv(spec({ overrides: { PLACE_DENSITY_LB_ADDON: "0.25" } }));

    expect(argv).toContain("cts");
    expect(argv).toContain("DESIGN_CONFIG=./designs/nangate45/gcd/config.mk");
    expect(argv).toContain("FLOW_VARIANT=base");
    expect(argv).toContain("PLACE_DENSITY_LB_ADDON=0.25");
  });

  it("keeps each assignment a single argv entry, never a shell string", () => {
    const argv = buildMakeArgv(spec({ overrides: { CTS_BUF_LIST: "CLKBUF_X2 CLKBUF_X4" } }));

    expect(argv).toContain("CTS_BUF_LIST=CLKBUF_X2 CLKBUF_X4");
  });

  it("passes -n for a dry run and -j for parallelism", () => {
    const argv = buildMakeArgv(spec({ dryRun: true, jobs: 8 }));

    expect(argv[0]).toBe("-n");
    expect(argv).toContain("-j8");
  });
});

describe("FlowJobRegistry lifecycle", () => {
  it("records a successful run with its exit code and log on disk", async () => {
    registry = new FlowJobRegistry(stub("quick.sh", "echo cts done"));
    const job = registry.start(spec(), tmpDir);

    const done = await settle(registry, job.jobId);

    expect(done.status).toBe("succeeded");
    expect(done.exitCode).toBe(0);
    expect(fs.existsSync(done.logPath)).toBe(true);
    expect(fs.readFileSync(done.logPath, "utf8")).toContain("cts");
  });

  it("records the real exit code of a failing run", async () => {
    registry = new FlowJobRegistry(stub("fails.sh", "exit 3"));
    const job = registry.start(spec(), tmpDir);

    const done = await settle(registry, job.jobId);

    expect(done.status).toBe("failed");
    expect(done.exitCode).toBe(3);
  });

  it("writes a status file mirroring the .orfs-eval-logs convention", async () => {
    registry = new FlowJobRegistry(stub("quick.sh", "echo cts done"));
    const job = registry.start(spec(), tmpDir);
    await settle(registry, job.jobId);

    const status = fs.readFileSync(job.statusPath, "utf8");
    expect(status).toContain("RC=0");
    expect(status).toContain("STATUS=succeeded");
  });

  it("reports a spawn failure rather than hanging as running", async () => {
    registry = new FlowJobRegistry(path.join(tmpDir, "no-such-binary"));
    const job = registry.start(spec(), tmpDir);

    const done = await settle(registry, job.jobId);

    expect(done.status).toBe("failed");
    expect(done.error).toBeTruthy();
  });

  it("streams to a file, not through a bounded buffer", async () => {
    // A route log runs to tens of MB; the 128 KB session buffer would keep
    // only the tail.
    registry = new FlowJobRegistry(stub("chatty.sh", "i=0; while [ $i -lt 500 ]; do echo \"line $i\"; i=$((i+1)); done"));
    const job = registry.start(spec({ target: "route" }), tmpDir);
    await settle(registry, job.jobId);

    const bytes = fs.statSync(job.logPath).size;
    // Comfortably past what a 128 KB circular buffer would have kept of a
    // real route log, and every byte is on disk.
    expect(bytes).toBeGreaterThan(3000);
    const view = registry.inspect(job.jobId, 5);
    expect(view.logBytes).toBe(bytes);
  });

  it("returns a running job immediately when the caller does not wait", () => {
    registry = new FlowJobRegistry(stub("slow.sh", "sleep 300"));
    const job = registry.start(spec(), tmpDir);

    expect(job.status).toBe("running");
    expect(job.jobId).toHaveLength(8);
    expect(job.pid).toBeGreaterThan(0);
  });

  it("waitFor gives up after its budget rather than blocking on a long run", async () => {
    registry = new FlowJobRegistry(stub("slow.sh", "sleep 300"));
    const job = registry.start(spec(), tmpDir);

    const still = await registry.waitFor(job.jobId, 150);

    expect(still.status).toBe("running");
  });

  it("enforces the concurrency cap", () => {
    setSettings({ MAX_FLOW_JOBS: 1 });
    registry = new FlowJobRegistry(stub("slow.sh", "sleep 300"));
    registry.start(spec(), tmpDir);

    expect(() => registry.start(spec(), tmpDir)).toThrow(FlowJobLimitError);
  });

  it("counts a finished job as no longer active", async () => {
    setSettings({ MAX_FLOW_JOBS: 1 });
    registry = new FlowJobRegistry(stub("quick.sh", "echo cts done"));
    const first = registry.start(spec(), tmpDir);
    await settle(registry, first.jobId);

    expect(registry.activeCount()).toBe(0);
    expect(() => registry.start(spec(), tmpDir)).not.toThrow();
  });

  it("times out a run that overruns its budget", async () => {
    setSettings({ FLOW_RUN_TIMEOUT: 3600 });
    registry = new FlowJobRegistry(stub("slow.sh", "sleep 300"));
    const job = registry.start(spec({ timeoutSeconds: 1 }), tmpDir);

    const done = await settle(registry, job.jobId, 10000);

    expect(done.status).toBe("timed_out");
    expect(done.error).toMatch(/exceeded 1s/);
  });
});

describe("FlowJobRegistry teardown", () => {
  it("kills the whole process group, leaving no orphaned grandchild", async () => {
    // The orphan case scenario 10 found on this host: killing only `make`
    // strands the openroad it spawned. The run must go down as a group.
    const marker = path.join(tmpDir, "grandchild.pid");
    const script = path.join(tmpDir, "spawner.sh");
    fs.writeFileSync(
      script,
      `#!/bin/sh\nsleep 300 &\necho $! > ${marker}\nwait\n`,
    );
    fs.chmodSync(script, 0o755);

    registry = new FlowJobRegistry(script);
    const job = registry.start(spec(), tmpDir);

    // Wait for the grandchild to exist.
    for (let i = 0; i < 100 && !fs.existsSync(marker); i += 1) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const grandchildPid = Number(fs.readFileSync(marker, "utf8").trim());
    expect(grandchildPid).toBeGreaterThan(0);
    expect(() => process.kill(grandchildPid, 0)).not.toThrow();

    registry.cancel(job.jobId);
    await settle(registry, job.jobId, 10000);

    // Give the signal a moment to land on the group.
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(grandchildPid, 0)).toThrow();
  });

  it("marks a cancelled run cancelled, not failed", async () => {
    registry = new FlowJobRegistry(stub("slow.sh", "sleep 300"));
    const job = registry.start(spec(), tmpDir);

    registry.cancel(job.jobId);
    const done = await settle(registry, job.jobId, 10000);

    expect(done.status).toBe("cancelled");
  });

  it("cancelling a finished job is a no-op", async () => {
    registry = new FlowJobRegistry(stub("quick.sh", "echo cts done"));
    const job = registry.start(spec(), tmpDir);
    await settle(registry, job.jobId);

    expect(registry.cancel(job.jobId).status).toBe("succeeded");
  });

  it("shutdown terminates every running job", async () => {
    registry = new FlowJobRegistry(stub("slow.sh", "sleep 300"));
    const job = registry.start(spec(), tmpDir);

    await registry.shutdown();
    const done = await settle(registry, job.jobId, 10000);

    expect(done.status).toBe("cancelled");
  });
});

describe("FlowJobRegistry.inspect", () => {
  it("surfaces progress parsed from the streaming log", async () => {
    registry = new FlowJobRegistry(stub("quick.sh", "echo cts done"));
    const job = registry.start(spec({ target: "route" }), tmpDir);
    await settle(registry, job.jobId);

    fs.appendFileSync(
      job.logPath,
      [
        "[INFO DRT-0195] Start 1st optimization iteration.",
        "    Completing 80% with 19604 violations.",
        "[INFO DRT-0267] cpu time = 00:30:00, elapsed time = 00:10:00, memory = 4210.5 (MB), peak = 4300.0 (MB)",
      ].join("\n"),
    );
    fs.mkdirSync(job.logsDir, { recursive: true });
    fs.writeFileSync(path.join(job.logsDir, "5_2_route.tmp.log"), "x");

    const view = registry.inspect(job.jobId, 10);

    expect(view.progress.currentStage).toBe("5_2_route");
    expect(view.progress.iteration).toBe(1);
    expect(view.progress.violations).toBe(19604);
    expect(view.progress.cpuSeconds).toBe(1800);
    expect(view.progress.memoryMb).toBe(4210.5);
  });

  it("reports elapsed time and stops the clock when the job finishes", async () => {
    registry = new FlowJobRegistry(stub("quick.sh", "echo cts done"));
    const job = registry.start(spec(), tmpDir);
    await settle(registry, job.jobId);

    const first = registry.inspect(job.jobId).elapsedSeconds;
    await new Promise((r) => setTimeout(r, 120));
    expect(registry.inspect(job.jobId).elapsedSeconds).toBe(first);
  });
});
