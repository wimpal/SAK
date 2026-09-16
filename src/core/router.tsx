import { lazy, Suspense } from "react";
import { createHashRouter, type RouteObject } from "react-router-dom";
import { ToolLayout } from "../ui/ToolLayout";
import { Home } from "./Home";
import { getTool } from "./registry";

const VideoEncode = lazy(() => import("../tools/video-encode"));
const VideoRemux = lazy(() => import("../tools/video-remux"));
const AudioConvert = lazy(() => import("../tools/audio-convert"));
const SizeReducer = lazy(() => import("../tools/size-reducer"));
const ClipTrimmer = lazy(() => import("../tools/clip-trimmer"));
const ExtChanger = lazy(() => import("../tools/ext-changer"));
const IcoConverter = lazy(() => import("../tools/ico-converter"));
const ImageCropper = lazy(() => import("../tools/image-cropper"));
const PdfTools = lazy(() => import("../tools/pdf-tools"));
const PdfToEpub = lazy(() => import("../tools/pdf-to-epub"));
const PdfToMarkdown = lazy(() => import("../tools/pdf-to-markdown"));
const MusicDownloader = lazy(() => import("../tools/music-downloader"));

function toolRoute(id: string, Component: React.ComponentType): RouteObject {
  const tool = getTool(id);
  return {
    path: tool.path,
    element: (
      <ToolLayout tool={tool}>
        <Suspense fallback={<p className="text-zinc-500">Loading…</p>}>
          <Component />
        </Suspense>
      </ToolLayout>
    ),
  };
}

export const router = createHashRouter([
  { path: "/", element: <Home /> },
  toolRoute("video-encode", VideoEncode),
  toolRoute("video-remux", VideoRemux),
  toolRoute("audio-convert", AudioConvert),
  toolRoute("size-reducer", SizeReducer),
  toolRoute("clip-trimmer", ClipTrimmer),
  toolRoute("ext-changer", ExtChanger),
  toolRoute("ico-converter", IcoConverter),
  toolRoute("image-cropper", ImageCropper),
  toolRoute("pdf-tools", PdfTools),
  toolRoute("pdf-to-epub", PdfToEpub),
  toolRoute("pdf-to-markdown", PdfToMarkdown),
  toolRoute("music-downloader", MusicDownloader),
]);
