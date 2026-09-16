import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { ImageFormat } from "./logic";
import { dpiToScale } from "./logic";

GlobalWorkerOptions.workerSrc = pdfWorker;

export async function loadPdfDocument(
  data: ArrayBuffer | Uint8Array,
): Promise<PDFDocumentProxy> {
  const bytes =
    data instanceof Uint8Array
      ? data
      : new Uint8Array(data);
  // pdf.js requires a transferable copy in some environments
  const loadingTask = getDocument({ data: bytes.slice() });
  return loadingTask.promise;
}

export async function renderPageToCanvas(
  page: PDFPageProxy,
  scale: number,
  canvas?: HTMLCanvasElement,
): Promise<HTMLCanvasElement> {
  const viewport = page.getViewport({ scale });
  const target = canvas ?? document.createElement("canvas");
  target.width = Math.floor(viewport.width);
  target.height = Math.floor(viewport.height);
  const ctx = target.getContext("2d");
  if (!ctx) throw new Error("Could not get canvas 2D context");
  await page.render({ canvas: target, canvasContext: ctx, viewport }).promise;
  return target;
}

export async function renderPageThumbnail(
  doc: PDFDocumentProxy,
  pageIndex0: number,
  maxEdge = 160,
): Promise<string> {
  const page = await doc.getPage(pageIndex0 + 1);
  const base = page.getViewport({ scale: 1 });
  const scale = maxEdge / Math.max(base.width, base.height);
  const canvas = await renderPageToCanvas(page, scale);
  return canvas.toDataURL("image/jpeg", 0.72);
}

export async function renderPageImageBytes(
  doc: PDFDocumentProxy,
  pageIndex0: number,
  dpi: number,
  format: ImageFormat,
  quality = 0.92,
): Promise<Uint8Array> {
  const page = await doc.getPage(pageIndex0 + 1);
  const canvas = await renderPageToCanvas(page, dpiToScale(dpi));
  const mime =
    format === "png"
      ? "image/png"
      : format === "webp"
        ? "image/webp"
        : "image/jpeg";
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Failed to encode image"))),
      mime,
      format === "png" ? undefined : quality,
    );
  });
  return new Uint8Array(await blob.arrayBuffer());
}

export type { PDFDocumentProxy, PDFPageProxy };
