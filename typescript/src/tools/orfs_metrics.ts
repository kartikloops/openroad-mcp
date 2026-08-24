import fs from "node:fs";
import path from "node:path";
import { getSettings } from "../config/settings.js";
import type { OpenROADManager } from "../core/manager.js";
import { OrfsMetricsResult } from "../core/models.js";
import type { OrfsStageMetrics } from "../core/models.js";
import { ValidationError } from "../exceptions.js";
import {
  validatePathSegment,
  validateSafePathContainment,
} from "../utils/path_security.js";
import { BaseTool } from "./base.js";

/**
 * Stage aliases, tried before a plain substring match.
 *
 * ORFS rule files key metrics by namespace (`globalroute__*`) while the files
 * on disk are numbered by step (`5_1_grt.json`), so a caller who has read
 * rules-base.json has no way to guess the filename. These map both the
 * namespaces and the everyday stage names onto stem fragments.
 */
const NAMESPACE_ALIASES: Record<string, string> = {
  placeopt: "place_resized",
  detailedplace: "place_dp",
  globalplace: "place_gp",
  globalroute: "grt",
  detailedroute: "route",
  finish: "report",
};

/** Everyday stage names, mapped to the numeric prefix ORFS gives that group. */
const GROUP_ALIASES: Record<string, string> = {
  synth: "1_",
  synthesis: "1_",
  floorplan: "2_",
  place: "3_",
  placement: "3_",
  cts: "4_",
  route: "5_",
  routing: "5_",
  finish: "6_",
};

/** Per-stage cap on returned log lines, so one noisy stage cannot swamp a result. */
const MAX_LOG_LINES = 50;

/** ORFS tags its own diagnostics; free-text lines mentioning "error" are noise. */
const ERROR_LINE = /^\s*\[ERROR\s+[^\]]*\]/;
const WARNING_LINE = /^\s*\[WARNING\s+[^\]]*\]/;

/** A metric value as ORFS writes it, or an array when the file repeated the key. */
export type MetricValue = unknown;

export interface ParsedMetrics {
  metrics: Record<string, MetricValue>;
  /** Keys that appeared more than once and are therefore arrays. */
  repeatedMetrics: string[];
}

/**
 * Parse an ORFS stage metrics file without losing repeated keys.
 *
 * ORFS appends a block of metrics per sub-run, so a single file legitimately
 * contains the same key more than once -- `4_1_cts.json` has 63 key
 * occurrences across 55 distinct keys, with `cts__utilization__before__dpl`
 * recorded as both 76.7787 and 82.1146. `JSON.parse` keeps only the last
 * occurrence and reports nothing, so a naive reader silently drops the earlier
 * pass. A reviver cannot recover them either: duplicates are collapsed while
 * the object is built, before any reviver runs.
 *
 * So: validate with `JSON.parse`, then walk the text collecting top-level
 * key/value spans in file order. The walk tracks nesting depth and string
 * state rather than pattern-matching, so an object- or array-valued metric
 * cannot desynchronise it.
 */
export function parseMetricsPreservingDuplicates(text: string): ParsedMetrics {
  // Validate first so a malformed file produces a clean JSON error rather than
  // a confusing failure part-way through the scan.
  const validated: unknown = JSON.parse(text);
  if (validated === null || typeof validated !== "object" || Array.isArray(validated)) {
    throw new SyntaxError("Metrics file must contain a JSON object at the top level");
  }

  const ordered: Array<[string, unknown]> = [];
  let i = 0;
  const n = text.length;

  const skipWhitespace = (): void => {
    while (i < n && /\s/.test(text[i]!)) i += 1;
  };

  /** Consume one JSON string starting at a quote, returning its parsed value. */
  const readString = (): string => {
    const start = i;
    i += 1; // opening quote
    while (i < n) {
      const ch = text[i]!;
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === '"') {
        i += 1;
        return JSON.parse(text.slice(start, i)) as string;
      }
      i += 1;
    }
    throw new SyntaxError("Unterminated string in metrics file");
  };

  /** Consume one JSON value, returning its parsed form. */
  const readValue = (): unknown => {
    skipWhitespace();
    const start = i;
    const ch = text[i];
    if (ch === '"') {
      readString();
      return JSON.parse(text.slice(start, i));
    }
    if (ch === "{" || ch === "[") {
      let depth = 0;
      while (i < n) {
        const c = text[i]!;
        if (c === '"') {
          readString();
          continue;
        }
        if (c === "{" || c === "[") depth += 1;
        else if (c === "}" || c === "]") {
          depth -= 1;
          if (depth === 0) {
            i += 1;
            return JSON.parse(text.slice(start, i));
          }
        }
        i += 1;
      }
      throw new SyntaxError("Unterminated object or array in metrics file");
    }
    // A bare literal: number, true, false or null.
    while (i < n && !",}\n\r\t ".includes(text[i]!)) i += 1;
    return JSON.parse(text.slice(start, i).trim());
  };

  skipWhitespace();
  if (text[i] !== "{") throw new SyntaxError("Metrics file must start with '{'");
  i += 1;

  for (;;) {
    skipWhitespace();
    if (i >= n) break;
    if (text[i] === "}") break;
    if (text[i] === ",") {
      i += 1;
      continue;
    }
    if (text[i] !== '"') break;
    const key = readString();
    skipWhitespace();
    if (text[i] !== ":") throw new SyntaxError(`Expected ':' after key '${key}'`);
    i += 1;
    ordered.push([key, readValue()]);
  }

  const counts = new Map<string, number>();
  for (const [key] of ordered) counts.set(key, (counts.get(key) ?? 0) + 1);

  const metrics: Record<string, MetricValue> = {};
  const repeatedMetrics: string[] = [];
  for (const [key, value] of ordered) {
    if ((counts.get(key) ?? 0) > 1) {
      if (!Array.isArray(metrics[key])) {
        metrics[key] = [];
        repeatedMetrics.push(key);
      }
      (metrics[key] as unknown[]).push(value);
    } else {
      metrics[key] = value;
    }
  }

  return { metrics, repeatedMetrics };
}

