import type { LucideIcon } from "lucide-react";
import {
  AudioLines,
  BookOpen,
  Calculator,
  Crop,
  FileCode,
  FilePen,
  FileText,
  FileVideo,
  ImageIcon,
  Layers,
  Music,
  Scissors,
  Shrink,
} from "lucide-react";

export type ToolStatus = "available" | "planned";
export type ToolCategory =
  | "Video"
  | "Files"
  | "Image"
  | "PDF"
  | "Audio"
  | "Utility";

export interface ToolMeta {
  id: string;
  name: string;
  description: string;
  icon: LucideIcon;
  path: string;
  category: ToolCategory;
  status: ToolStatus;
}

/**
 * The tool registry — the single place a new tool gets added.
 * 1. Create src/tools/<id>/index.tsx (default-exported component)
 * 2. Add an entry here
 * 3. Wire the lazy import in core/router.tsx
 */
export const tools: ToolMeta[] = [
  {
    id: "video-encode",
    name: "Video Encoder",
    description: "Re-encode to a different codec, quality or resolution.",
    icon: FileVideo,
    path: "/video-encode",
    category: "Video",
    status: "available",
  },
  {
    id: "video-remux",
    name: "Remux (No Loss)",
    description: "Change container (e.g. MKV to MP4) without re-encoding.",
    icon: Layers,
    path: "/video-remux",
    category: "Video",
    status: "available",
  },
  {
    id: "audio-convert",
    name: "Audio Converter",
    description: "Convert or replace the audio track, video untouched.",
    icon: AudioLines,
    path: "/audio-convert",
    category: "Video",
    status: "available",
  },
  {
    id: "size-reducer",
    name: "Size Reducer",
    description: "Compress video to a target size or quality.",
    icon: Shrink,
    path: "/size-reducer",
    category: "Video",
    status: "available",
  },
  {
    id: "clip-trimmer",
    name: "Clip Trimmer",
    description: "Trim clips with in/out points — single or batch folder workflow.",
    icon: Scissors,
    path: "/clip-trimmer",
    category: "Video",
    status: "available",
  },
  {
    id: "ext-changer",
    name: "Extension Changer",
    description: "Change file extensions for one file or a whole batch.",
    icon: FilePen,
    path: "/ext-changer",
    category: "Files",
    status: "available",
  },
  {
    id: "ico-converter",
    name: "ICO Converter",
    description:
      "Crop an image to a square and export selected Windows icon sizes as .ico files.",
    icon: ImageIcon,
    path: "/ico-converter",
    category: "Image",
    status: "available",
  },
  {
    id: "image-cropper",
    name: "Image Cropper",
    description:
      "Freeform crop with a center guide and export as PNG, JPEG, or WebP.",
    icon: Crop,
    path: "/image-cropper",
    category: "Image",
    status: "available",
  },
  {
    id: "pdf-tools",
    name: "PDF Tools",
    description:
      "Open, edit, resize, merge, and convert PDFs ↔ images — all local.",
    icon: FileText,
    path: "/pdf-tools",
    category: "PDF",
    status: "available",
  },
  {
    id: "pdf-to-epub",
    name: "PDF to EPUB",
    description:
      "Convert a PDF into a reflowable EPUB ebook with bundled Calibre.",
    icon: BookOpen,
    path: "/pdf-to-epub",
    category: "PDF",
    status: "available",
  },
  {
    id: "pdf-to-markdown",
    name: "PDF to Markdown",
    description:
      "Convert a PDF into Markdown with bundled Calibre (text PDFs; no OCR).",
    icon: FileCode,
    path: "/pdf-to-markdown",
    category: "PDF",
    status: "available",
  },
  {
    id: "music-downloader",
    name: "Music Downloader",
    description:
      "Paste a YouTube or Spotify link and download tracks as MP3 (320 kbps).",
    icon: Music,
    path: "/music-downloader",
    category: "Audio",
    status: "available",
  },
  {
    id: "craft-calculator",
    name: "Craft Calculator",
    description:
      "Maximize crafts per inventory trip from a recipe, stack size, and reserved slots.",
    icon: Calculator,
    path: "/craft-calculator",
    category: "Utility",
    status: "available",
  },
];

export function getTool(id: string): ToolMeta {
  const tool = tools.find((t) => t.id === id);
  if (!tool) throw new Error(`Unknown tool: ${id}`);
  return tool;
}
