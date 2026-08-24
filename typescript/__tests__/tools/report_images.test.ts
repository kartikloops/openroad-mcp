import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import {
  classifyImageType,
  ListReportImagesTool,
  ReadReportImageTool,
  validatePlatformDesign,
} from "../../src/tools/report_images.js";
import type { OpenROADManager } from "../../src/core/manager.js";

// Mock getSettings so tests do not depend on a filesystem ORFS install.
vi.mock("../../src/config/settings.js", () => {
  let mockFlowPath = "/mock/flow";
  let mockPlatforms: string[] = [];
  let mockDesigns: Record<string, string[]> = {};
  return {
    getSettings: vi.fn(() => ({
      get flowPath() { return mockFlowPath; },
      get platforms() { return mockPlatforms; },
      designs(platform: string) { return mockDesigns[platform] ?? []; },
      WHITELIST_ENABLED: false,
      LOG_LEVEL: "INFO",
      COMMAND_TIMEOUT: 30,
      COMMAND_COMPLETION_DELAY: 0.1,
      DEFAULT_BUFFER_SIZE: 131072,
      MAX_SESSIONS: 50,
      SESSION_QUEUE_SIZE: 128,
      SESSION_IDLE_TIMEOUT: 300,
      READ_CHUNK_SIZE: 8192,
      LOG_FORMAT: "",
      ALLOWED_COMMANDS: ["openroad"],
      ENABLE_COMMAND_VALIDATION: true,
      ORFS_FLOW_PATH: "/mock/flow",
    })),
    __setMock(fp: string, plats: string[], des: Record<string, string[]>) {
      mockFlowPath = fp;
      mockPlatforms = plats;
      mockDesigns = des;
    },
  };
});

import { getSettings } from "../../src/config/settings.js";

let tmpDir: string;

function createFixture(
  platform = "nangate45",
  design = "gcd",
  runSlug = "run-123",
  imageFiles: string[] = ["cts_clk.webp", "final_all.webp"],
) {
  const flowPath = tmpDir;
  fs.mkdirSync(path.join(flowPath, "platforms", platform), { recursive: true });
  fs.mkdirSync(path.join(flowPath, "designs", platform, design), { recursive: true });
  const runPath = path.join(flowPath, "reports", platform, design, runSlug);
  fs.mkdirSync(runPath, { recursive: true });
  for (const img of imageFiles) {
    fs.writeFileSync(path.join(runPath, img), Buffer.from("RIFF\x00\x00\x00\x00WEBP"));
  }
  return { flowPath, runPath };
}

// Constructor requires a manager but the tools never invoke it.
const stubManager = {} as unknown as OpenROADManager;

/** Writes a real, sharp-parseable .webp file so metadata()/resize() succeed. */
async function writeRealWebp(filePath: string, width: number, height: number): Promise<void> {
  const buffer = await sharp({
    create: { width, height, channels: 3, background: { r: 100, g: 150, b: 200 } },
  })
    .webp()
    .toBuffer();
  fs.writeFileSync(filePath, buffer);
}

/**
 * Writes a noisy .webp, whose encoded size actually tracks its resolution.
 * A flat-colour image compresses to a few KB at any size, so it cannot
 * exercise the size-budget ladder.
 */
async function writeNoisyWebp(filePath: string, width: number, height: number): Promise<void> {
  const pixels = Buffer.allocUnsafe(width * height * 3);
  for (let i = 0; i < pixels.length; i += 1) pixels[i] = (i * 2654435761) % 256;
  const buffer = await sharp(pixels, { raw: { width, height, channels: 3 } })
    .webp({ quality: 100 })
    .toBuffer();
  fs.writeFileSync(filePath, buffer);
}

