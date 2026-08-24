import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Mock } from "vitest";
import { GrepSessionOutputTool, QueryShellTool, ExecShellTool, ListSessionsTool, CreateSessionTool, TerminateSessionTool, InspectSessionTool, SessionHistoryTool, SessionMetricsTool, InteractiveShellTool } from "../../src/tools/interactive.js";
import type { OpenROADManager } from "../../src/core/manager.js";
import { SessionNotFoundError, SessionTerminatedError, SessionError } from "../../src/interactive/models.js";
import { SessionState } from "../../src/core/models.js";
import { toSnakeCase } from "../../src/tools/base.js";
import type { InteractiveExecResult, InteractiveSessionInfo, SessionDetailedMetrics, ManagerMetrics } from "../../src/core/models.js";

const NOW = "2024-01-01T00:00:00.000Z";

function makeExecResult(overrides: Partial<InteractiveExecResult> = {}): InteractiveExecResult {
  return {
    output: "test output",
    sessionId: "session-1",
    timestamp: NOW,
    executionTime: 0.1,
    commandCount: 1,
    bufferSize: 131072,
    truncated: false,
    bytesDiscarded: 0,
    totalBytes: 11,
    error: null,
    ...overrides,
  };
}

function makeSessionInfo(overrides: Partial<InteractiveSessionInfo> = {}): InteractiveSessionInfo {
  return {
    sessionId: "session-1",
    createdAt: NOW,
    isAlive: true,
    commandCount: 5,
    bufferSize: 1024,
    uptimeSeconds: 100.0,
    state: SessionState.ACTIVE,
    error: null,
    ...overrides,
  };
}

function makeMetrics(sessionId = "session-1"): SessionDetailedMetrics {
  return {
    sessionId,
    state: SessionState.ACTIVE,
    isAlive: true,
    createdAt: NOW,
    lastActivity: NOW,
    uptimeSeconds: 1,
    idleSeconds: 0,
    commands: { totalExecuted: 1, currentCount: 1, historyLength: 1 },
    performance: { totalCpuTime: 0.1, peakMemoryMb: 10, currentMemoryMb: 8 },
    buffer: { currentSize: 0, maxSize: 1024, utilizationPercent: 0 },
    timeout: { configuredSeconds: null, isTimedOut: false },
  };
}

function makeManagerMetrics(): ManagerMetrics {
  return {
    manager: { totalSessions: 1, activeSessions: 1, terminatedSessions: 0, maxSessions: 50, utilizationPercent: 2 },
    aggregate: { totalCommands: 5, totalCpuTime: 0.5, totalMemoryMb: 8, avgMemoryPerSession: 8 },
    sessions: [makeMetrics()],
  };
}

interface MockManager extends Record<string, Mock> {
  createSession: Mock;
  executeCommand: Mock;
  listSessions: Mock;
  getSessionInfo: Mock;
  terminateSession: Mock;
  inspectSession: Mock;
  getSessionHistory: Mock;
  sessionMetrics: Mock;
}

function makeMockManager(): MockManager {
  return {
    createSession: vi.fn().mockResolvedValue("session-1"),
    executeCommand: vi.fn().mockResolvedValue(makeExecResult()),
    listSessions: vi.fn().mockResolvedValue([]),
    getSessionInfo: vi.fn().mockResolvedValue(makeSessionInfo()),
    terminateSession: vi.fn().mockResolvedValue(undefined),
    inspectSession: vi.fn().mockResolvedValue(makeMetrics()),
    getSessionHistory: vi.fn().mockResolvedValue([]),
    sessionMetrics: vi.fn().mockResolvedValue(makeManagerMetrics()),
  };
}

