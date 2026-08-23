import fs from "node:fs";
import path from "node:path";

/**
 * How much of the tail of a run log is read on each poll. A route log runs to
 * tens of MB and is polled repeatedly, so the whole file is never read.
 */
export const LOG_TAIL_BYTES = 64 * 1024;

/** Default number of trailing log lines returned to a caller. */
export const DEFAULT_RECENT_LINES = 50;

// Progress markers, verified against the real ibex route log from scenario 8.
const ITERATION_LINE = /Start (\d+)(?:st|nd|rd|th) optimization iteration/g;
const COMPLETING_LINE = /Completing (\d+)% with (\d+) violations/g;
const VIOLATION_TOTAL_LINE = /Number of violations = (\d+)/g;
// [INFO DRT-0267] cpu time = 00:00:13, elapsed time = 00:00:04, memory = 557.72 (MB), peak = 570.05 (MB)
const RESOURCE_LINE =
  /cpu time = (\d+):(\d+):(\d+), elapsed time = (\d+):(\d+):(\d+), memory = ([\d.]+) \(MB\), peak = ([\d.]+) \(MB\)/g;

/** Last capture of a global regex, or null when it never matched. */
function lastMatch(text: string, re: RegExp): RegExpMatchArray | null {
  re.lastIndex = 0;
  let last: RegExpMatchArray | null = null;
  for (;;) {
    const m = re.exec(text);
    if (m === null) return last;
    last = m;
  }
}

function toSeconds(h: string, m: string, s: string): number {
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

export interface RunProgress {
  /** ORFS stage currently executing, from the newest *.tmp.log. */
  currentStage: string | null;
  /** Detailed-route optimization iteration, when routing. */
  iteration: number | null;
  /** Percent through the current iteration. */
  percent: number | null;
  /** Live DRC violation count from the most recent progress line. */
  violations: number | null;
  /** Violation total reported at the end of an iteration. */
  iterationViolations: number | null;
  cpuSeconds: number | null;
  elapsedSeconds: number | null;
  memoryMb: number | null;
  peakMemoryMb: number | null;
}

/**
 * Derive structured progress from a run log tail.
 *
 * Scenario 8 backgrounded `make route` and was, in its own words, "reduced to
 * tail/grep-ing a raw log and ps/stat-ing files". These are the same signals it
 * was grepping for by hand, parsed once and served properly.
 *
 * CPU and memory come from OpenROAD's own DRT-0267 line rather than from
 * `pidusage` on the make pid: pidusage does not aggregate children, and the
 * process actually consuming the machine is a grandchild `openroad`.
 */
export function parseRunProgress(tail: string, currentStage: string | null): RunProgress {
  const iterationMatch = lastMatch(tail, ITERATION_LINE);
  const completingMatch = lastMatch(tail, COMPLETING_LINE);
  const violationMatch = lastMatch(tail, VIOLATION_TOTAL_LINE);
  const resourceMatch = lastMatch(tail, RESOURCE_LINE);

  return {
    currentStage,
    iteration: iterationMatch ? Number(iterationMatch[1]) : null,
    percent: completingMatch ? Number(completingMatch[1]) : null,
    violations: completingMatch ? Number(completingMatch[2]) : null,
    iterationViolations: violationMatch ? Number(violationMatch[1]) : null,
    cpuSeconds: resourceMatch
      ? toSeconds(resourceMatch[1]!, resourceMatch[2]!, resourceMatch[3]!)
      : null,
    elapsedSeconds: resourceMatch
      ? toSeconds(resourceMatch[4]!, resourceMatch[5]!, resourceMatch[6]!)
      : null,
    memoryMb: resourceMatch ? Number(resourceMatch[7]) : null,
    peakMemoryMb: resourceMatch ? Number(resourceMatch[8]) : null,
  };
}

/**
 * The stage ORFS is running right now.
 *
 * ORFS writes each stage through `run_command.py --log .../<stem>.tmp.log
 * --append --tee`, renaming it to `<stem>.log` once the stage succeeds. So the
 * newest `.tmp.log` names the stage in flight. Reading that rather than
 * parsing make's echoed recipe keeps this working across ORFS releases that
 * renumber their stages.
 */
export function detectCurrentStage(logsDir: string): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(logsDir);
  } catch {
    return null;
  }

  let newest: { stem: string; mtimeMs: number } | null = null;
  for (const entry of entries) {
    if (!entry.endsWith(".tmp.log")) continue;
    const stem = entry.slice(0, -".tmp.log".length);
    try {
      const { mtimeMs } = fs.statSync(path.join(logsDir, entry));
      if (newest === null || mtimeMs > newest.mtimeMs) newest = { stem, mtimeMs };
    } catch {
      /* raced with the rename to .log; skip it */
    }
  }
  return newest?.stem ?? null;
}

export interface LogTail {
  lines: string[];
  /** Total bytes in the log, not just the portion read. */
  totalBytes: number;
  /** True when the log holds more than the lines returned. */
  truncated: boolean;
}

/** Read the last `maxLines` lines of a log without loading the whole file. */
export function readLogTail(logPath: string, maxLines = DEFAULT_RECENT_LINES): LogTail {
  let fd: number;
  let totalBytes: number;
  try {
    totalBytes = fs.statSync(logPath).size;
    fd = fs.openSync(logPath, "r");
  } catch {
    return { lines: [], totalBytes: 0, truncated: false };
  }

  try {
    const readBytes = Math.min(totalBytes, LOG_TAIL_BYTES);
    const buffer = Buffer.allocUnsafe(readBytes);
    fs.readSync(fd, buffer, 0, readBytes, totalBytes - readBytes);
    const text = buffer.toString("utf8");
    // A partial read almost certainly starts mid-line; drop that fragment
    // rather than presenting a truncated line as a whole one.
    const all = text.split(/\r?\n/);
    if (readBytes < totalBytes && all.length > 0) all.shift();
    while (all.length > 0 && all[all.length - 1] === "") all.pop();

    const lines = all.slice(-maxLines);
    return {
      lines,
      totalBytes,
      truncated: readBytes < totalBytes || all.length > lines.length,
    };
  } finally {
    fs.closeSync(fd);
  }
}

/** Read the tail as raw text, for the progress parser. */
export function readLogTailText(logPath: string): string {
  return readLogTail(logPath, Number.MAX_SAFE_INTEGER).lines.join("\n");
}
