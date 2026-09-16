import {
  PDFDocument,
  degrees,
  rgb,
  type PDFPage,
} from "pdf-lib";
import type { PageFitMode, ResizeAnchor } from "./logic";
import { scalePercentToFactor } from "./logic";

export async function loadPdfLib(bytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(bytes, { ignoreEncryption: false });
}

export async function reorderPages(
  bytes: Uint8Array,
  order: number[],
): Promise<Uint8Array> {
  const src = await loadPdfLib(bytes);
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, order);
  for (const page of pages) out.addPage(page);
  return out.save();
}

export async function rotatePages(
  bytes: Uint8Array,
  pageIndices: number[],
  deltaDegrees: number,
): Promise<Uint8Array> {
  const doc = await loadPdfLib(bytes);
  const pages = doc.getPages();
  for (const index of pageIndices) {
    const page = pages[index];
    if (!page) continue;
    const current = page.getRotation().angle;
    const next = ((current + deltaDegrees) % 360 + 360) % 360;
    page.setRotation(degrees(next));
  }
  return doc.save();
}

export async function deletePages(
  bytes: Uint8Array,
  pageIndicesToDelete: number[],
): Promise<Uint8Array> {
  const doc = await loadPdfLib(bytes);
  const toDelete = [...new Set(pageIndicesToDelete)].sort((a, b) => b - a);
  if (toDelete.length >= doc.getPageCount()) {
    throw new Error("Cannot delete all pages");
  }
  for (const index of toDelete) {
    doc.removePage(index);
  }
  return doc.save();
}

export async function extractPages(
  bytes: Uint8Array,
  pageIndices: number[],
): Promise<Uint8Array> {
  if (pageIndices.length === 0) throw new Error("No pages selected");
  const src = await loadPdfLib(bytes);
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, pageIndices);
  for (const page of pages) out.addPage(page);
  return out.save();
}

export async function insertBlankPage(
  bytes: Uint8Array,
  atIndex: number,
  width?: number,
  height?: number,
): Promise<Uint8Array> {
  const doc = await loadPdfLib(bytes);
  const pages = doc.getPages();
  const ref = pages[Math.min(atIndex, Math.max(0, pages.length - 1))];
  const w = width ?? ref?.getWidth() ?? 612;
  const h = height ?? ref?.getHeight() ?? 792;
  const page = doc.insertPage(Math.max(0, Math.min(atIndex, pages.length)), [
    w,
    h,
  ]);
  page.drawRectangle({
    x: 0,
    y: 0,
    width: w,
    height: h,
    color: rgb(1, 1, 1),
  });
  return doc.save();
}

export async function insertPagesFromPdf(
  targetBytes: Uint8Array,
  sourceBytes: Uint8Array,
  atIndex: number,
  sourceIndices?: number[],
): Promise<Uint8Array> {
  const target = await loadPdfLib(targetBytes);
  const source = await loadPdfLib(sourceBytes);
  const indices =
    sourceIndices ?? Array.from({ length: source.getPageCount() }, (_, i) => i);
  const copied = await target.copyPages(source, indices);
  let insertAt = Math.max(0, Math.min(atIndex, target.getPageCount()));
  for (const page of copied) {
    target.insertPage(insertAt, page);
    insertAt += 1;
  }
  return target.save();
}

export interface MergeEntry {
  bytes: Uint8Array;
  pageIndices: number[];
}

export async function mergePdfs(entries: MergeEntry[]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  for (const entry of entries) {
    if (entry.pageIndices.length === 0) continue;
    const src = await loadPdfLib(entry.bytes);
    const pages = await out.copyPages(src, entry.pageIndices);
    for (const page of pages) out.addPage(page);
  }
  if (out.getPageCount() === 0) throw new Error("Merge produced no pages");
  return out.save();
}

function embedImage(
  doc: PDFDocument,
  bytes: Uint8Array,
  mimeHint: string,
): Promise<Awaited<ReturnType<PDFDocument["embedPng"]>>> {
  const lower = mimeHint.toLowerCase();
  if (lower.includes("png") || lower.endsWith(".png")) {
    return doc.embedPng(bytes);
  }
  if (
    lower.includes("jpg") ||
    lower.includes("jpeg") ||
    lower.endsWith(".jpg") ||
    lower.endsWith(".jpeg")
  ) {
    return doc.embedJpg(bytes);
  }
  // Try PNG then JPEG for webp/bmp/gif — caller should convert those first
  return doc.embedPng(bytes).catch(() => doc.embedJpg(bytes));
}

export interface ImagePageInput {
  bytes: Uint8Array;
  mimeOrExt: string;
}

/**
 * Build a PDF from images.
 * - original: page size = image size
 * - fit: letter page, image scaled to fit inside
 * - fill: letter page, image scaled to cover (may crop via clip)
 * When uniform is true, all pages use the first page's size (or letter for fit/fill).
 */
