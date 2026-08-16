import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Mock } from "vitest";
import { OpenROADManager } from "../../src/core/manager.js";
import { SessionError, SessionNotFoundError } from "../../src/interactive/models.js";
import { InteractiveSession } from "../../src/interactive/session.js";
import { SessionState } from "../../src/core/models.js";
import type { SessionDetailedMetrics } from "../../src/core/models.js";

// Stub the InteractiveSession constructor so the manager never spawns a PTY.
vi.mock("../../src/interactive/session.js", () => {
  return {
    InteractiveSession: vi.fn(),
  };
});

interface MockSession {
  sessionId: string;
  lastActivity: Date;
  terminatedAt: Date | null;
  checkAlive: Mock;
  start: Mock;
  verifyResponsive: Mock;
  sendCommand: Mock;
  readOutput: Mock;
  runCommand: Mock;
  getInfo: Mock;
  getDetailedMetrics: Mock;
  getCommandHistory: Mock;
  replayCommand: Mock;
  filterOutput: Mock;
  isIdleTimeout: Mock;
  setSessionTimeout: Mock;
  terminate: Mock;
  cleanup: Mock;
}

function makeMockSession(sessionId: string, alive = true): MockSession {
  const metrics: SessionDetailedMetrics = {
    sessionId,
    state: SessionState.ACTIVE,
    isAlive: alive,
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    uptimeSeconds: 1,
    idleSeconds: 0,
    commands: { totalExecuted: 3, currentCount: 3, historyLength: 3 },
    performance: { totalCpuTime: 0.5, peakMemoryMb: 10, currentMemoryMb: 8 },
    buffer: { currentSize: 0, maxSize: 1024, utilizationPercent: 0 },
    timeout: { configuredSeconds: null, isTimedOut: false },
  };

  return {
    sessionId,
    lastActivity: new Date(),
    terminatedAt: null,
    checkAlive: vi.fn().mockReturnValue(alive),
    start: vi.fn().mockResolvedValue(undefined),
    verifyResponsive: vi.fn().mockResolvedValue(undefined),
    sendCommand: vi.fn().mockResolvedValue(undefined),
    readOutput: vi.fn().mockResolvedValue({
      output: "ok",
      sessionId,
      timestamp: new Date().toISOString(),
      executionTime: 0.01,
      commandCount: 1,
      bufferSize: 0,
      error: null,
    }),
    runCommand: vi.fn().mockResolvedValue({
      output: "ok",
      sessionId,
      timestamp: new Date().toISOString(),
      executionTime: 0.01,
      commandCount: 1,
      bufferSize: 0,
      error: null,
    }),
    getInfo: vi.fn().mockResolvedValue({
      sessionId,
      createdAt: new Date().toISOString(),
      isAlive: alive,
      commandCount: 0,
      bufferSize: 0,
      uptimeSeconds: 1,
      state: SessionState.ACTIVE,
    }),
    getDetailedMetrics: vi.fn().mockResolvedValue(metrics),
    getCommandHistory: vi.fn().mockReturnValue([]),
    replayCommand: vi.fn().mockResolvedValue("replayed output"),
    filterOutput: vi.fn().mockResolvedValue(["matched line"]),
    isIdleTimeout: vi.fn().mockReturnValue(false),
    setSessionTimeout: vi.fn(),
    terminate: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn().mockResolvedValue(undefined),
  };
}

const MockedSession = vi.mocked(InteractiveSession);

/** Park the next session's handshake so a create stays in flight on demand.
 * Must be a plain function, not an arrow, so `new` still works. */
function stallNextHandshake(): { handshakeStarted: Promise<void>; release: () => void } {
  let release!: () => void;
  let signalStarted!: () => void;
  const handshakeStarted = new Promise<void>((r) => (signalStarted = r));

  MockedSession.mockImplementationOnce(function (this: unknown, sessionId: string) {
    const mock = makeMockSession(sessionId);
    mock.verifyResponsive = vi.fn().mockImplementation(async () => {
      signalStarted();
      await new Promise<void>((r) => (release = r));
    });
    return mock as unknown as InteractiveSession;
  } as unknown as (sessionId: string) => InteractiveSession);

  return { handshakeStarted, release: () => release() };
}