/** Writes a real PNG, for the `.webp.png` files some ORFS builds emit. */
async function writeRealPng(filePath: string, width: number, height: number): Promise<void> {
  const buffer = await sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png()
    .toBuffer();
  fs.writeFileSync(filePath, buffer);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openroad-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("classifyImageType", () => {
  it("classifies CTS images correctly", () => {
    expect(classifyImageType("cts_clk.webp")).toEqual(["cts", "clock_visualization"]);
    expect(classifyImageType("cts_clk_layout.webp")).toEqual(["cts", "clock_layout"]);
    expect(classifyImageType("cts_core_clock.webp")).toEqual(["cts", "core_clock_visualization"]);
  });

  it("classifies final stage images correctly", () => {
    expect(classifyImageType("final_all.webp")).toEqual(["final", "complete_design"]);
    expect(classifyImageType("final_congestion.webp")).toEqual(["final", "congestion_heatmap"]);
    expect(classifyImageType("final_ir_drop.webp")).toEqual(["final", "ir_drop_analysis"]);
  });

  it("returns unknown for unrecognised filenames", () => {
    expect(classifyImageType("unknown_image.webp")).toEqual(["unknown", "unknown"]);
    expect(classifyImageType("foo.webp")).toEqual(["unknown", "unknown"]);
  });

  it("returns unknown stage when filename has no underscore", () => {
    const [stage, _type] = classifyImageType("nounderscore.webp");
    expect(stage).toBe("unknown");
  });

  it("classifies the doubled .webp.png extension some ORFS builds emit", () => {
    expect(classifyImageType("final_all.webp.png")).toEqual(["final", "complete_design"]);
    expect(classifyImageType("final_routing.webp.png")).toEqual(["final", "routing_visualization"]);
    expect(classifyImageType("cts_clk.png")).toEqual(["cts", "clock_visualization"]);
  });
});

describe("validatePlatformDesign", () => {
  it("throws on unknown platform", () => {
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      platforms: ["nangate45"],
      designs: () => ["gcd"],
      flowPath: tmpDir,
    });
    expect(() => validatePlatformDesign("bad_platform", "gcd")).toThrow();
  });

  it("throws on unknown design", () => {
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      platforms: ["nangate45"],
      designs: (p: string) => (p === "nangate45" ? ["gcd"] : []),
      flowPath: tmpDir,
    });
    expect(() => validatePlatformDesign("nangate45", "bad_design")).toThrow();
  });
});

describe("ListReportImagesTool", () => {
  let tool: ListReportImagesTool;

  beforeEach(() => {
    tool = new ListReportImagesTool(stubManager);
  });

  it("returns error when platform is invalid", async () => {
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      platforms: [],
      designs: () => [],
      flowPath: tmpDir,
    });
    const raw = await tool.execute("bad_platform", "gcd", "run-123");
    const result = JSON.parse(raw);
    expect(result.error).toBeTruthy();
  });

  it("returns RunNotFound error when run directory does not exist", async () => {
    const { flowPath } = createFixture();
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      platforms: ["nangate45"],
      designs: (p: string) => (p === "nangate45" ? ["gcd"] : []),
      flowPath,
      WHITELIST_ENABLED: false,
    });
    const raw = await tool.execute("nangate45", "gcd", "nonexistent");
    const result = JSON.parse(raw);
    expect(result.error).toBe("RunNotFound");
  });

  it("returns totalImages 0 when run directory has no .webp files", async () => {
    const { flowPath } = createFixture("nangate45", "gcd", "run-empty", []);
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      platforms: ["nangate45"],
      designs: (p: string) => (p === "nangate45" ? ["gcd"] : []),
      flowPath,
      WHITELIST_ENABLED: false,
    });
    const raw = await tool.execute("nangate45", "gcd", "run-empty");
    const result = JSON.parse(raw);
    expect(result.total_images).toBe(0);
    expect(result.images_by_stage).toEqual({});
  });

  it("finds images written with the doubled .webp.png extension", async () => {
    // The naming a real ORFS build produced; matching only ".webp" reported
    // zero images for a directory that was full of them.
    const { flowPath } = createFixture("nangate45", "gcd", "run-123", [
      "final_all.webp.png",
      "final_routing.webp.png",
      "cts_clk.webp",
    ]);
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      platforms: ["nangate45"],
      designs: (p: string) => (p === "nangate45" ? ["gcd"] : []),
      flowPath,
      WHITELIST_ENABLED: false,
    });
    const raw = await tool.execute("nangate45", "gcd", "run-123");
    const result = JSON.parse(raw);
    expect(result.total_images).toBe(3);
    expect(result.images_by_stage["final"]).toHaveLength(2);
    expect(result.images_by_stage["cts"]).toHaveLength(1);
    expect(result.images_by_stage["final"][0].type).toBe("complete_design");
  });

  it("explains an empty result when the directory holds unrecognised image files", async () => {
    const { flowPath, runPath } = createFixture("nangate45", "gcd", "run-odd", []);
    fs.writeFileSync(path.join(runPath, "layout.tiff"), Buffer.from("x"));
    fs.writeFileSync(path.join(runPath, "shot.jpeg"), Buffer.from("x"));
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      platforms: ["nangate45"],
      designs: (p: string) => (p === "nangate45" ? ["gcd"] : []),
      flowPath,
      WHITELIST_ENABLED: false,
    });
    const raw = await tool.execute("nangate45", "gcd", "run-odd");
    const result = JSON.parse(raw);
    expect(result.total_images).toBe(0);
    // A bare zero cannot distinguish "no images" from "tool did not match them".
    expect(result.message).toMatch(/do not match the expected extensions/);
    expect(result.message).toContain("shot.jpeg");
  });

  it("lists all .webp files grouped by stage", async () => {
    const { flowPath } = createFixture();
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      platforms: ["nangate45"],
      designs: (p: string) => (p === "nangate45" ? ["gcd"] : []),
      flowPath,
      WHITELIST_ENABLED: false,
    });
    const raw = await tool.execute("nangate45", "gcd", "run-123");
    const result = JSON.parse(raw);
    expect(result.total_images).toBe(2);
    expect(result.images_by_stage).toBeTruthy();
    expect(result.images_by_stage).toHaveProperty("cts");
    expect(result.images_by_stage).toHaveProperty("final");
  });

  it("does not descend symlinked directories or list symlinked files", async () => {
    const { flowPath, runPath } = createFixture("nangate45", "gcd", "run-123", [
      "cts_clk.webp",
    ]);
    // A directory of images outside the run, reachable only via symlinks.
    const outside = path.join(tmpDir, "outside");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "final_all.webp"), Buffer.from("RIFF\x00\x00\x00\x00WEBP"));
    try {
      fs.symlinkSync(outside, path.join(runPath, "linkdir"));
      fs.symlinkSync(path.join(outside, "final_all.webp"), path.join(runPath, "linkfile.webp"));
    } catch {
      // symlink creation may fail in some environments; skip gracefully.
      return;
    }
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      platforms: ["nangate45"],
      designs: (p: string) => (p === "nangate45" ? ["gcd"] : []),
      flowPath,
      WHITELIST_ENABLED: false,
    });
    const result = JSON.parse(await tool.execute("nangate45", "gcd", "run-123"));
    // Only the real cts_clk.webp is found; nothing reached through a symlink.
    expect(result.total_images).toBe(1);
    expect(result.images_by_stage).toHaveProperty("cts");
    expect(result.images_by_stage).not.toHaveProperty("final");
  });

  it("filters images by stage", async () => {
    const { flowPath } = createFixture("nangate45", "gcd", "run-123", [
      "cts_clk.webp",
      "final_all.webp",
    ]);
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      platforms: ["nangate45"],
      designs: (p: string) => (p === "nangate45" ? ["gcd"] : []),
      flowPath,
      WHITELIST_ENABLED: false,
    });
    const raw = await tool.execute("nangate45", "gcd", "run-123", "cts");
    const result = JSON.parse(raw);
    expect(result.total_images).toBe(1);
    expect(result.images_by_stage).toHaveProperty("cts");
    expect(result.images_by_stage).not.toHaveProperty("final");
  });
});