export async function imagesToPdf(
  images: ImagePageInput[],
  fitMode: PageFitMode,
  uniform: boolean,
): Promise<Uint8Array> {
  if (images.length === 0) throw new Error("No images");
  const doc = await PDFDocument.create();
  const LETTER: [number, number] = [612, 792];

  type Embedded = {
    width: number;
    height: number;
    draw: (page: PDFPage, x: number, y: number, w: number, h: number) => void;
  };

  const embedded: Embedded[] = [];
  for (const img of images) {
    const image = await embedImage(doc, img.bytes, img.mimeOrExt);
    embedded.push({
      width: image.width,
      height: image.height,
      draw: (page, x, y, w, h) => {
        page.drawImage(image, { x, y, width: w, height: h });
      },
    });
  }

  const first = embedded[0];
  const uniformSize: [number, number] =
    fitMode === "original"
      ? [first.width, first.height]
      : LETTER;

  for (const image of embedded) {
    let pageWidth: number;
    let pageHeight: number;

    if (fitMode === "original") {
      if (uniform) {
        pageWidth = uniformSize[0];
        pageHeight = uniformSize[1];
      } else {
        pageWidth = image.width;
        pageHeight = image.height;
      }
    } else {
      pageWidth = LETTER[0];
      pageHeight = LETTER[1];
    }

    const page = doc.addPage([pageWidth, pageHeight]);

    if (fitMode === "original" && !uniform) {
      image.draw(page, 0, 0, pageWidth, pageHeight);
      continue;
    }

    const scaleX = pageWidth / image.width;
    const scaleY = pageHeight / image.height;
    const scale =
      fitMode === "fill" ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);
    const drawW = image.width * scale;
    const drawH = image.height * scale;
    const x = (pageWidth - drawW) / 2;
    const y = (pageHeight - drawH) / 2;

    if (fitMode === "fill") {
      page.drawRectangle({
        x: 0,
        y: 0,
        width: pageWidth,
        height: pageHeight,
        color: rgb(1, 1, 1),
      });
    }

    image.draw(page, x, y, drawW, drawH);
  }

  return doc.save();
}

export async function getPageCount(bytes: Uint8Array): Promise<number> {
  const doc = await loadPdfLib(bytes);
  return doc.getPageCount();
}

/** True if any page has annotations or the document has AcroForm fields. */
export async function pdfHasAnnotations(bytes: Uint8Array): Promise<boolean> {
  const doc = await loadPdfLib(bytes);
  try {
    if (doc.getForm().getFields().length > 0) return true;
  } catch {
    // No AcroForm — fall through to per-page Annots.
  }
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (annots && annots.size() > 0) return true;
  }
  return false;
}

export interface ResizePagesOptions {
  /** Scale as a percent 10–100 (not a 0–1 factor). */
  scalePercent: number;
  anchor: ResizeAnchor;
  /** When true, output page size is original × scale; position is ignored. */
  shrinkPage: boolean;
}

function drawScaledPage(
  outPage: PDFPage,
  embedded: Awaited<ReturnType<PDFDocument["embedPage"]>>,
  pageWidth: number,
  pageHeight: number,
  s: number,
  anchor: ResizeAnchor,
  shrinkPage: boolean,
): void {
  if (shrinkPage) {
    outPage.drawPage(embedded, {
      x: 0,
      y: 0,
      xScale: s,
      yScale: s,
    });
    return;
  }
  const x = anchor === "center" ? (pageWidth * (1 - s)) / 2 : 0;
  const y =
    anchor === "center" ? (pageHeight * (1 - s)) / 2 : pageHeight * (1 - s);
  outPage.drawPage(embedded, {
    x,
    y,
    xScale: s,
    yScale: s,
  });
}

/**
 * Scale every page's content via embedPage + drawPage.
 * Keep-page (default): same MediaBox size, content drawn smaller at anchor.
 * Shrink-page: new page sized to scaled content at origin.
 * Blank pages (no Contents) become blank output pages of the target size.
 * Source /Rotate is copied onto each output page.
 */
export async function resizePages(
  bytes: Uint8Array,
  options: ResizePagesOptions,
): Promise<Uint8Array> {
  const s = scalePercentToFactor(options.scalePercent);
  const src = await loadPdfLib(bytes);
  const out = await PDFDocument.create();
  const srcPages = src.getPages();

  for (const srcPage of srcPages) {
    const { width, height } = srcPage.getSize();
    const rotation = srcPage.getRotation();
    const targetWidth = options.shrinkPage ? width * s : width;
    const targetHeight = options.shrinkPage ? height * s : height;
    const outPage = out.addPage([targetWidth, targetHeight]);
    outPage.setRotation(rotation);

    if (!srcPage.node.Contents()) {
      continue;
    }

    try {
      const embedded = await out.embedPage(srcPage);
      drawScaledPage(
        outPage,
        embedded,
        width,
        height,
        s,
        options.anchor,
        options.shrinkPage,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("missing Contents")) {
        continue;
      }
      throw err;
    }
  }

  if (out.getPageCount() === 0) throw new Error("Resize produced no pages");
  return out.save();
}
