import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { OpenROADManager } from "../core/manager.js";
import {
  ImageInfo,
  ImageMetadata,
  ListImagesResult,
  ReadImageResult,
} from "../core/models.js";
import { ValidationError } from "../exceptions.js";
import {
  validatePathSegment,
  validateSafePathContainment,
} from "../utils/path_security.js";
import { getSettings } from "../config/settings.js";
import { IMAGE_DEFAULTS } from "../constants.js";
import { getLogger } from "../utils/logging.js";
import { BaseTool } from "./base.js";

const logger = getLogger("tools.report_images");

const MAX_IMAGE_SIZE_MB = 50;

/**
 * Longest-edge ladder walked when an image does not fit its byte budget.
 * Each rung is tried at descending WebP quality before the next rung down, so
 * detail is traded away gradually instead of collapsing straight to the floor.
 */
const RESIZE_LADDER_FACTOR = 0.75;
const QUALITY_LADDER = [85, 70, 55] as const;
const MAX_ENCODE_ATTEMPTS = 12;

/** An MCP content block: a real image block, or accompanying text. */
export type ContentBlock =
  | { type: "image"; data: string; mimeType: string }
  | { type: "text"; text: string };

export interface ImageContentResult {
  blocks: ContentBlock[];
  isError: boolean;
}

/**
 * Resolve the image budget, tolerating a settings object that predates these
 * fields or supplies a nonsense value. A missing knob must fall back to the
 * documented default, never propagate NaN into sharp.
 */
function resolveImageBudget(overrideKb?: number | null): {
  maxSizeKb: number;
  maxDimension: number;
  minDimension: number;
} {
  const settings = getSettings() as Partial<{
    IMAGE_MAX_BASE64_KB: number;
    IMAGE_MAX_DIMENSION: number;
    IMAGE_MIN_DIMENSION: number;
  }>;
  const positive = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;

  return {
    maxSizeKb: positive(
      overrideKb,
      positive(settings.IMAGE_MAX_BASE64_KB, IMAGE_DEFAULTS.MAX_BASE64_KB),
    ),
    maxDimension: positive(settings.IMAGE_MAX_DIMENSION, IMAGE_DEFAULTS.MAX_DIMENSION),
    minDimension: positive(settings.IMAGE_MIN_DIMENSION, IMAGE_DEFAULTS.MIN_DIMENSION),
  };
}

/** MIME type for a base64 payload, so callers can emit a real image block. */
function mimeTypeForFormat(format: string): string {
  return format === "png" ? "image/png" : "image/webp";
}

const IMAGE_TYPE_MAPPING: Record<string, string> = {
  cts_clk: "clock_visualization",
  cts_clk_layout: "clock_layout",
  cts_core_clock: "core_clock_visualization",
  cts_core_clock_layout: "core_clock_layout",
  final_all: "complete_design",
  final_clocks: "clock_routing",
  final_congestion: "congestion_heatmap",
  final_ir_drop: "ir_drop_analysis",
  final_placement: "cell_placement",
  final_resizer: "resizer_results",
  final_routing: "routing_visualization",
};

/**
 * Derive the image stage and semantic type from a filename. Returns
 * ["unknown", "unknown"] for files with no underscore or unrecognised keys.
 */
export function classifyImageType(filename: string): [string, string] {
  const basename = stripImageExtension(path.basename(filename));
  const underscoreIdx = basename.indexOf("_");
  let stage: string;
  let key: string;
  if (underscoreIdx === -1) {
    stage = "unknown";
    key = basename;
  } else {
    stage = basename.slice(0, underscoreIdx);
    key = basename;
  }
  const type = IMAGE_TYPE_MAPPING[key] ?? "unknown";
  return [stage, type];
}

export function validatePlatformDesign(platform: string, design: string): void {
  const settings = getSettings();
  const platforms = settings.platforms;
  if (!platforms.includes(platform)) {
    throw new ValidationError(
      `Platform '${platform}' not found. Available platforms: ${platforms.join(", ") || "none"}`,
    );
  }
  const designs = settings.designs(platform);
  if (!designs.includes(design)) {
    throw new ValidationError(
      `Design '${design}' not found for platform '${platform}'. Available designs: ${designs.join(", ") || "none"}`,
    );
  }
}