describe("ReadReportImageTool", () => {
  let tool: ReadReportImageTool;

  beforeEach(() => {
    tool = new ReadReportImageTool(stubManager);
  });

  it("returns error when platform is invalid", async () => {
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      platforms: [],
      designs: () => [],
      flowPath: tmpDir,
    });
    const raw = await tool.execute("bad_platform", "gcd", "run-123", "cts_clk.webp");
    const result = JSON.parse(raw);
    expect(result.error).toBeTruthy();
    expect(result.image_data).toBeNull();
  });

  it("returns RunNotFound when run directory does not exist", async () => {
    const { flowPath } = createFixture();
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      platforms: ["nangate45"],
      designs: (p: string) => (p === "nangate45" ? ["gcd"] : []),
      flowPath,
      WHITELIST_ENABLED: false,
    });
    const raw = await tool.execute("nangate45", "gcd", "missing-run", "cts_clk.webp");
    const result = JSON.parse(raw);
    expect(result.error).toBe("RunNotFound");
  });

  it("returns ImageNotFound when image does not exist", async () => {
    const { flowPath } = createFixture();
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      platforms: ["nangate45"],
      designs: (p: string) => (p === "nangate45" ? ["gcd"] : []),
      flowPath,
      WHITELIST_ENABLED: false,
    });
    const raw = await tool.execute("nangate45", "gcd", "run-123", "missing.webp");
    const result = JSON.parse(raw);
    expect(result.error).toBe("ImageNotFound");
  });

  it("reads and base64-encodes a .webp image successfully", async () => {
    const { flowPath } = createFixture("nangate45", "gcd", "run-123", ["cts_clk.webp"]);
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      platforms: ["nangate45"],
      designs: (p: string) => (p === "nangate45" ? ["gcd"] : []),
      flowPath,
      WHITELIST_ENABLED: false,
    });
    const raw = await tool.execute("nangate45", "gcd", "run-123", "cts_clk.webp");
    const result = JSON.parse(raw);
    expect(typeof result.image_data).toBe("string");
    expect(result.image_data.length).toBeGreaterThan(0);
    const decoded = Buffer.from(result.image_data, "base64");
    expect(decoded.length).toBeGreaterThan(0);
    expect(result.metadata).toBeTruthy();
    expect(result.metadata.filename).toBe("cts_clk.webp");
    expect(result.metadata.stage).toBe("cts");
    expect(result.metadata.type).toBe("clock_visualization");
    expect(result.metadata.format).toBe("webp");
  });

  it("reports the real format of a .webp.png, which is returned as PNG bytes", async () => {
    const { flowPath, runPath } = createFixture("nangate45", "gcd", "run-123", []);
    // Small enough to skip compression, so the bytes are the file's own.
    await writeRealPng(path.join(runPath, "final_all.webp.png"), 4, 4);
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      platforms: ["nangate45"],
      designs: (p: string) => (p === "nangate45" ? ["gcd"] : []),
      flowPath,
      WHITELIST_ENABLED: false,
    });

    const result = JSON.parse(await tool.execute("nangate45", "gcd", "run-123", "final_all.webp.png"));

    // The declared format has to match the bytes: a consumer that trusts it
    // instead of sniffing the header would otherwise fail to decode.
    const decoded = Buffer.from(result.image_data, "base64");
    expect(decoded.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(result.metadata.format).toBe("png");
  });

  it("returns FileTooLarge error when image exceeds 50 MB", async () => {
    const { flowPath, runPath } = createFixture("nangate45", "gcd", "run-123", []);
    const bigPath = path.join(runPath, "huge.webp");
    fs.writeFileSync(bigPath, Buffer.from("tiny content"));
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      platforms: ["nangate45"],
      designs: (p: string) => (p === "nangate45" ? ["gcd"] : []),
      flowPath,
      WHITELIST_ENABLED: false,
    });
    const originalStatSync = fs.statSync.bind(fs);
    const statSpy = vi.spyOn(fs, "statSync").mockImplementation((p) => {
      if (p === bigPath) return { size: 51 * 1024 * 1024, isFile: () => true, mtime: new Date() } as unknown as fs.Stats;
      return originalStatSync(p) as fs.Stats;
    });
    const raw = await tool.execute("nangate45", "gcd", "run-123", "huge.webp");
    const result = JSON.parse(raw);
    expect(result.error).toBe("FileTooLarge");
    statSpy.mockRestore();
  });

  it("rejects a non-image extension", async () => {
    const { flowPath } = createFixture();
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      platforms: ["nangate45"],
      designs: (p: string) => (p === "nangate45" ? ["gcd"] : []),
      flowPath,
      WHITELIST_ENABLED: false,
    });
    const raw = await tool.execute("nangate45", "gcd", "run-123", "cts_clk.txt");
    const result = JSON.parse(raw);
    expect(result.error).toBe("InvalidImageName");
  });
});

