import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseRunProgress,
  detectCurrentStage,
  readLogTail,
  readLogTailText,
} from "../../src/flow/run_progress.js";

/** Verbatim excerpt from scenario 8's ibex detailed-route log. */
const ROUTE_TAIL = [
  "[INFO DRT-0194] Start detail routing.",
  "[INFO DRT-0195] Start 0th optimization iteration.",
  "    Completing 10% with 0 violations.",
  "    Completing 100% with 20 violations.",
  "[INFO DRT-0199]   Number of violations = 20.",
  "[INFO DRT-0195] Start 1st optimization iteration.",
  "    Completing 70% with 22421 violations.",
  "    Completing 80% with 19604 violations.",
  "[INFO DRT-0267] cpu time = 00:00:13, elapsed time = 00:00:04, memory = 557.72 (MB), peak = 570.05 (MB)",
].join("\n");

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-progress-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("parseRunProgress", () => {
  it("reads iteration, percent and live violation count from a real route tail", () => {
    const p = parseRunProgress(ROUTE_TAIL, "5_2_route");

    expect(p.currentStage).toBe("5_2_route");
    expect(p.iteration).toBe(1);
    expect(p.percent).toBe(80);
    expect(p.violations).toBe(19604);
  });

  it("keeps the violation total reported at the end of an iteration", () => {
    expect(parseRunProgress(ROUTE_TAIL, null).iterationViolations).toBe(20);
  });

  it("takes cpu and memory from OpenROAD's own resource line", () => {
    // pidusage on the make pid would miss this entirely: the process burning
    // the machine is a grandchild openroad.
    const p = parseRunProgress(ROUTE_TAIL, null);

    expect(p.cpuSeconds).toBe(13);
    expect(p.elapsedSeconds).toBe(4);
    expect(p.memoryMb).toBe(557.72);
    expect(p.peakMemoryMb).toBe(570.05);
  });

  it("parses hours in the resource line, not just seconds", () => {
    const p = parseRunProgress(
      "[INFO DRT-0267] cpu time = 02:15:30, elapsed time = 01:05:00, memory = 4210.5 (MB), peak = 4300.0 (MB)",
      null,
    );

    expect(p.cpuSeconds).toBe(2 * 3600 + 15 * 60 + 30);
    expect(p.elapsedSeconds).toBe(3900);
    expect(p.memoryMb).toBe(4210.5);
  });

  it("always reports the most recent value, not the first", () => {
    const p = parseRunProgress(ROUTE_TAIL, null);
    expect(p.percent).toBe(80);
    expect(p.violations).toBe(19604);
    expect(p.iteration).toBe(1);
  });

  it("returns nulls rather than guesses for a log with no progress markers", () => {
    const p = parseRunProgress("make: Entering directory '/flow'\nnothing here\n", null);

    expect(p.iteration).toBeNull();
    expect(p.percent).toBeNull();
    expect(p.violations).toBeNull();
    expect(p.cpuSeconds).toBeNull();
  });
});

describe("detectCurrentStage", () => {
  it("names the stage whose .tmp.log is newest", () => {
    fs.writeFileSync(path.join(tmpDir, "5_1_grt.log"), "done");
    fs.writeFileSync(path.join(tmpDir, "5_2_route.tmp.log"), "running");

    expect(detectCurrentStage(tmpDir)).toBe("5_2_route");
  });

  it("follows the flow as a newer stage starts", () => {
    const older = path.join(tmpDir, "5_1_grt.tmp.log");
    fs.writeFileSync(older, "x");
    fs.utimesSync(older, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    fs.writeFileSync(path.join(tmpDir, "5_2_route.tmp.log"), "y");

    expect(detectCurrentStage(tmpDir)).toBe("5_2_route");
  });

  it("ignores completed stages, whose logs are no longer .tmp", () => {
    fs.writeFileSync(path.join(tmpDir, "4_1_cts.log"), "done");
    fs.writeFileSync(path.join(tmpDir, "4_1_cts.json"), "{}");

    expect(detectCurrentStage(tmpDir)).toBeNull();
  });

  it("returns null for a directory that does not exist", () => {
    expect(detectCurrentStage(path.join(tmpDir, "nope"))).toBeNull();
  });
});

describe("readLogTail", () => {
  it("returns the last lines and reports the true total size", () => {
    const logPath = path.join(tmpDir, "run.log");
    const body = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    fs.writeFileSync(logPath, body);

    const tail = readLogTail(logPath, 10);

    expect(tail.lines).toHaveLength(10);
    expect(tail.lines[9]).toBe("line 499");
    expect(tail.totalBytes).toBe(Buffer.byteLength(body));
    expect(tail.truncated).toBe(true);
  });

  it("is not truncated when the whole log fits", () => {
    const logPath = path.join(tmpDir, "small.log");
    fs.writeFileSync(logPath, "one\ntwo\nthree");

    const tail = readLogTail(logPath, 50);

    expect(tail.lines).toEqual(["one", "two", "three"]);
    expect(tail.truncated).toBe(false);
  });

  it("drops a partial first line rather than returning a fragment", () => {
    // The tail read starts at a byte offset, which lands mid-line on any large
    // log; a half line presented as a whole one is the same class of bug as
    // silent output truncation.
    const logPath = path.join(tmpDir, "big.log");
    const line = "x".repeat(1000);
    fs.writeFileSync(logPath, Array.from({ length: 200 }, () => line).join("\n"));

    const tail = readLogTail(logPath, 5);

    expect(tail.truncated).toBe(true);
    for (const l of tail.lines) expect(l).toHaveLength(1000);
  });

  it("returns empty for a missing log instead of throwing", () => {
    const tail = readLogTail(path.join(tmpDir, "absent.log"));

    expect(tail.lines).toEqual([]);
    expect(tail.totalBytes).toBe(0);
  });

  it("feeds the progress parser end to end", () => {
    const logPath = path.join(tmpDir, "route.log");
    fs.writeFileSync(logPath, ROUTE_TAIL);

    const p = parseRunProgress(readLogTailText(logPath), null);

    expect(p.violations).toBe(19604);
    expect(p.iteration).toBe(1);
  });
});
