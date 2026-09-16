import { useCallback, useEffect, useRef, useState } from "react";
import {
  loadPdfDocument,
  renderPageThumbnail,
  renderPageToCanvas,
  type PDFDocumentProxy,
} from "./pdfjs";
import { basename } from "./logic";

interface PdfViewerProps {
  bytes: Uint8Array | null;
  sourcePath: string | null;
  /** When set, jump to this 0-based page (e.g. after external selection). */
  focusPage?: number;
  onPageCount?: (count: number) => void;
  onError?: (message: string) => void;
  className?: string;
}

export function PdfViewer({
  bytes,
  sourcePath,
  focusPage,
  onPageCount,
  onError,
  className = "",
}: PdfViewerProps) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [pageIndex, setPageIndex] = useState(0);
  const [zoom, setZoom] = useState(1.15);
  const [thumbs, setThumbs] = useState<(string | null)[]>([]);
  const [jumpInput, setJumpInput] = useState("1");
  const [loading, setLoading] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderGen = useRef(0);

  useEffect(() => {
    if (!bytes) {
      setDoc(null);
      setPageCount(0);
      setPageIndex(0);
      setThumbs([]);
      setJumpInput("1");
      return;
    }

    let cancelled = false;
    setLoading(true);

    (async () => {
      try {
        const pdf = await loadPdfDocument(bytes);
        if (cancelled) {
          await pdf.cleanup();
          return;
        }
        setDoc(pdf);
        setPageCount(pdf.numPages);
        setPageIndex(0);
        setJumpInput("1");
        onPageCount?.(pdf.numPages);

        const thumbSlots: (string | null)[] = Array.from(
          { length: pdf.numPages },
          () => null,
        );
        setThumbs(thumbSlots);

        // Load thumbnails progressively
        for (let i = 0; i < pdf.numPages; i++) {
          if (cancelled) break;
          try {
            const url = await renderPageThumbnail(pdf, i);
            if (cancelled) break;
            setThumbs((prev) => {
              const next = [...prev];
              next[i] = url;
              return next;
            });
          } catch {
            // skip failed thumb
          }
        }
      } catch (err) {
        if (!cancelled) {
          onError?.(
            typeof err === "string"
              ? err
              : err instanceof Error
                ? err.message
                : "Could not open PDF",
          );
          setDoc(null);
          setPageCount(0);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [bytes, onPageCount, onError]);

  useEffect(() => {
    if (typeof focusPage === "number" && focusPage >= 0 && focusPage < pageCount) {
      setPageIndex(focusPage);
      setJumpInput(String(focusPage + 1));
    }
  }, [focusPage, pageCount]);

  useEffect(() => {
    if (!doc || !canvasRef.current || pageCount === 0) return;
    const gen = ++renderGen.current;
    const canvas = canvasRef.current;

    (async () => {
      try {
        const page = await doc.getPage(pageIndex + 1);
        if (gen !== renderGen.current) return;
        await renderPageToCanvas(page, zoom, canvas);
      } catch (err) {
        if (gen === renderGen.current) {
          onError?.(
            err instanceof Error ? err.message : "Failed to render page",
          );
        }
      }
    })();
  }, [doc, pageIndex, zoom, pageCount, onError]);

  const goTo = useCallback(
    (index: number) => {
      if (pageCount === 0) return;
      const clamped = Math.max(0, Math.min(pageCount - 1, index));
      setPageIndex(clamped);
      setJumpInput(String(clamped + 1));
    },
    [pageCount],
  );

  if (!bytes) {
    return (
      <p className={`text-sm text-zinc-500 ${className}`}>
        Choose or drop a PDF to browse pages.
      </p>
    );
  }

  return (
    <div className={`flex flex-col gap-3 ${className}`}>
      {sourcePath && (
        <p className="text-sm text-zinc-400 truncate" title={sourcePath}>
          {basename(sourcePath)}
          {pageCount > 0 ? ` · ${pageCount} pages` : ""}
        </p>
      )}

      {loading && <p className="text-sm text-zinc-500">Loading PDF…</p>}

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <button
          type="button"
          className="rounded-md border border-zinc-700 px-2 py-1 hover:border-zinc-500 disabled:opacity-40"
          disabled={pageIndex <= 0}
          onClick={() => goTo(pageIndex - 1)}
        >
          Prev
        </button>
        <button
          type="button"
          className="rounded-md border border-zinc-700 px-2 py-1 hover:border-zinc-500 disabled:opacity-40"
          disabled={pageIndex >= pageCount - 1}
          onClick={() => goTo(pageIndex + 1)}
        >
          Next
        </button>
        <label className="flex items-center gap-1 text-zinc-400">
          Page
          <input
            type="number"
            min={1}
            max={pageCount || 1}
            value={jumpInput}
            onChange={(e) => setJumpInput(e.target.value)}
            onBlur={() => {
              const n = Number(jumpInput);
              if (Number.isInteger(n)) goTo(n - 1);
              else setJumpInput(String(pageIndex + 1));
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const n = Number(jumpInput);
                if (Number.isInteger(n)) goTo(n - 1);
              }
            }}
            className="w-16 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-100"
          />
          / {pageCount || "—"}
        </label>
        <label className="flex items-center gap-1 text-zinc-400 ml-auto">
          Zoom
          <input
            type="range"
            min={0.5}
            max={2.5}
            step={0.05}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="w-28 accent-[var(--color-brand)]"
          />
          <span className="w-10 tabular-nums">{Math.round(zoom * 100)}%</span>
        </label>
      </div>

      <div className="flex gap-3 min-h-[320px]">
        <div className="w-28 shrink-0 overflow-y-auto max-h-[70vh] space-y-2 pr-1">
          {thumbs.map((src, i) => (
            <button
              key={i}
              type="button"
              onClick={() => goTo(i)}
              className={`block w-full rounded-md border p-1 transition-colors ${
                i === pageIndex
                  ? "border-brand bg-brand/10"
                  : "border-zinc-800 hover:border-zinc-600"
              }`}
            >
              {src ? (
                <img
                  src={src}
                  alt={`Page ${i + 1}`}
                  className="w-full rounded-sm"
                />
              ) : (
                <div className="aspect-[3/4] bg-zinc-800 rounded-sm flex items-center justify-center text-xs text-zinc-500">
                  {i + 1}
                </div>
              )}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-auto rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 flex justify-center">
          <canvas ref={canvasRef} className="max-w-full h-auto shadow-lg" />
        </div>
      </div>
    </div>
  );
}