function resolveRunPath(
  platform: string,
  design: string,
  runSlug: string,
): [string, string] {
  validatePlatformDesign(platform, design);
  validatePathSegment(runSlug, "run_slug");
  const settings = getSettings();
  const reportsBase = path.join(settings.flowPath, "reports", platform, design);
  const runPath = path.join(reportsBase, runSlug);
  validateSafePathContainment(runPath, reportsBase, "run directory");
  return [reportsBase, runPath];
}

function availableRuns(reportsBase: string): string[] {
  try {
    return fs
      .readdirSync(reportsBase, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Report image extensions.
 *
 * ORFS does not consistently name these: depending on the build, save_images
 * writes `final_all.webp` or `final_all.webp.png` (a PNG carrying a doubled
 * extension). Matching only `.webp` silently finds nothing on the latter, so
 * accept both and let the decoder sort out the actual format.
 */
const IMAGE_EXTENSIONS = [".webp.png", ".webp", ".png"];

export function isReportImage(filename: string): boolean {
  return IMAGE_EXTENSIONS.some((ext) => filename.toLowerCase().endsWith(ext));
}

/**
 * Format of the bytes actually returned, which is not always WebP.
 *
 * Only the compression path re-encodes; images small enough to send as-is are
 * returned byte-for-byte from disk. Since `.webp.png` files really are PNG,
 * reporting a blanket "webp" would misdescribe the payload to any consumer that
 * trusts this field instead of sniffing the header.
 */
/** Strip the report-image extension, including the doubled `.webp.png` form. */
function stripImageExtension(filename: string): string {
  const lower = filename.toLowerCase();
  for (const ext of IMAGE_EXTENSIONS) {
    if (lower.endsWith(ext)) return filename.slice(0, filename.length - ext.length);
  }
  return filename;
}

function findImageFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findImageFiles(full));
    } else if (entry.isFile() && isReportImage(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

interface CompressResult {
  imageBytes: Buffer;
  compressionApplied: boolean;
  originalSize: number;
  compressedSize: number;
  originalWidth: number | null;
  originalHeight: number | null;
  width: number | null;
  height: number | null;
  /** Actual encoded format ("webp" / "png"), sniffed rather than guessed. */
  format: string;
}

/**
 * Load an image, resizing only as far as its byte budget actually requires.
 *
 * The previous implementation guessed a scale factor from the raw file size in
 * one shot (`sqrt(targetBytes / originalSize)`), which ignores that the output
 * is re-encoded as WebP. It over-shrank badly -- a 1099x1099 render landed on
 * the 256x256 floor, a 35x reduction, which is unreadable for the congestion
 * and IR-drop heatmaps these tools exist to show.
 *
 * Instead: cap the long edge at `maxDimension`, encode, and step down a
 * quality/size ladder only while the result still exceeds budget. Most images
 * now pass through at full resolution.
 */
async function loadAndCompressImage(
  imagePath: string,
  overrideMaxSizeKb?: number | null,
): Promise<CompressResult> {
  const { maxSizeKb, maxDimension, minDimension } = resolveImageBudget(overrideMaxSizeKb);
  const originalSize = fs.statSync(imagePath).size;
  // base64 inflates by 4/3, so the byte budget is 3/4 of the stated KB budget.
  const targetBytes = Math.floor((maxSizeKb * 1024 * 3) / 4);

  const rawFallback = (
    format: string,
    width: number | null = null,
    height: number | null = null,
  ): CompressResult => ({
    imageBytes: fs.readFileSync(imagePath),
    compressionApplied: false,
    originalSize,
    compressedSize: originalSize,
    originalWidth: width,
    originalHeight: height,
    width,
    height,
    format,
  });

  let meta;
  try {
    meta = await sharp(imagePath).metadata();
  } catch (e) {
    logger.warn(
      { err: e, imagePath },
      "sharp.metadata() failed; returning raw bytes with null dims",
    );
    return rawFallback(formatFromExtension(imagePath));
  }

  const origW = meta.width ?? null;
  const origH = meta.height ?? null;
  const sniffedFormat = meta.format === "png" ? "png" : "webp";

  // Already within budget and within the resolution ceiling: hand back the
  // original bytes untouched. This is the common case now that the budget is
  // measured in MB rather than 15 KB.
  const longEdge = Math.max(origW ?? 0, origH ?? 0);
  if (originalSize <= targetBytes && (longEdge === 0 || longEdge <= maxDimension)) {
    return rawFallback(sniffedFormat, origW, origH);
  }

  if (origW === null || origH === null) {
    logger.warn({ imagePath }, "Image dimensions unavailable; returning raw bytes");
    return rawFallback(sniffedFormat);
  }

  try {
    let dim = Math.min(longEdge, maxDimension);
    let best: { buf: Buffer; dim: number } | null = null;
    let attempts = 0;

    for (const quality of QUALITY_LADDER) {
      let rungDim = dim;
      for (;;) {
        if (attempts >= MAX_ENCODE_ATTEMPTS) break;
        attempts += 1;
        const buf = await sharp(imagePath)
          .resize(rungDim, rungDim, {
            fit: "inside",
            withoutEnlargement: true,
            kernel: "lanczos3",
          })
          .webp({ quality })
          .toBuffer();

        if (buf.length <= targetBytes) return await describeEncoded(buf, rungDim, quality);
        // Remember the smallest encoding produced, so a budget that nothing
        // satisfies still returns the closest image rather than raw bytes.
        if (best === null || buf.length < best.buf.length) best = { buf, dim: rungDim };
        if (rungDim <= minDimension) break;
        rungDim = Math.max(minDimension, Math.floor(rungDim * RESIZE_LADDER_FACTOR));
      }
      // Next quality rung restarts from the capped dimension.
      dim = Math.min(longEdge, maxDimension);
      if (attempts >= MAX_ENCODE_ATTEMPTS) break;
    }

    if (best === null) return rawFallback(sniffedFormat, origW, origH);
    logger.warn(
      { imagePath, maxSizeKb, resultBytes: best.buf.length },
      "Image could not be squeezed within its base64 budget; returning the smallest encoding produced",
    );
    return await describeEncoded(best.buf, best.dim, QUALITY_LADDER[QUALITY_LADDER.length - 1]!);
  } catch (e) {
    logger.warn({ err: e, imagePath }, "Image compression failed; returning raw bytes with null dims");
    return rawFallback(sniffedFormat, origW, origH);
  }

  async function describeEncoded(
    buf: Buffer,
    requestedDim: number,
    quality: number,
  ): Promise<CompressResult> {
    // Read the dimensions back off the encoded buffer: `fit: "inside"`
    // preserves aspect ratio, so the short edge is not `requestedDim`.
    let outW: number | null = requestedDim;
    let outH: number | null = requestedDim;
    try {
      const outMeta = await sharp(buf).metadata();
      outW = outMeta.width ?? requestedDim;
      outH = outMeta.height ?? requestedDim;
    } catch {
      /* fall back to the requested box */
    }
    logger.debug({ imagePath, outW, outH, quality, bytes: buf.length }, "Encoded report image");
    return {
      imageBytes: buf,
      compressionApplied: true,
      originalSize,
      compressedSize: buf.length,
      originalWidth: origW,
      originalHeight: origH,
      width: outW,
      height: outH,
      format: "webp",
    };
  }
}

/** Last-resort format guess when the bytes cannot be sniffed. */
function formatFromExtension(filename: string): string {
  return filename.toLowerCase().endsWith(".png") ? "png" : "webp";
}

/** Lists .webp report images for a specific platform/design/run. */
export class ListReportImagesTool extends BaseTool {
  constructor(manager: OpenROADManager) {
    super(manager);
  }

  async execute(
    platform: string,
    design: string,
    runSlug: string,
    stage = "all",
  ): Promise<string> {
    let reportsBase: string;
    let runPath: string;

    try {
      [reportsBase, runPath] = resolveRunPath(platform, design, runSlug);
    } catch (e) {
      if (e instanceof ValidationError) {
        return this.formatResult(
          ListImagesResult.parse({
            error: e.constructor.name,
            message: e.message,
          }) as unknown as Record<string, unknown>,
        );
      }
      return this.formatResult(
        ListImagesResult.parse({
          error: "UnexpectedError",
          message: (e as Error).message ?? String(e),
        }) as unknown as Record<string, unknown>,
      );
    }

    if (!fs.existsSync(runPath)) {
      const runs = availableRuns(reportsBase);
      return this.formatResult(
        ListImagesResult.parse({
          error: "RunNotFound",
          message: `Run directory '${runSlug}' not found. Available runs: ${runs.join(", ") || "none"}`,
        }) as unknown as Record<string, unknown>,
      );
    }

    try {
      let files: string[];
      try {
        files = findImageFiles(runPath);
      } catch {
        files = [];
      }

      if (files.length === 0) {
        // An empty result is ambiguous: no images generated, or images present
        // under a name we do not recognise. Say which, so a caller is never
        // left guessing whether the run or the tool is at fault.
        let hint = "No report images found in this run directory.";
        try {
          const others = fs
            .readdirSync(runPath, { withFileTypes: true })
            .filter((e) => e.isFile() && /\.(png|jpe?g|gif|svg|webp)$/i.test(e.name))
            .map((e) => e.name);
          if (others.length > 0) {
            hint =
              `Found ${others.length} image-like file(s) that do not match the expected ` +
              `extensions (${IMAGE_EXTENSIONS.join(", ")}): ${others.slice(0, 10).join(", ")}`;
          }
        } catch { /* directory listing is best effort */ }

        return this.formatResult(
          ListImagesResult.parse({
            runPath,
            totalImages: 0,
            imagesByStage: {},
            message: hint,
          }) as unknown as Record<string, unknown>,
        );
      }

      const imagesByStage: Record<string, unknown[]> = {};
      let total = 0;

      for (const filePath of files) {
        const filename = path.basename(filePath);
        const [fileStage, type] = classifyImageType(filename);
        if (stage !== "all" && stage !== fileStage) continue;

        const stat = fs.statSync(filePath);
        const imageInfo = ImageInfo.parse({
          filename,
          path: filePath,
          sizeBytes: stat.size,
          modifiedTime: stat.mtime.toISOString(),
          type,
        });

        const bucket = imagesByStage[fileStage] ?? [];
        bucket.push(imageInfo);
        imagesByStage[fileStage] = bucket;
        total++;
      }

      for (const key of Object.keys(imagesByStage)) {
        imagesByStage[key] = (imagesByStage[key] as Array<{ filename: string }>).sort((a, b) =>
          a.filename.localeCompare(b.filename),
        );
      }

      return this.formatResult(
        ListImagesResult.parse({
          runPath,
          totalImages: total,
          imagesByStage,
        }) as unknown as Record<string, unknown>,
      );
    } catch (e) {
      return this.formatResult(
        ListImagesResult.parse({
          error: "UnexpectedError",
          message: (e as Error).message ?? String(e),
        }) as unknown as Record<string, unknown>,
      );
    }
  }
}

/** Reads, optionally compresses, and base64-encodes a single report image. */
export class ReadReportImageTool extends BaseTool {
  constructor(manager: OpenROADManager) {
    super(manager);
  }

  /**
   * Read an image and return the legacy JSON payload, base64 included.
   *
   * `maxSizeKb` overrides the configured IMAGE_MAX_BASE64_KB budget for this
   * call, for the occasional case where a caller wants a deliberately small
   * thumbnail or a deliberately large one.
   */
  async execute(
    platform: string,
    design: string,
    runSlug: string,
    imageName: string,
    maxSizeKb?: number | null,
  ): Promise<string> {
    let reportsBase: string;
    let runPath: string;

    try {
      [reportsBase, runPath] = resolveRunPath(platform, design, runSlug);
    } catch (e) {
      if (e instanceof ValidationError) {
        return this.formatResult(
          ReadImageResult.parse({
            error: e.constructor.name,
            message: e.message,
          }) as unknown as Record<string, unknown>,
        );
      }
      return this.formatResult(
        ReadImageResult.parse({
          error: "UnexpectedError",
          message: (e as Error).message ?? String(e),
        }) as unknown as Record<string, unknown>,
      );
    }

    try {
      validatePathSegment(imageName, "image_name");
    } catch (e) {
      return this.formatResult(
        ReadImageResult.parse({
          error: (e as ValidationError).constructor.name,
          message: (e as Error).message,
        }) as unknown as Record<string, unknown>,
      );
    }

    if (!isReportImage(imageName)) {
      return this.formatResult(
        ReadImageResult.parse({
          error: "InvalidImageName",
          message: `Image '${imageName}' must end in one of: ${IMAGE_EXTENSIONS.join(", ")}`,
        }) as unknown as Record<string, unknown>,
      );
    }

    if (!fs.existsSync(runPath)) {
      const runs = availableRuns(reportsBase);
      return this.formatResult(
        ReadImageResult.parse({
          error: "RunNotFound",
          message: `Run directory '${runSlug}' not found. Available runs: ${runs.join(", ") || "none"}`,
        }) as unknown as Record<string, unknown>,
      );
    }

    const imagePath = path.join(runPath, imageName);

    try {
      validateSafePathContainment(imagePath, runPath, "image file");
    } catch (e) {
      return this.formatResult(
        ReadImageResult.parse({
          error: (e as ValidationError).constructor.name,
          message: (e as Error).message,
        }) as unknown as Record<string, unknown>,
      );
    }

    if (!fs.existsSync(imagePath)) {
      let available: string[] = [];
      try {
        available = findImageFiles(runPath).map((f: string) => path.basename(f));
      } catch {
        available = [];
      }
      return this.formatResult(
        ReadImageResult.parse({
          error: "ImageNotFound",
          message: `Image '${imageName}' not found. Available images: ${available.join(", ") || "none"}`,
        }) as unknown as Record<string, unknown>,
      );
    }

    const stat = fs.statSync(imagePath);
    if (!stat.isFile()) {
      return this.formatResult(
        ReadImageResult.parse({
          error: "NotAFile",
          message: `'${imageName}' is not a regular file`,
        }) as unknown as Record<string, unknown>,
      );
    }

    if (stat.size > MAX_IMAGE_SIZE_MB * 1024 * 1024) {
      return this.formatResult(
        ReadImageResult.parse({
          error: "FileTooLarge",
          message: `Image '${imageName}' exceeds the ${MAX_IMAGE_SIZE_MB} MB size limit`,
        }) as unknown as Record<string, unknown>,
      );
    }

    try {
      const r = await loadAndCompressImage(imagePath, maxSizeKb);
      const imageData = r.imageBytes.toString("base64");
      const [stage, type] = classifyImageType(imageName);
      const compressionRatio =
        r.compressionApplied && r.compressedSize > 0
          ? r.originalSize / r.compressedSize
          : null;

      const metadata = ImageMetadata.parse({
        filename: imageName,
        format: r.format,
        sizeBytes: r.compressedSize,
        width: r.width,
        height: r.height,
        modifiedTime: stat.mtime.toISOString(),
        stage,
        type,
        compressionApplied: r.compressionApplied,
        originalSizeBytes: r.compressionApplied ? r.originalSize : null,
        originalWidth: r.originalWidth,
        originalHeight: r.originalHeight,
        compressionRatio,
      });

      return this.formatResult(
        ReadImageResult.parse({
          imageData,
          metadata,
        }) as unknown as Record<string, unknown>,
      );
    } catch (e) {
      if (e instanceof ValidationError) {
        return this.formatResult(
          ReadImageResult.parse({
            error: e.constructor.name,
            message: e.message,
          }) as unknown as Record<string, unknown>,
        );
      }
      return this.formatResult(
        ReadImageResult.parse({
          error: "UnexpectedError",
          message: (e as Error).message ?? String(e),
        }) as unknown as Record<string, unknown>,
      );
    }
  }

  /**
   * Read an image and return it as MCP content blocks.
   *
   * The base64 payload goes in a real `image` block so a vision model can see
   * it. Returning it inside a text block -- as this tool used to -- delivered
   * 33 KB of unreadable base64 to a model that then tried, and failed, to
   * decode it by hand. The accompanying text block carries the metadata only,
   * with `image_data` stripped so the payload is not sent twice.
   */
  async executeContent(
    platform: string,
    design: string,
    runSlug: string,
    imageName: string,
    maxSizeKb?: number | null,
  ): Promise<ImageContentResult> {
    const json = await this.execute(platform, design, runSlug, imageName, maxSizeKb);

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(json) as Record<string, unknown>;
    } catch {
      return { blocks: [{ type: "text", text: json }], isError: true };
    }

    const imageData = parsed["image_data"];
    const metadata = parsed["metadata"] as { format?: string } | null | undefined;
    if (typeof imageData !== "string" || imageData.length === 0) {
      // An error result: no image to show, so the JSON is the whole answer.
      return { blocks: [{ type: "text", text: json }], isError: parsed["error"] != null };
    }

    const { image_data: _omitted, ...withoutData } = parsed as Record<string, unknown> & {
      image_data?: unknown;
    };

    return {
      blocks: [
        {
          type: "image",
          data: imageData,
          mimeType: mimeTypeForFormat(metadata?.format ?? "webp"),
        },
        { type: "text", text: JSON.stringify(withoutData) },
      ],
      isError: false,
    };
  }
}