/**
 * Find the platform a design belongs to.
 *
 * `platform` is optional so a caller can ask for a design by name alone, which
 * is how people actually refer to them ("gcd", "ibex"). Ambiguity is reported
 * rather than guessed at.
 */
export function resolvePlatform(design: string, platform?: string | null): string {
  const settings = getSettings();
  const platforms = settings.platforms;

  if (platform != null && platform !== "") {
    if (!platforms.includes(platform)) {
      throw new ValidationError(
        `Platform '${platform}' not found. Available platforms: ${platforms.join(", ") || "none"}`,
      );
    }
    if (!settings.designs(platform).includes(design)) {
      throw new ValidationError(
        `Design '${design}' not found for platform '${platform}'. ` +
          `Available designs: ${settings.designs(platform).join(", ") || "none"}`,
      );
    }
    return platform;
  }

  const matches = platforms.filter((p) => settings.designs(p).includes(design));
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    const known = platforms
      .flatMap((p) => settings.designs(p).map((d) => `${p}/${d}`))
      .join(", ");
    throw new ValidationError(
      `Design '${design}' not found under any platform. Available designs: ${known || "none"}`,
    );
  }
  throw new ValidationError(
    `Design '${design}' exists under multiple platforms (${matches.join(", ")}). ` +
      `Pass platform to disambiguate.`,
  );
}

/** Stage stems that have a metrics file, plus those that only have a log. */
function availableStems(logsDir: string): { withMetrics: string[]; logOnly: string[] } {
  let entries: string[];
  try {
    entries = fs.readdirSync(logsDir);
  } catch {
    return { withMetrics: [], logOnly: [] };
  }
  const json = new Set<string>();
  const logs = new Set<string>();
  for (const e of entries) {
    if (e.endsWith(".json")) json.add(e.slice(0, -".json".length));
    else if (e.endsWith(".log")) logs.add(e.slice(0, -".log".length));
  }
  const withMetrics = [...json].sort();
  const logOnly = [...logs].filter((s) => !json.has(s)).sort();
  return { withMetrics, logOnly };
}

/**
 * Map a requested stage onto the stems actually present.
 *
 * Resolution is by discovery rather than a hardcoded stem table: ORFS
 * renumbers stages between releases, and a table would silently return nothing
 * on a tree that had moved on.
 */
export function resolveStages(stems: string[], stage: string): string[] {
  const wanted = stage.trim().toLowerCase();
  if (wanted === "" || wanted === "all") return [...stems];

  const exact = stems.filter((s) => s.toLowerCase() === wanted);
  if (exact.length > 0) return exact;

  const namespaceFragment = NAMESPACE_ALIASES[wanted];
  if (namespaceFragment !== undefined) {
    const hits = stems.filter((s) => s.toLowerCase().includes(namespaceFragment));
    if (hits.length > 0) return hits;
  }

  const groupPrefix = GROUP_ALIASES[wanted];
  if (groupPrefix !== undefined) {
    const hits = stems.filter((s) => s.startsWith(groupPrefix));
    if (hits.length > 0) return hits;
  }

  return stems.filter((s) => s.toLowerCase().includes(wanted));
}

