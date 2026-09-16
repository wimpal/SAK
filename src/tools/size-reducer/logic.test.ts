import { describe, expect, it } from "vitest";
import {
  applyNamePattern,
  buildPreview,
  canHitTarget,
  codecAllowsContainer,
  containersForCodec,
  crfFromQualityLevel,
  defaultContainerForCodec,
  estimateQualityBytes,
  estimateTargetBitrateKbps,
  isRunnable,
  isVideoCodec,
  isVideoPath,
  mbToBytes,
  MIN_VIDEO_BITRATE_KBPS,
  outputPath,
  resolveStemAvoidingCollision,
  scaleHeightForResolution,
  type MediaStreamInfo,
} from "./logic";

const mkStream = (
  index: number,
  codecType: string,
  codecName: string,
  size?: { width: number; height: number },
): MediaStreamInfo => ({
  index,
  codecType,
  codecName,
  width: size?.width,
  height: size?.height,
});

describe("size-reducer logic", () => {
  it("recognizes supported video extensions", () => {
    expect(isVideoPath("C:\\Videos\\clip.mkv")).toBe(true);
    expect(isVideoPath("C:\\Videos\\notes.txt")).toBe(false);
  });

  it("maps codecs to allowed containers (H.264 / H.265 only)", () => {
    expect(isVideoCodec("h264")).toBe(true);
    expect(isVideoCodec("vp9")).toBe(false);
    expect(containersForCodec("h264")).toEqual([
      "mp4",
      "mkv",
      "mov",
      "m4v",
      "ts",
    ]);
    expect(codecAllowsContainer("h265", "mp4")).toBe(true);
    expect(codecAllowsContainer("h265", "ts")).toBe(false);
    expect(defaultContainerForCodec("h264")).toBe("mp4");
  });

  it("maps quality slider to CRF ranges", () => {
    expect(crfFromQualityLevel("h264", 0)).toBe(28);
    expect(crfFromQualityLevel("h264", 10)).toBe(18);
    expect(crfFromQualityLevel("h265", 0)).toBe(32);
    expect(crfFromQualityLevel("h265", 10)).toBe(22);
    expect(crfFromQualityLevel("h264", 5)).toBe(23);
  });

  it("computes target bitrate from size and duration", () => {
    const targetBytes = mbToBytes(50);
    const duration = 600; // 10 minutes
    const kbps = estimateTargetBitrateKbps(targetBytes, duration);
    expect(kbps).not.toBeNull();
    // (50*1024*1024*8 / 600 - 128000) / 1000 ≈ 571
    expect(kbps!).toBe(571);
    expect(canHitTarget(targetBytes, duration)).toBe(true);
  });

  it("rejects targets that fall below the video bitrate floor", () => {
    const tiny = mbToBytes(0.1);
    const duration = 3600;
    const kbps = estimateTargetBitrateKbps(tiny, duration);
    expect(kbps === null || kbps < MIN_VIDEO_BITRATE_KBPS).toBe(true);
    expect(canHitTarget(tiny, duration)).toBe(false);
  });

  it("quality estimate shrinks as CRF increases", () => {
    const source = 100_000_000;
    const better = estimateQualityBytes(source, 18, "h264");
    const worse = estimateQualityBytes(source, 28, "h264");
    expect(worse).toBeLessThan(better);
    expect(better).toBeGreaterThan(0);
  });

  it("resolves resolution scale heights", () => {
    expect(scaleHeightForResolution("original")).toBeNull();
    expect(scaleHeightForResolution("720")).toBe(720);
  });

  it("applies name patterns with stem and index tokens", () => {
    expect(applyNamePattern("{stem}-smaller", "movie", 1)).toBe(
      "movie-smaller",
    );
    expect(applyNamePattern("{stem}-{n}", "movie", 3)).toBe("movie-3");
    expect(outputPath("D:\\Media\\movie.mkv", null, "mp4", "movie-smaller")).toBe(
      "D:\\Media\\movie-smaller.mp4",
    );
  });

  it("bumps colliding output stems", () => {
    const source = "C:\\Videos\\clip.mp4";
    const exists = new Map([["C:\\Videos\\clip-smaller.mp4", true]]);
    const result = resolveStemAvoidingCollision(
      "clip-smaller",
      source,
      null,
      "mp4",
      exists,
    );
    expect(result.stem).toBe("clip-smaller-2");
    expect(result.bumped).toBe(true);
  });

  it("builds ready preview rows with size estimates", () => {
    const path = "C:\\Videos\\clip.mkv";
    const streams = [
      mkStream(0, "video", "h264", { width: 1280, height: 720 }),
      mkStream(1, "audio", "aac"),
    ];
    const targetBytes = mbToBytes(40);
    const preview = buildPreview({
      paths: [path],
      targetContainer: "mp4",
      outputDir: null,
      existsMap: new Map(),
      namePattern: "{stem}-smaller",
      videoCodec: "h264",
      streamsByPath: new Map([[path, streams]]),
      sizesByPath: new Map([[path, mbToBytes(200)]]),
      durationsByPath: new Map([[path, 300]]),
      mode: "target",
      targetBytes,
      qualityLevel: 5,
    });

    expect(preview[0].status).toBe("ready");
    expect(preview[0].estimatedBytes).toBe(targetBytes);
    expect(isRunnable(preview[0].status)).toBe(true);
  });

  it("warns when target is larger than source", () => {
    const path = "C:\\Videos\\clip.mp4";
    const streams = [mkStream(0, "video", "h264")];
    const preview = buildPreview({
      paths: [path],
      targetContainer: "mp4",
      outputDir: null,
      existsMap: new Map(),
      namePattern: "{stem}-smaller",
      videoCodec: "h264",
      streamsByPath: new Map([[path, streams]]),
      sizesByPath: new Map([[path, mbToBytes(20)]]),
      durationsByPath: new Map([[path, 120]]),
      mode: "target",
      targetBytes: mbToBytes(50),
      qualityLevel: 5,
    });

    expect(preview[0].status).toBe("warn");
    expect(preview[0].warnReason).toMatch(/source/i);
    expect(isRunnable(preview[0].status)).toBe(true);
  });

  it("blocks rows when target bitrate is too low", () => {
    const path = "C:\\Videos\\long.mp4";
    const streams = [mkStream(0, "video", "h264")];
    const preview = buildPreview({
      paths: [path],
      targetContainer: "mp4",
      outputDir: null,
      existsMap: new Map(),
      namePattern: "{stem}-smaller",
      videoCodec: "h264",
      streamsByPath: new Map([[path, streams]]),
      sizesByPath: new Map([[path, mbToBytes(500)]]),
      durationsByPath: new Map([[path, 7200]]),
      mode: "target",
      targetBytes: mbToBytes(1),
      qualityLevel: 5,
    });

    expect(preview[0].status).toBe("incompatible");
    expect(isRunnable(preview[0].status)).toBe(false);
  });
});
