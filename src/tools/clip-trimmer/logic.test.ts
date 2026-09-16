import { describe, expect, it } from "vitest";
import {
  summarizeSession,
  upsertSessionResult,
  type SessionResult,
} from "./logic";

describe("clip-trimmer session helpers", () => {
  it("upserts by path keeping the latest action", () => {
    const first: SessionResult = {
      path: "a.mp4",
      action: "failed",
      detail: "boom",
    };
    const second: SessionResult = {
      path: "a.mp4",
      action: "trimmed",
      outputPath: "a-trimmed.mp4",
    };
    const results = upsertSessionResult(
      upsertSessionResult([], first),
      second,
    );
    expect(results).toEqual([second]);
  });

  it("summarizes trimmed, deleted, failed, and remaining", () => {
    const results: SessionResult[] = [
      { path: "a.mp4", action: "trimmed" },
      { path: "b.mp4", action: "deleted" },
      { path: "c.mp4", action: "failed", detail: "nope" },
    ];
    expect(summarizeSession(results, 2)).toBe(
      "1 trimmed, 1 deleted, 1 failed, 2 remaining.",
    );
  });

  it("reports no clips when empty", () => {
    expect(summarizeSession([], 0)).toBe("No clips processed.");
  });
});