describe("TestPathTraversalSecurity", () => {
  let tool: ListReportImagesTool;
  let readTool: ReadReportImageTool;
  let flowPath: string;

  beforeEach(() => {
    const fixture = createFixture();
    flowPath = fixture.flowPath;
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      platforms: ["nangate45"],
      designs: (p: string) => (p === "nangate45" ? ["gcd"] : []),
      flowPath,
      WHITELIST_ENABLED: false,
    });
    tool = new ListReportImagesTool(stubManager);
    readTool = new ReadReportImageTool(stubManager);
  });

  it("rejects path traversal in run_slug (../../etc/passwd)", async () => {
    const raw = await tool.execute("nangate45", "gcd", "../../../etc/passwd");
    const result = JSON.parse(raw);
    expect(result.error).toBeTruthy();
    expect(result.error).not.toBe("RunNotFound"); // must be a validation error
  });

  it("rejects bare '..' as run_slug", async () => {
    const raw = await tool.execute("nangate45", "gcd", "..");
    const result = JSON.parse(raw);
    expect(result.error).toBeTruthy();
  });

  it("rejects glob characters in run_slug", async () => {
    const raw = await tool.execute("nangate45", "gcd", "*");
    const result = JSON.parse(raw);
    expect(result.error).toBeTruthy();
  });

  it("rejects path traversal in image_name", async () => {
    const raw = await readTool.execute("nangate45", "gcd", "run-123", "../../../etc/passwd");
    const result = JSON.parse(raw);
    expect(result.error).toBeTruthy();
  });

  it("rejects non-.webp extension in image_name", async () => {
    const raw = await readTool.execute("nangate45", "gcd", "run-123", "file.sh");
    const result = JSON.parse(raw);
    expect(result.error).toBe("InvalidImageName");
  });

  it("rejects null byte in image_name", async () => {
    const raw = await readTool.execute("nangate45", "gcd", "run-123", "evil\x00.webp");
    const result = JSON.parse(raw);
    expect(result.error).toBeTruthy();
  });

  it("blocks symlink escape from run directory", async () => {
    const runPath = path.join(flowPath, "reports", "nangate45", "gcd", "run-123");
    const linkPath = path.join(runPath, "escape.webp");
    try {
      fs.symlinkSync("/etc/passwd", linkPath);
    } catch {
      // symlink creation may fail in some environments; skip gracefully.
      return;
    }
    const raw = await readTool.execute("nangate45", "gcd", "run-123", "escape.webp");
    const result = JSON.parse(raw);
    // Should not find the image, reject path containment, or return an error
    // and must NOT return valid image_data resolving to /etc/passwd content.
    expect(result.image_data === null || result.error !== null).toBe(true);
  });
});