describe("QueryShellTool", () => {
  let mgr: MockManager;
  let tool: QueryShellTool;

  beforeEach(() => {
    mgr = makeMockManager();
    tool = new QueryShellTool(mgr as unknown as OpenROADManager);
  });

  it("auto-creates a session when sessionId is null", async () => {
    const raw = await tool.execute("help", null);
    const result = JSON.parse(raw);
    expect(mgr.createSession).toHaveBeenCalledOnce();
    expect(result.output).toBe("test output");
    expect(result.session_id).toBe("session-1");
  });

  it("uses an existing session without creating a new one", async () => {
    const raw = await tool.execute("help", "session-1");
    JSON.parse(raw);
    expect(mgr.createSession).not.toHaveBeenCalled();
    expect(mgr.executeCommand).toHaveBeenCalledWith("session-1", "help", undefined);
  });

  it("returns snake_case keys in JSON output", async () => {
    const raw = await tool.execute("help", "session-1");
    const result = JSON.parse(raw);
    expect(Object.keys(result)).toContain("session_id");
    expect(Object.keys(result)).toContain("execution_time");
    expect(Object.keys(result)).toContain("command_count");
    expect(Object.keys(result)).toContain("buffer_size");
    expect(Object.keys(result)).toContain("truncated");
    expect(Object.keys(result)).toContain("bytes_discarded");
    expect(Object.keys(result)).toContain("total_bytes");
  });

  it("leaves SCREAMING_SNAKE data keys alone rather than mangling them", async () => {
    // An ORFS make variable arrives as data, not as a camelCase field name.
    // Converting it yields _c_t_s__c_l_u_s_t_e_r__s_i_z_e and destroys a name
    // the caller has to be able to read back.
    const converted = toSnakeCase({
      overrides: { CTS_CLUSTER_SIZE: "20", PLACE_DENSITY_LB_ADDON: "0.25" },
      sessionId: "s1",
    }) as Record<string, Record<string, string>>;

    expect(Object.keys(converted.overrides!)).toEqual([
      "CTS_CLUSTER_SIZE",
      "PLACE_DENSITY_LB_ADDON",
    ]);
    expect(Object.keys(converted)).toContain("session_id");
  });

  it("leaves a single-token override name alone", async () => {
    // CORNER and JOBS carry no underscore and no colon, so the guards written
    // for CTS_CLUSTER_SIZE did not reach them: CORNER became _c_o_r_n_e_r,
    // destroying a name run_orfs_stage documents as returned verbatim.
    const converted = toSnakeCase({
      overrides: { CORNER: "fast", JOBS: "8", GDS: "x.gds" },
      sessionId: "s1",
    }) as Record<string, Record<string, string>>;

    expect(Object.keys(converted.overrides!)).toEqual(["CORNER", "JOBS", "GDS"]);
    expect(Object.keys(converted)).toContain("session_id");
  });

  it("leaves an ORFS metric key carrying a mixed-case site name intact", async () => {
    // Observed in a real run: the key is mostly lowercase, so a
    // "has no lowercase letters" guard does not protect it, and the site name
    // after the colon was rewritten to gibberish.
    const converted = toSnakeCase({
      "cts__design__rows:FreePDK45_38x28_10R_NP_162NW_34o": 23,
    }) as Record<string, unknown>;

    expect(Object.keys(converted)).toEqual([
      "cts__design__rows:FreePDK45_38x28_10R_NP_162NW_34o",
    ]);
  });

  it("handles SessionNotFoundError", async () => {
    mgr.executeCommand.mockRejectedValue(new SessionNotFoundError("not found", "session-1"));
    const raw = await tool.execute("help", "session-1");
    const result = JSON.parse(raw);
    expect(result.output).toBe("Error: Session 'session-1' not found.");
    expect(result.error).toContain("not found");
  });

  it("handles SessionTerminatedError", async () => {
    mgr.executeCommand.mockRejectedValue(new SessionTerminatedError("terminated", "session-1"));
    const raw = await tool.execute("help", "session-1");
    const result = JSON.parse(raw);
    expect(result.output).toBe("");
    expect(result.error).toContain("terminated");
  });

  it("handles unexpected errors", async () => {
    mgr.executeCommand.mockRejectedValue(new Error("boom"));
    const raw = await tool.execute("help", "session-1");
    const result = JSON.parse(raw);
    expect(result.error).toContain("Unexpected error");
    expect(result.error).toContain("boom");
  });

  it("blocks dangerous commands when whitelist is enabled", async () => {
    const raw = await tool.execute("quit");
    const result = JSON.parse(raw);
    expect(result.error).toMatch(/CommandBlocked/);
    expect(mgr.executeCommand).not.toHaveBeenCalled();
  });

  it("InteractiveShellTool is an alias for QueryShellTool", () => {
    expect(InteractiveShellTool).toBe(QueryShellTool);
  });
});

