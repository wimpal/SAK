import { useCallback, useState } from "react";
import { DropZone } from "../../ui/DropZone";
import { FilePickerButton } from "../../ui/FilePickerButton";
import { ConvertMode } from "./convert";
import { EditMode } from "./edit";
import {
  expandIntakePaths,
  readFileBytes,
} from "./io";
import {
  isImagePath,
  isPdfPath,
  MODES,
  type ConvertDirection,
  type PdfMode,
} from "./logic";
import { MergeMode } from "./merge";
import { ResizeMode } from "./resize";
import { PdfViewer } from "./viewer";

const pdfFilters = [{ name: "PDF", extensions: ["pdf"] }];
const imageFilters = [
  {
    name: "Images",
    extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif"],
  },
];

export default function PdfTools() {
  const [mode, setMode] = useState<PdfMode>("open");
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  const [mergePaths, setMergePaths] = useState<string[]>([]);
  const [imagePaths, setImagePaths] = useState<string[]>([]);
  const [convertDirection, setConvertDirection] =
    useState<ConvertDirection>("pdf-to-images");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const loadPdf = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const bytes = await readFileBytes(path);
      setSourcePath(path);
      setPdfBytes(bytes);
    } catch (err) {
      setSourcePath(null);
      setPdfBytes(null);
      setError(err instanceof Error ? err.message : "Failed to load PDF");
    } finally {
      setLoading(false);
    }
  }, []);

  const handlePdfIntake = useCallback(
    async (rawPaths: string[]) => {
      setError(null);
      try {
        const expanded = await expandIntakePaths(rawPaths, false);
        const pdfs = expanded.filter(isPdfPath);
        if (pdfs.length === 0) {
          setError("No PDF files found.");
          return;
        }

        if (mode === "merge") {
          setMergePaths(pdfs);
          return;
        }

        await loadPdf(pdfs[0]);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to process intake",
        );
      }
    },
    [mode, loadPdf],
  );

  const handleImageIntake = useCallback(async (rawPaths: string[]) => {
    setError(null);
    try {
      const expanded = await expandIntakePaths(rawPaths, false);
      const images = expanded.filter(isImagePath);
      if (images.length === 0) {
        setError("No image files found.");
        return;
      }
      setImagePaths(images);
      setConvertDirection("images-to-pdf");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to process intake",
      );
    }
  }, []);

  const handleDrop = useCallback(
    (paths: string[]) => {
      if (mode === "convert" && convertDirection === "images-to-pdf") {
        void handleImageIntake(paths);
      } else if (mode === "convert" && paths.some(isImagePath) && !paths.some(isPdfPath)) {
        void handleImageIntake(paths);
      } else {
        void handlePdfIntake(paths);
      }
    },
    [mode, convertDirection, handlePdfIntake, handleImageIntake],
  );

  const showPdfPicker =
    mode === "open" ||
    mode === "edit" ||
    mode === "merge" ||
    mode === "resize" ||
    (mode === "convert" && convertDirection === "pdf-to-images");

  const showImagePicker =
    mode === "convert" && convertDirection === "images-to-pdf";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-1 border-b border-zinc-800 pb-3">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => {
              setMode(m.id);
              setError(null);
            }}
            className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
              mode === m.id
                ? "bg-brand/15 text-brand-soft border border-brand/40"
                : "text-zinc-400 hover:text-zinc-200 border border-transparent"
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {showPdfPicker && (
          <>
            <FilePickerButton
              label={mode === "merge" ? "Choose PDFs" : "Choose PDF"}
              multiple={mode === "merge"}
              filters={pdfFilters}
              onPick={(paths) => void handlePdfIntake(paths)}
            />
            {mode === "merge" && (
              <FilePickerButton
                label="Choose folder"
                directory
                onPick={(paths) => void handlePdfIntake(paths)}
              />
            )}
          </>
        )}
        {showImagePicker && (
          <>
            <FilePickerButton
              label="Choose images"
              multiple
              filters={imageFilters}
              onPick={(paths) => void handleImageIntake(paths)}
            />
            <FilePickerButton
              label="Choose folder"
              directory
              onPick={(paths) => void handleImageIntake(paths)}
            />
          </>
        )}
        {mode === "convert" && convertDirection === "pdf-to-images" && (
          <button
            type="button"
            className="text-sm text-zinc-500 hover:text-zinc-300"
            onClick={() => setConvertDirection("images-to-pdf")}
          >
            Switch to images → PDF intake
          </button>
        )}
      </div>

      <DropZone onDrop={handleDrop}>
        {mode === "merge"
          ? "Drop PDFs or a folder"
          : mode === "convert" && convertDirection === "images-to-pdf"
            ? "Drop images or a folder"
            : "Drop a PDF here"}
      </DropZone>

      {loading && <p className="text-sm text-zinc-500">Loading…</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}

      {mode === "open" && (
        <PdfViewer
          bytes={pdfBytes}
          sourcePath={sourcePath}
          onError={(msg) => setError(msg)}
        />
      )}

      {mode === "edit" && (
        <EditMode
          sourcePath={sourcePath}
          bytes={pdfBytes}
          onBytesChange={setPdfBytes}
          onError={setError}
        />
      )}

      {mode === "merge" && (
        <MergeMode paths={mergePaths} onError={setError} />
      )}

      {mode === "convert" && (
        <ConvertMode
          pdfPath={sourcePath}
          pdfBytes={pdfBytes}
          imagePaths={imagePaths}
          direction={convertDirection}
          onDirectionChange={(d) => {
            setConvertDirection(d);
            setError(null);
          }}
          onError={setError}
        />
      )}

      {mode === "resize" && (
        <ResizeMode
          sourcePath={sourcePath}
          bytes={pdfBytes}
          onError={setError}
        />
      )}
    </div>
  );
}