describe("TestPlatformDesignValidationInTools", () => {
  beforeEach(() => {
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      platforms: ["nangate45"],
      designs: (p: string) => (p === "nangate45" ? ["gcd"] : []),
      flowPath: tmpDir,
      WHITELIST_ENABLED: false,
    });
  });

  it("list tool returns error for invalid platform", async () => {
    const raw = await new ListReportImagesTool(stubManager).execute("invalid_plat", "gcd", "run-123");
    expect(JSON.parse(raw).error).toBeTruthy();
  });

  it("list tool returns error for invalid design", async () => {
    const raw = await new ListReportImagesTool(stubManager).execute("nangate45", "bad_design", "run-123");
    expect(JSON.parse(raw).error).toBeTruthy();
  });

  it("read tool returns error for invalid platform", async () => {
    const raw = await new ReadReportImageTool(stubManager).execute("invalid_plat", "gcd", "run-123", "img.webp");
    expect(JSON.parse(raw).error).toBeTruthy();
  });

  it("read tool returns error for invalid design", async () => {
    const raw = await new ReadReportImageTool(stubManager).execute("nangate45", "bad_design", "run-123", "img.webp");
    expect(JSON.parse(raw).error).toBeTruthy();
  });
});

describe("ListReportImagesTool — additional branch coverage", () => {
  it("falls back to an empty available-runs list when readdirSync fails while listing runs", async () => {
    // reportsBase must exist (so realpathSync/containment checks pass) but the
    // requested run must not — that's the only way availableRuns()'s readdirSync
    // catch (returning []) is reachable rather than short-circuiting earlier.
    const { flowPath, runPath } = createFixture();
    const reportsBase = path.dirname(runPath);
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      platforms: ["nangate45"],
      designs: (p: string) => (p === "nangate45" ? ["gcd"] : []),
      flowPath,
      WHITELIST_ENABLED: false,
    });
    const originalReaddirSync = fs.readdirSync.bind(fs);
    const readdirSpy = vi.spyOn(fs, "readdirSync").mockImplementation(((p: fs.PathLike, opts?: unknown) => {
      if (p === reportsBase) throw new Error("EACCES: permission denied");
      return originalReaddirSync(p as string, opts as never);
    }) as typeof fs.readdirSync);
    try {
      const raw = await new ListReportImagesTool(stubManager).execute("nangate45", "gcd", "nonexistent-run");
      const result = JSON.parse(raw);
      expect(result.error).toBe("RunNotFound");
      expect(result.message).toContain("none");
    } finally {
      readdirSpy.mockRestore();
    }
  });

  it("descends into real subdirectories to find nested .webp files", async () => {
    const { flowPath, runPath } = createFixture("nangate45", "gcd", "run-123", ["final_all.webp"]);
    const nested = path.join(runPath, "nested_stage");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "cts_clk.webp"), Buffer.from("RIFF\x00\x00\x00\x00WEBP"));
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      platforms: ["nangate45"],
      designs: (p: string) => (p === "nangate45" ? ["gcd"] : []),
      flowPath,
      WHITELIST_ENABLED: false,
    });
    const raw = await new ListReportImagesTool(stubManager).execute("nangate45", "gcd", "run-123");
    const result = JSON.parse(raw);
    expect(result.total_images).toBe(2);
  });

  it("sorts multiple images within the same stage bucket", async () => {
    const { flowPath } = createFixture("nangate45", "gcd", "run-123", [
      "cts_clk.webp",
      "cts_clk_layout.webp",
      "cts_core_clock.webp",
    ]);
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      platforms: ["nangate45"],
      designs: (p: string) => (p === "nangate45" ? ["gcd"] : []),
      flowPath,
      WHITELIST_ENABLED: false,
    });
    const raw = await new ListReportImagesTool(stubManager).execute("nangate45", "gcd", "run-123");
    const result = JSON.parse(raw);
    const filenames: string[] = result.images_by_stage.cts.map((i: { filename: string }) => i.filename);
    expect(filenames).toHaveLength(3);
    // Assert against localeCompare's own ordering rather than a hardcoded
    // guess — punctuation-vs-letter collation is locale-dependent.
    expect(filenames).toEqual([...filenames].sort((a, b) => a.localeCompare(b)));
  });

  it("returns UnexpectedError when resolveRunPath fails for a non-validation reason", async () => {
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      platforms: ["nangate45"],
      designs: () => {
        throw new Error("settings backend unavailable");
      },
      flowPath: tmpDir,
      WHITELIST_ENABLED: false,
    });
    const raw = await new ListReportImagesTool(stubManager).execute("nangate45", "gcd", "run-123");
    const result = JSON.parse(raw);
    expect(result.error).toBe("UnexpectedError");
  });

  it("returns an empty list (not an error) when findWebpFiles throws inside an existing run dir", async () => {
    const { flowPath, runPath } = createFixture();
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      platforms: ["nangate45"],
      designs: (p: string) => (p === "nangate45" ? ["gcd"] : []),
      flowPath,
      WHITELIST_ENABLED: false,
    });
    const originalReaddirSync = fs.readdirSync.bind(fs);
    vi.spyOn(fs, "readdirSync").mockImplementation(((p: fs.PathLike, opts?: unknown) => {
      if (p === runPath) throw new Error("EACCES: permission denied");
      return originalReaddirSync(p as string, opts as never);
    }) as typeof fs.readdirSync);

    const raw = await new ListReportImagesTool(stubManager).execute("nangate45", "gcd", "run-123");
    const result = JSON.parse(raw);
    expect(result.total_images).toBe(0);
    vi.restoreAllMocks();
  });

  it("returns UnexpectedError when a later filesystem call fails unexpectedly", async () => {
    const { flowPath, runPath } = createFixture("nangate45", "gcd", "run-123", ["cts_clk.webp"]);
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      platforms: ["nangate45"],
      designs: (p: string) => (p === "nangate45" ? ["gcd"] : []),
      flowPath,
      WHITELIST_ENABLED: false,
    });
    const targetFile = path.join(runPath, "cts_clk.webp");
    const originalStatSync = fs.statSync.bind(fs);
    const statSpy = vi.spyOn(fs, "statSync").mockImplementation((p) => {
      if (p === targetFile) throw new Error("boom");
      return originalStatSync(p) as fs.Stats;
    });
    const raw = await new ListReportImagesTool(stubManager).execute("nangate45", "gcd", "run-123");
    const result = JSON.parse(raw);
    expect(result.error).toBe("UnexpectedError");
    statSpy.mockRestore();
  });
});