describe("ExecShellTool", () => {
  let mgr: MockManager;
  let tool: ExecShellTool;

  beforeEach(() => {
    mgr = makeMockManager();
    tool = new ExecShellTool(mgr as unknown as OpenROADManager);
  });

  it("executes a state-modifying command", async () => {
    const raw = await tool.execute("set_wire_rc -signal -layer metal3", "session-1");
    const result = JSON.parse(raw);
    expect(result.output).toBe("test output");
    expect(mgr.createSession).not.toHaveBeenCalled();
  });

  it("blocks quit via BLOCKED_COMMANDS", async () => {
    const raw = await tool.execute("quit");
    const result = JSON.parse(raw);
    expect(result.error).toMatch(/CommandBlocked/);
  });

  it("handles SessionNotFoundError", async () => {
    mgr.executeCommand.mockRejectedValue(new SessionNotFoundError("missing", "session-1"));
    const raw = await tool.execute("read_lef foo.lef", "session-1");
    const result = JSON.parse(raw);
    expect(result.output).toContain("not found");
  });

  it("tells the caller how to render a timing path when gui::show is blocked", async () => {
    // "not on the allowlist" alone is a dead end here: the caller wants an
    // image and there is a form that produces one headlessly.
    const raw = await tool.execute("gui::show");
    const result = JSON.parse(raw);

    expect(result.error).toMatch(/CommandBlocked/);
    expect(result.message).toContain("gui::show {<tcl>} false");
    expect(result.message).toContain("QT_QPA_PLATFORM=offscreen");
    expect(result.message).toContain("gui::show_worst_path");
    expect(mgr.executeCommand).not.toHaveBeenCalled();
  });
});

describe("ListSessionsTool", () => {
  let mgr: MockManager;
  let tool: ListSessionsTool;

  beforeEach(() => {
    mgr = makeMockManager();
    tool = new ListSessionsTool(mgr as unknown as OpenROADManager);
  });

  it("returns empty list when no sessions exist", async () => {
    const raw = await tool.execute();
    const result = JSON.parse(raw);
    expect(result.sessions).toEqual([]);
    expect(result.total_count).toBe(0);
    expect(result.active_count).toBe(0);
    expect(result.error).toBeNull();
  });

  it("counts only alive sessions in active_count", async () => {
    mgr.listSessions.mockResolvedValue([
      makeSessionInfo({ sessionId: "s1", isAlive: true }),
      makeSessionInfo({ sessionId: "s2", isAlive: false }),
      makeSessionInfo({ sessionId: "s3", isAlive: true }),
    ]);
    const raw = await tool.execute();
    const result = JSON.parse(raw);
    expect(result.total_count).toBe(3);
    expect(result.active_count).toBe(2);
  });

  it("returns error field on exception", async () => {
    mgr.listSessions.mockRejectedValue(new Error("db error"));
    const raw = await tool.execute();
    const result = JSON.parse(raw);
    expect(result.error).toBeTruthy();
    expect(result.sessions).toEqual([]);
  });
});

describe("CreateSessionTool", () => {
  let mgr: MockManager;
  let tool: CreateSessionTool;

  beforeEach(() => {
    mgr = makeMockManager();
    tool = new CreateSessionTool(mgr as unknown as OpenROADManager);
  });

  it("creates a session with default parameters", async () => {
    const raw = await tool.execute();
    const result = JSON.parse(raw);
    expect(mgr.createSession).toHaveBeenCalledOnce();
    expect(result.session_id).toBe("session-1");
    expect(result.is_alive).toBe(true);
  });

  it("passes custom parameters to createSession", async () => {
    await tool.execute("my-id", ["openroad"], { KEY: "VAL" }, "/tmp");
    expect(mgr.createSession).toHaveBeenCalledWith({
      sessionId: "my-id",
      command: ["openroad"],
      env: { KEY: "VAL" },
      cwd: "/tmp",
    });
  });

  it("returns error info when creation fails", async () => {
    mgr.createSession.mockRejectedValue(new SessionError("limit reached"));
    const raw = await tool.execute("my-id");
    const result = JSON.parse(raw);
    expect(result.is_alive).toBe(false);
    expect(result.error).toContain("limit reached");
  });
});

