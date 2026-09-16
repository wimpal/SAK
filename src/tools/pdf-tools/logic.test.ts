import { describe, expect, it } from "vitest";
import {
  formatPageCountPreview,
  moveIndex,
  parsePageRanges,
  pdfOutputPath,
  resolveStemAvoidingCollision,
  sanitizeOutputStem,
} from "./logic";

describe("parsePageRanges", () => {
  it("parses all / empty as full range", () => {
    expect(parsePageRanges("all", 3)).toEqual({ indices: [0, 1, 2] });
    expect(parsePageRanges("", 2)).toEqual({ indices: [0, 1] });
  });

  it("parses singles and ranges", () => {
    expect(parsePageRanges("1-3, 7", 10)).toEqual({
      indices: [0, 1, 2, 6],
    });
    expect(parsePageRanges("5", 5)).toEqual({ indices: [4] });
  });

  it("rejects invalid ranges", () => {
    expect(parsePageRanges("3-1", 5)).toEqual({ error: "Invalid range: 3-1" });
    expect(parsePageRanges("0", 5)).toEqual({ error: "Invalid page: 0" });
    expect(parsePageRanges("9", 5)).toEqual({ error: "Invalid page: 9" });
  });
});

describe("sanitizeOutputStem / paths", () => {
  it("strips illegal chars and extensions", () => {
    expect(sanitizeOutputStem("a/b:c.pdf")).toBe("abc");
    expect(sanitizeOutputStem("photo.PNG")).toBe("photo");
  });

  it("builds pdf output next to source", () => {
    expect(pdfOutputPath("C:\\docs\\a.pdf", null, "a-edited")).toBe(
      "C:\\docs\\a-edited.pdf",
    );
  });
});

describe("resolveStemAvoidingCollision", () => {
  it("bumps when target exists", () => {
    const exists = new Map([
      ["C:\\a-edited.pdf", true],
      ["C:\\a-edited-2.pdf", true],
    ]);
    const resolved = resolveStemAvoidingCollision(
      "a-edited",
      exists,
      (s) => `C:\\${s}.pdf`,
    );
    expect(resolved).toEqual({
      stem: "a-edited-3",
      path: "C:\\a-edited-3.pdf",
      bumped: true,
    });
  });
});

describe("moveIndex / formatPageCountPreview", () => {
  it("reorders list items", () => {
    expect(moveIndex(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
  });

  it("formats preview text", () => {
    expect(formatPageCountPreview([{ label: "a", count: 3 }])).toBe(
      "3 pages",
    );
    expect(
      formatPageCountPreview([
        { label: "a", count: 2 },
        { label: "b", count: 1 },
      ]),
    ).toBe("3 pages from 2 files");
  });
});