describe("ReadReportImageTool — additional branch coverage", () => {
  it("returns UnexpectedError when resolveRunPath fails for a non-validation reason", async () => {
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      platforms: ["nangate45"],
      designs: () => {
        throw new Error("settings backend unavailable");
      },
      flowPath: tmpDir,
      WHITELIST_ENABLED: false,
    });
    const raw = await new ReadReportImageTool(stubManager).execute("nangate45", "gcd", "run-123", "cts_clk.webp");
    const result = JSON.parse(raw);
    expect(result.error).toBe("UnexpectedError");
  });

  it("returns NotAFile when the requested name is a directory", async () => {
    const { flowPath, runPath } = createFixture("nangate45", "gcd", "run-123", []);
    fs.mkdirSync(path.join(runPath, "dir.webp"));
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      platforms: ["nangate45"],
      designs: (p: string) => (p === "nangate45" ? ["gcd"] : []),
      flowPath,
      WHITELIST_ENABLED: false,
    });
    const raw = await new ReadReportImageTool(stubManager).execute("nangate45", "gcd", "run-123", "dir.webp");
    const result = JSON.parse(raw);
    expect(result.error).toBe("NotAFile");
  });

  it("falls back to an empty available-images list when findWebpFiles throws for ImageNotFound", async () => {
    const { flowPath, runPath } = createFixture("nangate45", "gcd", "run-123", ["cts_clk.webp"]);
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      platforms: ["nangate45"],
      designs: (p: string) => (p === "nangate45" ? ["gcd"] : []),
      flowPath,
      WHITELIST_ENABLED: false,
    });
    const originalReaddirSync = fs.readdirSync.bind(fs);
    vi.spyOn(fs, "readdirSync").mockImplementation(((p: fs.PathLike, opts?: unknown) => {
      if (p === runPath) throw new Error("EACCES: permission denied");
      return originalReaddirSync(p as string, opts as never);
    }) as typeof fs.readdirSync);

    const raw = await new ReadReportImageTool(stubManager).execute("nangate45", "gcd", "run-123", "missing.webp");
    const result = JSON.parse(raw);
    expect(result.error).toBe("ImageNotFound");
    expect(result.message).toContain("none");
    vi.restoreAllMocks();
  });

  it("reads a small real .webp image without compression and reports its real dimensions", async () => {
    const { flowPath, runPath } = createFixture("nangate45", "gcd", "run-123", []);
    await writeRealWebp(path.join(runPath, "cts_clk.webp"), 4, 4);
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      platforms: ["nangate45"],
      designs: (p: string) => (p === "nangate45" ? ["gcd"] : []),
      flowPath,
      WHITELIST_ENABLED: false,
    });
    const raw = await new ReadReportImageTool(stubManager).execute("nangate45", "gcd", "run-123", "cts_clk.webp");
    const result = JSON.parse(raw);
    expect(result.error).toBeNull();
    expect(result.metadata.width).toBe(4);
    expect(result.metadata.height).toBe(4);
    expect(result.metadata.compression_applied).toBe(false);
    expect(result.metadata.compression_ratio).toBeNull();
  });

  it("compresses a large real image and reports a compression ratio", async () => {
    const { flowPath, runPath } = createFixture("nangate45", "gcd", "run-123", []);
    // 200x200 solid-color webp comfortably exceeds the 15KB base64 threshold
    // once raw, forcing the resize/compress branch.
    await writeRealWebp(path.join(runPath, "final_all.webp"), 200, 200);
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      platforms: ["nangate45"],
      designs: (p: string) => (p === "nangate45" ? ["gcd"] : []),
      flowPath,
      WHITELIST_ENABLED: false,
    });
    const originalStatSync = fs.statSync.bind(fs);
    const imagePath = path.join(runPath, "final_all.webp");
    const statSpy = vi.spyOn(fs, "statSync").mockImplementation((p) => {
      const real = originalStatSync(p) as fs.Stats;
      if (p === imagePath) {
        // Mutate in place (not a spread copy) so prototype methods like
        // isFile() survive; force the compression branch regardless of how
        // small sharp's synthetic webp actually compresses to.
        Object.defineProperty(real, "size", { value: 20 * 1024, configurable: true });
      }
      return real;
    });
    try {
      // An explicit 15 KB budget forces the resize ladder; the default budget
      // is large enough that a report image of this size passes through whole.
      const raw = await new ReadReportImageTool(stubManager).execute("nangate45", "gcd", "run-123", "final_all.webp", 15);
      const result = JSON.parse(raw);
      expect(result.error).toBeNull();
      expect(result.metadata.compression_applied).toBe(true);
      expect(result.metadata.compression_ratio).toBeGreaterThan(0);
      expect(result.metadata.original_size_bytes).toBeGreaterThan(0);
    } finally {
      statSpy.mockRestore();
    }
  });

  it("returns UnexpectedError when metadata assembly fails unexpectedly", async () => {
    const { flowPath, runPath } = createFixture("nangate45", "gcd", "run-123", ["cts_clk.webp"]);
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      platforms: ["nangate45"],
      designs: (p: string) => (p === "nangate45" ? ["gcd"] : []),
      flowPath,
      WHITELIST_ENABLED: false,
    });
    const imagePath = path.join(runPath, "cts_clk.webp");
    const originalStatSync = fs.statSync.bind(fs);
    const statSpy = vi.spyOn(fs, "statSync").mockImplementation((p) => {
      const real = originalStatSync(p) as fs.Stats;
      if (p === imagePath) {
        // Mutate in place (not a spread copy) so prototype methods like
        // isFile() survive; a corrupt mtime makes stat.mtime.toISOString()
        // throw deep inside metadata assembly, after the size/existence checks pass.
        Object.defineProperty(real, "mtime", { value: undefined, configurable: true });
      }
      return real;
    });
    try {
      const raw = await new ReadReportImageTool(stubManager).execute("nangate45", "gcd", "run-123", "cts_clk.webp");
      const result = JSON.parse(raw);
      expect(result.error).toBe("UnexpectedError");
    } finally {
      statSpy.mockRestore();
    }
  });
});