describe("TerminateSessionTool", () => {
  let mgr: MockManager;
  let tool: TerminateSessionTool;

  beforeEach(() => {
    mgr = makeMockManager();
    tool = new TerminateSessionTool(mgr as unknown as OpenROADManager);
  });

  it("terminates a session normally", async () => {
    const raw = await tool.execute("session-1");
    const result = JSON.parse(raw);
    expect(result.terminated).toBe(true);
    expect(result.was_alive).toBe(true);
    expect(result.force).toBe(false);
    expect(result.error).toBeNull();
  });

  it("force-terminates a session", async () => {
    const raw = await tool.execute("session-1", true);
    const result = JSON.parse(raw);
    expect(result.force).toBe(true);
    expect(result.terminated).toBe(true);
  });

  it("handles terminating a non-existent session", async () => {
    mgr.getSessionInfo.mockRejectedValue(new SessionNotFoundError("not found", "session-1"));
    mgr.terminateSession.mockRejectedValue(new SessionNotFoundError("not found", "session-1"));
    const raw = await tool.execute("session-1");
    const result = JSON.parse(raw);
    expect(result.terminated).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("handles unexpected termination errors", async () => {
    mgr.terminateSession.mockRejectedValue(new Error("PTY crash"));
    const raw = await tool.execute("session-1");
    const result = JSON.parse(raw);
    expect(result.terminated).toBe(false);
    expect(result.error).toContain("Termination failed");
  });
});

describe("InspectSessionTool", () => {
  let mgr: MockManager;
  let tool: InspectSessionTool;

  beforeEach(() => {
    mgr = makeMockManager();
    tool = new InspectSessionTool(mgr as unknown as OpenROADManager);
  });

  it("returns session metrics", async () => {
    const raw = await tool.execute("session-1");
    const result = JSON.parse(raw);
    expect(result.session_id).toBe("session-1");
    expect(result.metrics).toBeTruthy();
    expect(result.metrics.session_id).toBe("session-1");
    expect(result.error).toBeNull();
  });

  it("returns error when session not found", async () => {
    mgr.inspectSession.mockRejectedValue(new SessionNotFoundError("missing", "session-1"));
    const raw = await tool.execute("session-1");
    const result = JSON.parse(raw);
    expect(result.metrics).toBeNull();
    expect(result.error).toBeTruthy();
  });

  it("returns error on unexpected failure", async () => {
    mgr.inspectSession.mockRejectedValue(new Error("cpu panic"));
    const raw = await tool.execute("session-1");
    const result = JSON.parse(raw);
    expect(result.error).toContain("Inspection failed");
  });
});

describe("SessionHistoryTool", () => {
  let mgr: MockManager;
  let tool: SessionHistoryTool;

  beforeEach(() => {
    mgr = makeMockManager();
    tool = new SessionHistoryTool(mgr as unknown as OpenROADManager);
  });

  it("returns session history", async () => {
    mgr.getSessionHistory.mockResolvedValue([
      { command: "help", timestamp: NOW, commandNumber: 1, executionStart: 0 },
    ]);
    const raw = await tool.execute("session-1");
    const result = JSON.parse(raw);
    expect(result.session_id).toBe("session-1");
    expect(result.total_commands).toBe(1);
    expect(result.history).toHaveLength(1);
    expect(result.error).toBeNull();
  });

  it("passes limit and search parameters", async () => {
    await tool.execute("session-1", 10, "report");
    expect(mgr.getSessionHistory).toHaveBeenCalledWith("session-1", 10, "report");
  });

  it("returns error when session not found", async () => {
    mgr.getSessionHistory.mockRejectedValue(new SessionNotFoundError("gone", "session-1"));
    const raw = await tool.execute("session-1");
    const result = JSON.parse(raw);
    expect(result.history).toEqual([]);
    expect(result.total_commands).toBe(0);
    expect(result.error).toBeTruthy();
  });

  it("returns error on unexpected failure", async () => {
    mgr.getSessionHistory.mockRejectedValue(new Error("disk full"));
    const raw = await tool.execute("session-1");
    const result = JSON.parse(raw);
    expect(result.error).toContain("History retrieval failed");
  });
});

describe("SessionMetricsTool", () => {
  let mgr: MockManager;
  let tool: SessionMetricsTool;

  beforeEach(() => {
    mgr = makeMockManager();
    tool = new SessionMetricsTool(mgr as unknown as OpenROADManager);
  });

  it("returns manager-wide metrics", async () => {
    const raw = await tool.execute();
    const result = JSON.parse(raw);
    expect(result.metrics).toBeTruthy();
    expect(result.metrics.manager.total_sessions).toBe(1);
    expect(result.error).toBeNull();
  });

  it("returns error on unexpected failure", async () => {
    mgr.sessionMetrics.mockRejectedValue(new Error("overload"));
    const raw = await tool.execute();
    const result = JSON.parse(raw);
    expect(result.metrics).toBeNull();
    expect(result.error).toContain("Metrics retrieval failed");
  });
});

describe("Integration: session workflow", () => {
  it("create, execute, list, terminate", async () => {
    const mgr = makeMockManager();
    mgr.listSessions.mockResolvedValue([makeSessionInfo()]);

    const created = JSON.parse(await new CreateSessionTool(mgr as unknown as OpenROADManager).execute("test-id"));
    expect(created.session_id).toBe("session-1");

    const exec = JSON.parse(await new QueryShellTool(mgr as unknown as OpenROADManager).execute("help", "session-1"));
    expect(exec.output).toBe("test output");

    const list = JSON.parse(await new ListSessionsTool(mgr as unknown as OpenROADManager).execute());
    expect(list.total_count).toBe(1);

    const term = JSON.parse(await new TerminateSessionTool(mgr as unknown as OpenROADManager).execute("session-1"));
    expect(term.terminated).toBe(true);
  });

  it("concurrent operations complete without interference", async () => {
    const mgr = makeMockManager();
    const queryTool = new QueryShellTool(mgr as unknown as OpenROADManager);
    const [r1, r2, r3] = await Promise.all([
      queryTool.execute("help", "session-1"),
      queryTool.execute("version", "session-1"),
      queryTool.execute("report_checks", "session-1"),
    ]);
    expect(JSON.parse(r1).output).toBe("test output");
    expect(JSON.parse(r2).output).toBe("test output");
    expect(JSON.parse(r3).output).toBe("test output");
  });
});

// Snapshot: one representative output per tool

describe("Snapshots: wire format stability", () => {
  it("QueryShellTool success output", async () => {
    const mgr = makeMockManager();
    const raw = await new QueryShellTool(mgr as unknown as OpenROADManager).execute("help", "session-1");
    expect(raw).toMatchSnapshot();
  });

  it("ListSessionsTool with sessions", async () => {
    const mgr = makeMockManager();
    mgr.listSessions.mockResolvedValue([makeSessionInfo()]);
    const raw = await new ListSessionsTool(mgr as unknown as OpenROADManager).execute();
    expect(raw).toMatchSnapshot();
  });
});

describe("GrepSessionOutputTool", () => {
  function makeManager(over: Partial<Record<string, unknown>> = {}): OpenROADManager {
    return {
      grepSessionOutput: vi.fn().mockResolvedValue({
        matches: [
          { commandNumber: 1, command: "report_checks", lineNumber: 42, line: "wns max -0.485" },
        ],
        totalMatches: 1,
        truncated: false,
        patternKind: "regex",
        searchedCommands: 1,
        searchedLines: 900,
        retainedChars: 131166,
        evictedCommands: 0,
      }),
      ...over,
    } as unknown as OpenROADManager;
  }

  it("returns matches with their command and line number in snake_case", async () => {
    const raw = await new GrepSessionOutputTool(makeManager()).execute("s1", "wns");
    const result = JSON.parse(raw);

    expect(result.error).toBeNull();
    expect(result.total_matches).toBe(1);
    expect(result.matches[0]).toMatchObject({
      command_number: 1,
      command: "report_checks",
      line_number: 42,
      line: "wns max -0.485",
    });
    expect(result.searched_lines).toBe(900);
  });

  it("forwards the search options it was given", async () => {
    const mgr = makeManager();
    await new GrepSessionOutputTool(mgr).execute("s1", "wns", 10, 2, false, 3);

    expect(mgr.grepSessionOutput).toHaveBeenCalledWith("s1", "wns", {
      maxMatches: 10,
      contextLines: 2,
      ignoreCase: false,
      commandNumber: 3,
    });
  });

  it("says plainly when matches were capped", async () => {
    const mgr = makeManager({
      grepSessionOutput: vi.fn().mockResolvedValue({
        matches: [], totalMatches: 500, truncated: true, patternKind: "regex",
        searchedCommands: 2, searchedLines: 9000, retainedChars: 1000, evictedCommands: 0,
      }),
    });

    const result = JSON.parse(await new GrepSessionOutputTool(mgr).execute("s1", "slack"));

    expect(result.truncated).toBe(true);
    expect(result.message).toMatch(/of 500 matches/);
  });

  it("explains an empty search rather than looking like a clean miss", async () => {
    const mgr = makeManager({
      grepSessionOutput: vi.fn().mockResolvedValue({
        matches: [], totalMatches: 0, truncated: false, patternKind: "regex",
        searchedCommands: 0, searchedLines: 0, retainedChars: 0, evictedCommands: 0,
      }),
    });

    const result = JSON.parse(await new GrepSessionOutputTool(mgr).execute("s1", "wns"));

    expect(result.message).toMatch(/No command output is retained/);
  });

  it("reports a missing session as a structured error", async () => {
    const mgr = makeManager({
      grepSessionOutput: vi.fn().mockRejectedValue(new SessionNotFoundError("nope", "s9")),
    });

    const result = JSON.parse(await new GrepSessionOutputTool(mgr).execute("s9", "wns"));

    expect(result.error).toBe("SessionNotFound");
  });
});