describe("OpenROADManager", () => {
  let manager: OpenROADManager;
  let created: MockSession[];

  beforeEach(() => {
    vi.clearAllMocks();
    created = [];
    // Each `new InteractiveSession(id)` yields a fresh mock the test can inspect.
    // A regular function (not an arrow) is required so it is constructable.
    MockedSession.mockImplementation(function (this: unknown, sessionId: string) {
      const mock = makeMockSession(sessionId);
      created.push(mock);
      return mock as unknown as InteractiveSession;
    } as unknown as (sessionId: string) => InteractiveSession);
    manager = new OpenROADManager(50);
  });

  describe("createSession", () => {
    it("generates an 8-char id, starts the session, and stores it", async () => {
      const id = await manager.createSession();
      expect(id).toHaveLength(8);
      expect(created).toHaveLength(1);
      expect(created[0]!.start).toHaveBeenCalledOnce();
      expect(manager.getSessionCount()).toBe(1);
    });

    it("honours an explicit session id and forwards start args", async () => {
      const id = await manager.createSession({
        sessionId: "abc",
        command: ["openroad", "-no_init"],
        env: { FOO: "bar" },
        cwd: "/tmp",
      });
      expect(id).toBe("abc");
      expect(created[0]!.start).toHaveBeenCalledWith(["openroad", "-no_init"], { FOO: "bar" }, "/tmp");
    });

    it("throws SessionError on a duplicate id", async () => {
      await manager.createSession({ sessionId: "dup" });
      await expect(manager.createSession({ sessionId: "dup" })).rejects.toBeInstanceOf(SessionError);
    });

    it("throws SessionError when at max capacity", async () => {
      const limited = new OpenROADManager(1);
      await limited.createSession({ sessionId: "s1" });
      await expect(limited.createSession({ sessionId: "s2" })).rejects.toThrow(/Maximum session limit/);
    });

    it("does not hold the manager lock across a slow startup handshake", async () => {
      const { handshakeStarted, release } = stallNextHandshake();

      const slow = manager.createSession({ sessionId: "slow" });
      await handshakeStarted;

      // A second session stuck in its handshake must not stall unrelated
      // lifecycle work; before, this awaited the full handshake timeout.
      await expect(
        Promise.race([
          manager.listSessions().then(() => "listed"),
          new Promise((r) => setTimeout(() => r("blocked"), 1000)),
        ]),
      ).resolves.toBe("listed");

      release();
      await slow;
    });

    it("counts in-flight reservations towards the session cap", async () => {
      const limited = new OpenROADManager(1);
      const { handshakeStarted, release } = stallNextHandshake();

      const first = limited.createSession({ sessionId: "s1" });
      await handshakeStarted;

      // Startup happens outside the lock now, so the reserved-but-unspawned
      // slot is the only thing keeping concurrent creates under the cap.
      await expect(limited.createSession({ sessionId: "s2" })).rejects.toThrow(/Maximum session limit/);

      release();
      await first;
    });

    it("falls back to the default buffer size when bufferSize is 0", async () => {
      await manager.createSession({ sessionId: "zero", bufferSize: 0 });
      // InteractiveSession is constructed with (sessionId, bufferSize); a 0 must
      // not reach it - it would yield a zero-capacity buffer that drops output.
      expect(MockedSession).toHaveBeenCalledWith("zero", expect.any(Number));
      const bufArg = MockedSession.mock.calls[0]![1] as number;
      expect(bufArg).toBeGreaterThan(0);
    });

    it("removes the placeholder when start() fails", async () => {
      MockedSession.mockImplementationOnce(function (this: unknown, sessionId: string) {
        const mock = makeMockSession(sessionId);
        mock.start.mockRejectedValueOnce(new Error("spawn failed"));
        created.push(mock);
        return mock as unknown as InteractiveSession;
      } as unknown as (sessionId: string) => InteractiveSession);
      await expect(manager.createSession({ sessionId: "bad" })).rejects.toBeInstanceOf(SessionError);
      expect(manager.getSessionCount()).toBe(0);
    });
  });

  describe("executeCommand", () => {
    it("delegates to runCommand so completion is actually detected", async () => {
      await manager.createSession({ sessionId: "s1" });
      const result = await manager.executeCommand("s1", "report_wns");
      expect(created[0]!.runCommand).toHaveBeenCalledWith("report_wns", expect.any(Number));
      // readOutput cannot tell a finished command from a quiet one, so the
      // command path must never fall back to it.
      expect(created[0]!.readOutput).not.toHaveBeenCalled();
      expect(result.output).toBe("ok");
    });

    it("throws SessionNotFoundError for an unknown session", async () => {
      await expect(manager.executeCommand("nope", "report_wns")).rejects.toBeInstanceOf(
        SessionNotFoundError,
      );
    });

    it("falls back to the default timeout when timeoutMs is 0", async () => {
      await manager.createSession({ sessionId: "s1" });
      await manager.executeCommand("s1", "report_wns", 0);
      // 0 must not be forwarded as an instant timeout; runCommand gets the default.
      const timeoutArg = created[0]!.runCommand.mock.calls[0]![1] as number;
      expect(timeoutArg).toBeGreaterThan(0);
    });
  });

  describe("listSessions", () => {
    it("returns info for each active session", async () => {
      await manager.createSession({ sessionId: "s1" });
      await manager.createSession({ sessionId: "s2" });
      const infos = await manager.listSessions();
      expect(infos).toHaveLength(2);
      expect(infos.map((i) => i.sessionId).sort()).toEqual(["s1", "s2"]);
    });
  });

  describe("terminateSession", () => {
    it("terminates, cleans up, and removes the session", async () => {
      await manager.createSession({ sessionId: "s1" });
      await manager.terminateSession("s1", true);
      expect(created[0]!.terminate).toHaveBeenCalledWith(true);
      // terminate() handles teardown; cleanup() must not be called again here
      // (it would clear the buffer and double-tear-down the PTY).
      expect(created[0]!.cleanup).not.toHaveBeenCalled();
      expect(manager.getSessionCount()).toBe(0);
    });
  });

  describe("terminateAllSessions", () => {
    it("terminates every session in parallel", async () => {
      await manager.createSession({ sessionId: "s1" });
      await manager.createSession({ sessionId: "s2" });
      const count = await manager.terminateAllSessions();
      expect(count).toBe(2);
      expect(manager.getSessionCount()).toBe(0);
    });

    it("skips in-progress placeholders instead of throwing", async () => {
      // A session whose start() never resolves leaves a null placeholder in the
      // map (createSession holds the lock). terminateAllSessions must not try to
      // terminate it (which would throw "still being created").
      MockedSession.mockImplementationOnce(function (this: unknown, sessionId: string) {
        const mock = makeMockSession(sessionId);
        mock.start.mockReturnValue(new Promise<void>(() => {})); // never resolves
        created.push(mock);
        return mock as unknown as InteractiveSession;
      } as unknown as (sessionId: string) => InteractiveSession);
      void manager.createSession({ sessionId: "pending" });

      await expect(manager.terminateAllSessions()).resolves.toBe(0);
    });
  });

  describe("inspectSession & getSessionHistory", () => {
    it("inspectSession delegates to getDetailedMetrics", async () => {
      await manager.createSession({ sessionId: "s1" });
      const metrics = await manager.inspectSession("s1");
      expect(created[0]!.getDetailedMetrics).toHaveBeenCalledOnce();
      expect(metrics.sessionId).toBe("s1");
    });

    it("getSessionHistory forwards limit and search", async () => {
      await manager.createSession({ sessionId: "s1" });
      await manager.getSessionHistory("s1", 5, "report");
      expect(created[0]!.getCommandHistory).toHaveBeenCalledWith(5, "report");
    });
  });

  describe("sessionMetrics", () => {
    it("aggregates per-session metrics", async () => {
      await manager.createSession({ sessionId: "s1" });
      await manager.createSession({ sessionId: "s2" });
      const metrics = await manager.sessionMetrics();
      expect(metrics.manager.totalSessions).toBe(2);
      expect(metrics.manager.activeSessions).toBe(2);
      expect(metrics.aggregate.totalCommands).toBe(6); // 3 per mock session
      expect(metrics.sessions).toHaveLength(2);
    });
  });

  describe("cleanupIdleSessions", () => {
    it("terminates idle sessions and leaves active ones", async () => {
      await manager.createSession({ sessionId: "idle" });
      await manager.createSession({ sessionId: "busy" });
      created[0]!.isIdleTimeout.mockReturnValue(true); // "idle"
      created[1]!.isIdleTimeout.mockReturnValue(false); // "busy"

      const cleaned = await manager.cleanupIdleSessions(300, true);
      expect(cleaned).toBe(1);
      expect(manager.getSessionCount()).toBe(1);
    });
  });

  describe("_getSession behaviour via public methods", () => {
    it("getSessionInfo throws SessionNotFoundError for an unknown id", async () => {
      await expect(manager.getSessionInfo("ghost")).rejects.toBeInstanceOf(SessionNotFoundError);
    });

    it("throws SessionError when the session is still being created", async () => {
      MockedSession.mockImplementationOnce(function (this: unknown, sessionId: string) {
        const mock = makeMockSession(sessionId);
        mock.start.mockReturnValue(new Promise<void>(() => {})); // never resolves
        created.push(mock);
        return mock as unknown as InteractiveSession;
      } as unknown as (sessionId: string) => InteractiveSession);
      void manager.createSession({ sessionId: "pending" });
      // Flush microtasks so createSession's exclusive callback runs far enough
      // to set the null placeholder before start()'s never-resolving promise
      // parks it — cleanupLock.runExclusive and _cleanupTerminatedSessions
      // each add an await hop.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      await expect(manager.executeCommand("pending", "version")).rejects.toThrow(/still being created/);
    });
  });

  describe("replayCommand, filterSessionOutput, setSessionTimeout", () => {
    it("replayCommand delegates to the session", async () => {
      await manager.createSession({ sessionId: "s1" });
      const output = await manager.replayCommand("s1", 3);
      expect(created[0]!.replayCommand).toHaveBeenCalledWith(3);
      expect(output).toBe("replayed output");
    });

    it("filterSessionOutput delegates to the session with the maxLines default", async () => {
      await manager.createSession({ sessionId: "s1" });
      const lines = await manager.filterSessionOutput("s1", "ERROR");
      expect(created[0]!.filterOutput).toHaveBeenCalledWith("ERROR", 1000);
      expect(lines).toEqual(["matched line"]);
    });

    it("setSessionTimeout delegates to the session", async () => {
      await manager.createSession({ sessionId: "s1" });
      await manager.setSessionTimeout("s1", 120);
      expect(created[0]!.setSessionTimeout).toHaveBeenCalledWith(120);
    });
  });

  describe("createSession bufferSize forwarding", () => {
    it("forwards an explicit positive bufferSize as-is", async () => {
      await manager.createSession({ sessionId: "s1", bufferSize: 4096 });
      expect(MockedSession).toHaveBeenCalledWith("s1", 4096);
    });
  });

  describe("executeCommand timeout forwarding", () => {
    it("forwards an explicit positive timeoutMs as-is", async () => {
      await manager.createSession({ sessionId: "s1" });
      await manager.executeCommand("s1", "report_wns", 5000);
      expect(created[0]!.runCommand).toHaveBeenCalledWith("report_wns", 5000);
    });
  });

  describe("listSessions error handling", () => {
    it("skips a session whose getInfo() rejects and still returns the rest", async () => {
      await manager.createSession({ sessionId: "s1" });
      await manager.createSession({ sessionId: "s2" });
      created[0]!.getInfo.mockRejectedValueOnce(new Error("boom"));

      const infos = await manager.listSessions();
      expect(infos.map((i) => i.sessionId)).toEqual(["s2"]);
    });
  });

  describe("sessionMetrics edge cases", () => {
    it("skips a session whose getDetailedMetrics() rejects and still aggregates the rest", async () => {
      await manager.createSession({ sessionId: "s1" });
      await manager.createSession({ sessionId: "s2" });
      created[0]!.getDetailedMetrics.mockRejectedValueOnce(new Error("boom"));

      const metrics = await manager.sessionMetrics();
      expect(metrics.sessions).toHaveLength(1);
      expect(metrics.sessions[0]!.sessionId).toBe("s2");
    });

    it("reports zero utilization when maxSessions is 0", async () => {
      const zeroCapacity = new OpenROADManager(0);
      const metrics = await zeroCapacity.sessionMetrics();
      expect(metrics.manager.utilizationPercent).toBe(0);
    });

    it("reports zero average memory when there are no active sessions", async () => {
      const metrics = await manager.sessionMetrics();
      expect(metrics.aggregate.avgMemoryPerSession).toBe(0);
    });
  });

  describe("cleanupIdleSessions error handling", () => {
    it("logs and continues when isIdleTimeout() throws for one session", async () => {
      await manager.createSession({ sessionId: "s1" });
      await manager.createSession({ sessionId: "s2" });
      created[0]!.isIdleTimeout.mockImplementationOnce(() => {
        throw new Error("boom");
      });
      created[1]!.isIdleTimeout.mockReturnValue(true);

      const cleaned = await manager.cleanupIdleSessions(300, true);
      expect(cleaned).toBe(1);
      expect(manager.getSessionCount()).toBe(1);
    });
  });

  describe("cleanupAll", () => {
    it("force-terminates every session", async () => {
      await manager.createSession({ sessionId: "s1" });
      await manager.cleanupAll();
      expect(created[0]!.terminate).toHaveBeenCalledWith(true);
      expect(manager.getSessionCount()).toBe(0);
    });
  });

  describe("_cleanupTerminatedSessions via listSessions", () => {
    it("cleans up a recently-dead session without force", async () => {
      await manager.createSession({ sessionId: "s1" });
      created[0]!.checkAlive.mockReturnValue(false);
      created[0]!.lastActivity = new Date();

      const infos = await manager.listSessions();
      expect(infos).toHaveLength(0);
      expect(created[0]!.cleanup).toHaveBeenCalledOnce();
      expect(manager.getSessionCount()).toBe(0);
    });

    it("force-cleans a session dead long past the grace period, keyed off terminatedAt", async () => {
      await manager.createSession({ sessionId: "s1" });
      created[0]!.checkAlive.mockReturnValue(false);
      created[0]!.terminatedAt = new Date(Date.now() - 120_000); // 120s > 60s threshold

      const infos = await manager.listSessions();
      expect(infos).toHaveLength(0);
      expect(created[0]!.cleanup).toHaveBeenCalledOnce();
      expect(manager.getSessionCount()).toBe(0);
    });

    it("still removes the session if a non-force cleanup() rejects", async () => {
      await manager.createSession({ sessionId: "s1" });
      created[0]!.checkAlive.mockReturnValue(false);
      created[0]!.lastActivity = new Date();
      created[0]!.cleanup.mockRejectedValueOnce(new Error("cleanup boom"));

      const infos = await manager.listSessions();
      expect(infos).toHaveLength(0);
      expect(manager.getSessionCount()).toBe(0);
    });

    it("still removes the session if a force cleanup() rejects", async () => {
      await manager.createSession({ sessionId: "s1" });
      created[0]!.checkAlive.mockReturnValue(false);
      created[0]!.terminatedAt = new Date(Date.now() - 120_000);
      created[0]!.cleanup.mockRejectedValueOnce(new Error("force cleanup boom"));

      const infos = await manager.listSessions();
      expect(infos).toHaveLength(0);
      expect(manager.getSessionCount()).toBe(0);
    });
  });
});