describe("ReadReportImageTool — image content blocks and size budget", () => {
  /** Mirrors the settings mock the other read tests install. */
  function mockSettings(flowPath: string): void {
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      platforms: ["nangate45"],
      designs: (p: string) => (p === "nangate45" ? ["gcd"] : []),
      flowPath,
      WHITELIST_ENABLED: false,
    });
  }

  it("returns a real image content block instead of base64 buried in text", async () => {
    // The S7 failure: read_report_image handed back a single text block of
    // 33,412 characters of JSON-wrapped base64. A vision model cannot see
    // that, and the agent that got it tried to decode it by hand and failed.
    const { flowPath, runPath } = createFixture("nangate45", "gcd", "run-123", []);
    await writeRealWebp(path.join(runPath, "final_congestion.webp"), 1099, 1099);
    mockSettings(flowPath);

    const { blocks, isError } = await new ReadReportImageTool(stubManager).executeContent(
      "nangate45",
      "gcd",
      "run-123",
      "final_congestion.webp",
    );

    expect(isError).toBe(false);
    const image = blocks.find((b) => b.type === "image");
    expect(image).toBeDefined();
    expect(image).toMatchObject({ type: "image", mimeType: "image/webp" });
    // The bytes must be real and decodable, not a description of bytes.
    const decoded = Buffer.from((image as { data: string }).data, "base64");
    expect((await sharp(decoded).metadata()).width).toBeGreaterThan(0);
  });

  it("does not repeat the payload in the accompanying text block", async () => {
    const { flowPath, runPath } = createFixture("nangate45", "gcd", "run-123", []);
    await writeRealWebp(path.join(runPath, "final_congestion.webp"), 800, 600);
    mockSettings(flowPath);

    const { blocks } = await new ReadReportImageTool(stubManager).executeContent(
      "nangate45",
      "gcd",
      "run-123",
      "final_congestion.webp",
    );

    const textBlock = blocks.find((b) => b.type === "text") as { text: string };
    const meta = JSON.parse(textBlock.text);
    expect(meta.image_data).toBeUndefined();
    expect(meta.metadata.width).toBe(800);
    expect(meta.metadata.height).toBe(600);
  });

  it("returns a lone text block and flags isError when the image is missing", async () => {
    const { flowPath } = createFixture("nangate45", "gcd", "run-123", []);
    mockSettings(flowPath);

    const { blocks, isError } = await new ReadReportImageTool(stubManager).executeContent(
      "nangate45",
      "gcd",
      "run-123",
      "nope.webp",
    );

    expect(isError).toBe(true);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe("text");
    expect(JSON.parse((blocks[0] as { text: string }).text).error).toBe("ImageNotFound");
  });

  it("keeps a heatmap at full resolution instead of collapsing it to 256x256", async () => {
    // The old one-shot scale guess drove a 1099x1099 render to the 256x256
    // floor -- a 35x reduction that makes a congestion map unreadable.
    const { flowPath, runPath } = createFixture("nangate45", "gcd", "run-123", []);
    await writeRealWebp(path.join(runPath, "final_ir_drop.webp"), 1099, 1099);
    mockSettings(flowPath);

    const result = JSON.parse(
      await new ReadReportImageTool(stubManager).execute(
        "nangate45",
        "gcd",
        "run-123",
        "final_ir_drop.webp",
      ),
    );

    expect(result.error).toBeNull();
    expect(result.metadata.width).toBe(1099);
    expect(result.metadata.height).toBe(1099);
  });

  it("sheds quality before resolution when the budget is tight", async () => {
    // The ladder used to exhaust every size at q85 before dropping to q70, so
    // a 1099px render that missed the budget at q85 came back as an 824px
    // thumbnail even though the full-size q70 encoding fit inside it. For a
    // congestion map that trade is backwards.
    const { flowPath, runPath } = createFixture("nangate45", "gcd", "run-123", []);
    await writeNoisyWebp(path.join(runPath, "final_congestion.webp"), 1099, 1099);
    mockSettings(flowPath);

    const result = JSON.parse(
      await new ReadReportImageTool(stubManager).execute(
        "nangate45",
        "gcd",
        "run-123",
        "final_congestion.webp",
        800,
      ),
    );

    expect(result.error).toBeNull();
    expect(result.metadata.width).toBe(1099);
    expect(result.metadata.height).toBe(1099);
  });

  it("caps the long edge at the configured maximum and preserves aspect ratio", async () => {
    const { flowPath, runPath } = createFixture("nangate45", "gcd", "run-123", []);
    await writeRealWebp(path.join(runPath, "final_all.webp"), 4000, 2000);
    mockSettings(flowPath);

    const result = JSON.parse(
      await new ReadReportImageTool(stubManager).execute(
        "nangate45",
        "gcd",
        "run-123",
        "final_all.webp",
        // A tight budget forces the ladder; aspect ratio must still hold.
        32,
      ),
    );

    expect(result.error).toBeNull();
    expect(result.metadata.width).toBeGreaterThan(result.metadata.height);
    expect(result.metadata.width / result.metadata.height).toBeCloseTo(2, 1);
    expect(result.metadata.original_width).toBe(4000);
  });

  it("honours a per-call size budget", async () => {
    const { flowPath, runPath } = createFixture("nangate45", "gcd", "run-123", []);
    await writeNoisyWebp(path.join(runPath, "final_all.webp"), 1200, 1200);
    mockSettings(flowPath);
    const tool = new ReadReportImageTool(stubManager);

    const generous = JSON.parse(
      await tool.execute("nangate45", "gcd", "run-123", "final_all.webp", 2048),
    );
    const stingy = JSON.parse(
      await tool.execute("nangate45", "gcd", "run-123", "final_all.webp", 16),
    );

    expect(stingy.metadata.size_bytes).toBeLessThan(generous.metadata.size_bytes);
    expect(stingy.metadata.width).toBeLessThan(generous.metadata.width);
    // A tight budget still must not go below the configured floor.
    expect(stingy.metadata.width).toBeGreaterThanOrEqual(512);
  });

  it("falls back to documented defaults when settings omit the image knobs", async () => {
    // Every settings stub in this file predates these fields; a missing knob
    // must not reach sharp as NaN and silently degrade to raw bytes.
    const { flowPath, runPath } = createFixture("nangate45", "gcd", "run-123", []);
    await writeRealWebp(path.join(runPath, "final_all.webp"), 3000, 3000);
    mockSettings(flowPath);

    const result = JSON.parse(
      await new ReadReportImageTool(stubManager).execute(
        "nangate45",
        "gcd",
        "run-123",
        "final_all.webp",
      ),
    );

    expect(result.error).toBeNull();
    expect(result.metadata.width).toBeGreaterThanOrEqual(512);
    expect(result.metadata.width).toBeLessThanOrEqual(1568);
  });
});
