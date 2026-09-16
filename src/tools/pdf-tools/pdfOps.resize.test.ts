import { PDFDocument, degrees, rgb } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  clampScalePercent,
  defaultResizedStem,
  RESIZE_SCALE_PERCENT_DEFAULT,
  scalePercentToFactor,
} from "./logic";
import { loadPdfLib, resizePages } from "./pdfOps";

async function makeTestPdf(
  pageSizes: [number, number][],
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const [w, h] of pageSizes) {
    const page = doc.addPage([w, h]);
    page.drawRectangle({
      x: 0,
      y: 0,
      width: w,
      height: h,
      color: rgb(0.9, 0.9, 0.9),
    });
  }
  return doc.save();
}

describe("clampScalePercent / scalePercentToFactor", () => {
  it("clamps and rejects non-finite", () => {
    expect(clampScalePercent(50)).toBe(50);
    expect(clampScalePercent(5)).toBe(10);
    expect(clampScalePercent(200)).toBe(100);
    expect(clampScalePercent(Number.NaN)).toBeNull();
    expect(scalePercentToFactor(RESIZE_SCALE_PERCENT_DEFAULT)).toBe(0.5);
  });

  it("throws on invalid percent for factor conversion", () => {
    expect(() => scalePercentToFactor(Number.NaN)).toThrow(/Scale must be/);
  });
});

describe("defaultResizedStem", () => {
  it("appends -resized", () => {
    expect(defaultResizedStem("C:\\labels\\dhl.pdf")).toBe("dhl-resized");
  });
});

describe("resizePages", () => {
  it("keeps page size at 50% top-left", async () => {
    const input = await makeTestPdf([[612, 792]]);
    const outBytes = await resizePages(input, {
      scalePercent: 50,
      anchor: "top-left",
      shrinkPage: false,
    });
    const out = await loadPdfLib(outBytes);
    expect(out.getPageCount()).toBe(1);
    const { width, height } = out.getPage(0).getSize();
    expect(width).toBeCloseTo(612, 5);
    expect(height).toBeCloseTo(792, 5);
  });

  it("shrinks page size when shrinkPage is true", async () => {
    const input = await makeTestPdf([[612, 792]]);
    const outBytes = await resizePages(input, {
      scalePercent: 50,
      anchor: "top-left",
      shrinkPage: true,
    });
    const out = await loadPdfLib(outBytes);
    const { width, height } = out.getPage(0).getSize();
    expect(width).toBeCloseTo(306, 5);
    expect(height).toBeCloseTo(396, 5);
  });

  it("applies to all pages", async () => {
    const input = await makeTestPdf([
      [612, 792],
      [400, 600],
    ]);
    const outBytes = await resizePages(input, {
      scalePercent: 50,
      anchor: "center",
      shrinkPage: true,
    });
    const out = await loadPdfLib(outBytes);
    expect(out.getPageCount()).toBe(2);
    expect(out.getPage(0).getSize().width).toBeCloseTo(306, 5);
    expect(out.getPage(1).getSize().width).toBeCloseTo(200, 5);
  });

  it("rejects invalid scale", async () => {
    const input = await makeTestPdf([[100, 100]]);
    await expect(
      resizePages(input, {
        scalePercent: Number.NaN,
        anchor: "top-left",
        shrinkPage: false,
      }),
    ).rejects.toThrow(/Scale must be/);
  });

  it("handles a blank page without Contents", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 300]);
    const input = await doc.save();
    const outBytes = await resizePages(input, {
      scalePercent: 50,
      anchor: "top-left",
      shrinkPage: false,
    });
    const out = await loadPdfLib(outBytes);
    expect(out.getPageCount()).toBe(1);
    expect(out.getPage(0).getSize().width).toBeCloseTo(200, 5);
    expect(out.getPage(0).getSize().height).toBeCloseTo(300, 5);
  });

  it("preserves page rotation", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.drawRectangle({
      x: 10,
      y: 10,
      width: 100,
      height: 50,
      color: rgb(0.2, 0.2, 0.2),
    });
    page.setRotation(degrees(90));
    const input = await doc.save();
    const outBytes = await resizePages(input, {
      scalePercent: 50,
      anchor: "top-left",
      shrinkPage: false,
    });
    const out = await loadPdfLib(outBytes);
    expect(out.getPage(0).getRotation().angle).toBe(90);
  });
});
