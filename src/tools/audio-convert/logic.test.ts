import { describe, expect, it } from "vitest";
import {
  applyNamePattern,
  bitrateOptionsFor,
  buildPreview,
  clampBitrate,
  codecAllowedForContainer,
  defaultBitrateFor,
  defaultCodecForContainer,
  defaultCodecForExt,
  isAudioCodec,
  isRunnable,
  isVideoPath,
  outputPath,
  resolveStemAvoidingCollision,
  type MediaStreamInfo,
} from "./logic";

const mkStream = (
  index: number,
  codecType: string,
  codecName: string,
): MediaStreamInfo => ({
  index,
  codecType,
  codecName,
});

describe("audio-convert logic", () => {
  it("recognizes supported video extensions", () => {
    expect(isVideoPath("C:\\Videos\\clip.mkv")).toBe(true);
    expect(isVideoPath("C:\\Videos\\clip.MP4")).toBe(true);
    expect(isVideoPath("C:\\Videos\\notes.txt")).toBe(false);
  });

  it("defaults codec by container", () => {
    expect(defaultCodecForContainer("webm")).toBe("opus");
    expect(defaultCodecForContainer("mp4")).toBe("aac");
    expect(defaultCodecForExt("webm")).toBe("opus");
    expect(defaultCodecForExt("mkv")).toBe("aac");
    expect(isAudioCodec("aac")).toBe(true);
    expect(isAudioCodec("mp3")).toBe(false);
  });

  it("rejects AAC in WebM", () => {
    expect(codecAllowedForContainer("aac", "webm")).toBe(false);
    expect(codecAllowedForContainer("opus", "webm")).toBe(true);
    expect(codecAllowedForContainer("aac", "mp4")).toBe(true);
  });

  it("exposes bitrate presets and clamps invalid values", () => {
    expect(bitrateOptionsFor("aac")).toEqual([96, 128, 192, 256]);
    expect(bitrateOptionsFor("opus")).toEqual([64, 96, 128, 160]);
    expect(defaultBitrateFor("aac")).toBe(192);
    expect(defaultBitrateFor("opus")).toBe(128);
    expect(clampBitrate("aac", 192)).toBe(192);
    expect(clampBitrate("aac", 99)).toBe(192);
    expect(clampBitrate("opus", 64)).toBe(64);
    expect(clampBitrate("opus", 200)).toBe(128);
  });

  it("applies name patterns with stem and index tokens", () => {
    expect(applyNamePattern("{stem}-audio", "movie", 1)).toBe("movie-audio");
    expect(applyNamePattern("{stem}-{n}", "movie", 3)).toBe("movie-3");
    expect(applyNamePattern("", "movie", 2)).toBe("movie-audio");
    expect(outputPath("D:\\Media\\movie.mkv", null, "mkv", "movie-audio")).toBe(
      "D:\\Media\\movie-audio.mkv",
    );
  });

  it("bumps colliding output stems", () => {
    const source = "C:\\Videos\\clip.mp4";
    const exists = new Map([["C:\\Videos\\clip-audio.mp4", true]]);
    const result = resolveStemAvoidingCollision(
      "clip-audio",
      source,
      null,
      "mp4",
      exists,
    );
    expect(result.stem).toBe("clip-audio-2");
    expect(result.bumped).toBe(true);
  });

  it("builds ready preview rows with codec conversion hint", () => {
    const path = "C:\\Videos\\clip.mkv";
    const streams = [
      mkStream(0, "video", "h264"),
      mkStream(1, "audio", "dts"),
    ];
    const preview = buildPreview(
      [path],
      "aac",
      192,
      null,
      new Map(),
      "{stem}-audio",
      new Map([[path, streams]]),
    );

    expect(preview[0].status).toBe("ready");
    expect(preview[0].to).toBe("C:\\Videos\\clip-audio.mkv");
    expect(preview[0].warnReason).toContain("DTS");
    expect(preview[0].warnReason).toContain("AAC");
    expect(isRunnable(preview[0].status)).toBe(true);
  });

  it("flags no-audio and unsupported containers", () => {
    const noAudio = "C:\\Videos\\silent.mp4";
    const avi = "C:\\Videos\\old.avi";
    const preview = buildPreview(
      [noAudio, avi],
      "aac",
      192,
      null,
      new Map(),
      "{stem}-audio",
      new Map([
        [noAudio, [mkStream(0, "video", "h264")]],
        [avi, [mkStream(0, "video", "mpeg4"), mkStream(1, "audio", "mp3")]],
      ]),
    );

    expect(preview[0].status).toBe("no_audio");
    expect(isRunnable(preview[0].status)).toBe(false);
    expect(preview[1].status).toBe("unsupported");
  });

  it("flags AAC on WebM as incompatible", () => {
    const path = "C:\\Videos\\clip.webm";
    const preview = buildPreview(
      [path],
      "aac",
      192,
      null,
      new Map(),
      "{stem}-audio",
      new Map([
        [
          path,
          [mkStream(0, "video", "vp9"), mkStream(1, "audio", "opus")],
        ],
      ]),
    );
    expect(preview[0].status).toBe("incompatible");
    expect(isRunnable(preview[0].status)).toBe(false);
  });
});