export interface GateRule {
  value: unknown;
  compare: string;
  level?: string;
}

/** Compare a metric against a rules-base threshold. */
export function compareGate(value: unknown, compare: string, threshold: unknown): boolean | null {
  if (compare === "==") return value === threshold;
  if (compare === "!=") return value !== threshold;
  if (typeof value !== "number" || typeof threshold !== "number") return null;
  if (compare === ">=") return value >= threshold;
  if (compare === "<=") return value <= threshold;
  if (compare === ">") return value > threshold;
  if (compare === "<") return value < threshold;
  return null;
}

interface StageMetrics {
  stage: string;
  metrics: Record<string, MetricValue>;
}

export interface GateVerdict {
  metric: string;
  stage: string;
  value: unknown;
  threshold: unknown;
  compare: string;
  level: string;
  status: "pass" | "fail" | "unknown";
  /** True when the metric was recorded more than once and the last was judged. */
  ambiguous?: boolean;
}

/**
 * Evaluate every rule whose metric appears in the stages that were read.
 *
 * Matching on presence rather than a namespace-to-file table means a rule is
 * checked wherever its metric turns up, and `stage: "all"` covers the lot.
 */
export function evaluateGates(
  stages: StageMetrics[],
  rules: Record<string, GateRule>,
): { gates: GateVerdict[]; unmatched: Array<{ metric: string; threshold: unknown; compare: string; level: string }> } {
  const gates: GateVerdict[] = [];
  const unmatched: Array<{ metric: string; threshold: unknown; compare: string; level: string }> = [];

  for (const [metric, rule] of Object.entries(rules)) {
    // ORFS treats a rule with no explicit level as an error-level gate.
    const level = rule.level ?? "error";
    const owner = stages.find((s) => metric in s.metrics);
    if (owner === undefined) {
      unmatched.push({ metric, threshold: rule.value, compare: rule.compare, level });
      continue;
    }

    const raw = owner.metrics[metric];
    // A repeated key was recorded once per sub-run; judge the final value,
    // which is what ORFS's own checkers see, and say that it was ambiguous.
    const ambiguous = Array.isArray(raw);
    const value = ambiguous ? (raw as unknown[])[(raw as unknown[]).length - 1] : raw;

    const result = compareGate(value, rule.compare, rule.value);
    gates.push({
      metric,
      stage: owner.stage,
      value,
      threshold: rule.value,
      compare: rule.compare,
      level,
      status: result === null ? "unknown" : result ? "pass" : "fail",
      ...(ambiguous && { ambiguous: true }),
    });
  }

  return { gates, unmatched };
}

export interface LogDiagnostics {
  path: string;
  errors: string[];
  warnings: string[];
  errorCount: number;
  warningCount: number;
  /** True when more diagnostics existed than are listed. */
  truncated: boolean;
}

/** Pull ORFS's own tagged diagnostics out of a stage log. */
export function extractLogDiagnostics(logPath: string, relPath: string): LogDiagnostics | null {
  let text: string;
  try {
    text = fs.readFileSync(logPath, "utf8");
  } catch {
    return null;
  }

  const errors: string[] = [];
  const warnings: string[] = [];
  let errorCount = 0;
  let warningCount = 0;

  for (const line of text.split(/\r?\n/)) {
    if (ERROR_LINE.test(line)) {
      errorCount += 1;
      if (errors.length < MAX_LOG_LINES) errors.push(line.trim());
    } else if (WARNING_LINE.test(line)) {
      warningCount += 1;
      if (warnings.length < MAX_LOG_LINES) warnings.push(line.trim());
    }
  }

  return {
    path: relPath,
    errors,
    warnings,
    errorCount,
    warningCount,
    truncated: errorCount > errors.length || warningCount > warnings.length,
  };
}

/** Structured failure, matching the error-code style the image tools use. */
function failure(error: string, message: string): string {
  return JSON.stringify({
    platform: null,
    design: null,
    variant: null,
    stage: null,
    logs_path: null,
    stages: [],
    available_stages: [],
    gates: [],
    unmatched_gates: [],
    gate_summary: null,
    rules_path: null,
    message,
    error,
  });
}

/**
 * Read ORFS per-stage metrics, the design's rules-base gates, and the tagged
 * diagnostics from each stage log.
 *
 * This exists because the capability study found ~39% of all shell calls were
 * agents doing exactly this by hand with find/cat/jq/grep -- the single
 * largest category of MCP bypass.
 */
export class ReadOrfsMetricsTool extends BaseTool {
  constructor(manager: OpenROADManager) {
    super(manager);
  }

  async execute(
    design: string,
    stage = "all",
    platform?: string | null,
    variant = "base",
  ): Promise<string> {
    let resolvedPlatform: string;
    try {
      validatePathSegment(design, "design");
      validatePathSegment(variant, "variant");
      resolvedPlatform = resolvePlatform(design, platform);
    } catch (e) {
      if (e instanceof ValidationError) {
        return failure(e.constructor.name, e.message);
      }
      return failure("UnexpectedError", (e as Error).message ?? String(e));
    }

    const settings = getSettings();
    const flowPath = settings.flowPath;
    const logsBase = path.join(flowPath, "logs", resolvedPlatform, design);
    const logsDir = path.join(logsBase, variant);

    try {
      validateSafePathContainment(logsDir, path.join(flowPath, "logs"), "logs directory");
    } catch (e) {
      return failure((e as ValidationError).constructor.name, (e as Error).message);
    }

    if (!fs.existsSync(logsDir)) {
      let variants: string[] = [];
      try {
        variants = fs
          .readdirSync(logsBase, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);
      } catch {
        variants = [];
      }
      return failure(
        "RunNotFound",
        `No logs for ${resolvedPlatform}/${design} variant '${variant}'. ` +
          `Available variants: ${variants.join(", ") || "none"}`,
      );
    }

    const { withMetrics, logOnly } = availableStems(logsDir);
    const allStems = [...withMetrics, ...logOnly].sort();
    const selected = resolveStages(allStems, stage);

    if (selected.length === 0) {
      return failure(
        "StageNotFound",
        `Stage '${stage}' matched nothing for ${resolvedPlatform}/${design}/${variant}. ` +
          `Available stages: ${allStems.join(", ") || "none"}`,
      );
    }

    const relLogs = path.relative(flowPath, logsDir);
    const stages: OrfsStageMetrics[] = [];

    for (const stem of selected) {
      const metricsPath = path.join(logsDir, `${stem}.json`);
      const logPath = path.join(logsDir, `${stem}.log`);

      let metrics: Record<string, unknown> = {};
      let repeatedMetrics: string[] = [];
      let stageError: string | null = null;
      let relMetrics: string | null = null;

      if (fs.existsSync(metricsPath)) {
        relMetrics = path.relative(flowPath, metricsPath);
        try {
          const parsed = parseMetricsPreservingDuplicates(fs.readFileSync(metricsPath, "utf8"));
          metrics = parsed.metrics;
          repeatedMetrics = parsed.repeatedMetrics;
        } catch (e) {
          // A stage that crashed can leave a half-written metrics file. Say so
          // rather than dropping the stage: its log usually explains why.
          stageError = `MalformedMetrics: ${(e as Error).message}`;
        }
      }

      stages.push({
        stage: stem,
        metricsPath: relMetrics,
        metrics,
        repeatedMetrics,
        log: extractLogDiagnostics(logPath, path.relative(flowPath, logPath)),
        error: stageError,
      });
    }

    // Gates
    const rulesPath = path.join(flowPath, "designs", resolvedPlatform, design, "rules-base.json");
    let rules: Record<string, GateRule> = {};
    let relRules: string | null = null;
    let message: string | null = null;

    if (fs.existsSync(rulesPath)) {
      relRules = path.relative(flowPath, rulesPath);
      try {
        rules = JSON.parse(fs.readFileSync(rulesPath, "utf8")) as Record<string, GateRule>;
      } catch (e) {
        message = `rules-base.json could not be parsed: ${(e as Error).message}`;
      }
    } else {
      message = `No rules-base.json for ${resolvedPlatform}/${design}; no gates to evaluate.`;
    }

    const { gates, unmatched } = evaluateGates(stages, rules);
    const failing = gates.filter((g) => g.status === "fail");

    return this.formatResult(
      OrfsMetricsResult.parse({
        platform: resolvedPlatform,
        design,
        variant,
        stage,
        logsPath: relLogs,
        stages,
        availableStages: allStems,
        gates,
        unmatchedGates: unmatched,
        gateSummary: {
          total: gates.length,
          pass: gates.filter((g) => g.status === "pass").length,
          fail: failing.length,
          unknown: gates.filter((g) => g.status === "unknown").length,
          failingErrors: failing.filter((g) => g.level === "error").length,
          failingWarnings: failing.filter((g) => g.level !== "error").length,
          unmatched: unmatched.length,
        },
        rulesPath: relRules,
        message,
      }) as unknown as Record<string, unknown>,
    );
  }
}
