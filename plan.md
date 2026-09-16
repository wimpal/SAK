# SAK — Swiss Army Knife

A personal, local-first desktop app that collects every small tool I ever need into one place.
No cloud, no accounts, no subscriptions — just a toolbox that grows over time.

## Vision

Whenever I catch myself thinking *"I wish I had a tool for X"*, adding X to SAK should be a
small, well-defined task — not a new project. The app is built around a **plugin-style tool
registry**: every tool is a self-contained module, and adding a new one means creating one
folder and registering it in one place.

## Design principles

1. **Local-first** — everything runs on my machine. Files never leave the disk.
2. **Scalable by design** — one tool = one module. Shared functionality (file pickers, FFmpeg
   wrappers, queue/progress UI) lives in a core layer all tools can use.
3. **Batch-friendly** — most tools should work on folders/selections of files, not just one
   file at a time.
4. **Safe by default** — never overwrite originals unless explicitly asked; default to writing
   output next to the source or into a chosen output folder.
5. **Personal use** — polish where it matters (speed, keyboard flow), skip what doesn't
   (accounts, settings sync, telemetry).

## Features

### 1. Video tools
A family of small utilities built on top of FFmpeg:

- **Re-encode video** — convert encoding (e.g. H.264 ↔ H.265/HEVC, VP9, AV1), choose
  quality/CRF, preset, and resolution.
- **Change container without loss** — remux (e.g. MKV → MP4) by copying streams, no
  re-encode, no quality loss.
- **Change audio type** — convert/replace the audio track (e.g. DTS → AAC), keep video
  untouched.
- **File size reducer** — compress with a target size or quality slider, with an estimate of
  the output size before running.
- **Etc.** — future candidates: extract audio, extract frames, GIF creation, subtitle
  burn-in/extract, resolution/fps change, merge clips.

### 2. Clip trimmer
A focused workflow for cutting down raw footage:

- **Single clip** — open a clip, set in/out points on a timeline, preview, save the trimmed
  clip (stream-copy for instant, lossless cuts where possible). Polish: accurate re-encode
  mode, loop selection preview, mark in/out, frame/time nudges, auto-bumped output names,
  reveal in Explorer.
- **Batch / folder mode** — point at a folder or select multiple clips, then work through a
  queue:
  - Each clip is shown one by one.
  - Per clip, decide: **trim** (set in/out, save) or **delete**.
  - Clip is processed, the next one loads immediately.
  - Progress indicator (e.g. "clip 4 of 23") and a summary at the end.

**Clip trimmer backlog (parked)**
- Remember last output folder
- Richer keyboard: J/K/L, arrow seek, Enter to trim
- Timeline thumbnail strip
- Cancel in-progress trim + real FFmpeg progress %

**Shared video infra (parked)**
- Clip trimmer: cancel in-progress trim + real FFmpeg progress %
- Soft re-encode / target-size estimate belongs in Size Reducer, not the trimmer

**Shared FFmpeg runner** ✅ *(done 2026-07-31)* — spawn sidecar with progress parse,
`ffmpeg-progress` / `ffmpeg-done` events, and `cancel_ffmpeg_job`; first consumer is
Remux polish.

### 3. File extension changer
- Change the extension of one or many files (pure rename, no conversion).
- Batch mode with rules: e.g. all `.jpeg` → `.jpg` in a folder.
- Preview of renames before applying; warn on collisions.

### 4. ICO converter
- Upload a raster image, position a square crop with a center guide, and export
  selected Windows icon sizes (16–256 px) as separate `.ico` files.
- Collision-safe output next to the source or into a chosen folder.

### 5. Image cropper
- Freeform rectangular crop with a center crosshair guide.
- Export as PNG, JPEG, or WebP to a collision-safe sibling file or chosen folder.

### 6. PDF tools
A family of PDF utilities under one tool (or a small cluster sharing intake / output
policy). All operations stay local; originals are never overwritten by default.

- **Open PDF** — pick or drop a PDF, browse pages (thumbnail strip + main page view),
  zoom, and jump to a page. Read-only first; no cloud viewer. Useful as the entry
  point before edit / compress / convert, and as a quick local PDF opener.
- **Resize** — scale page content by percentage (e.g. shipping labels that print
  too large for a small package). Default keeps original page size and anchors
  content top-left so print-at-100% yields a smaller physical label; optional
  center position and “shrink page to content.” Collision-safe sibling save;
  annotations/forms may be dropped (warn in UI).
- **Edit** — light document edits without leaving SAK:
  - Reorder, rotate, or delete pages (drag-and-drop page list).
  - Extract selected pages into a new PDF.
  - Insert blank pages or pages from another PDF at a chosen position.
  - Optional later: add text annotations / simple stamps (keep scope tight at first —
    page surgery over a full PDF editor).
  - Save as a new file (collision-safe suffix or chosen folder); optional “replace
    original” only behind an explicit confirm.
- **Merge** — combine two or more PDFs into one:
  - Multi-file / folder intake with a reorderable list (drag to set page-block order).
  - Per-file include-all or page-range (e.g. `1–3, 7`).
  - Preview of final page count before running.
  - Output next to the first source or into a chosen folder; never clobber sources.
- **Compress** — shrink PDF size for email / archive:
  - Quality presets (e.g. screen / ebook / printer) and/or a target-size hint.
  - Show before/after size estimate when possible; warn if gain is negligible.
  - Batch mode: folder or multi-select → one compressed sibling per input.
- **Convert** — PDF ↔ common formats:
  - PDF → images (PNG / JPEG / WebP): all pages or a range; DPI / quality controls;
    one image per page into a sibling folder or chosen output folder.
  - Images → PDF: multi-image intake, reorderable, page size / fit options
    (fit / fill / original), optional uniform page size.
  - Optional later: PDF → plain text extract if useful beyond Markdown; skip OCR
    until there’s a real need. (PDF → Markdown is a standalone Calibre tool.)

**PDF to EPUB (standalone tool)**
- Single PDF → reflowable EPUB via bundled Calibre `ebook-convert`.
- Output next to source or into a chosen folder; collision-safe naming; progress +
  cancel. No OCR or password unlock in v1.

**PDF to Markdown (standalone tool)**
- Single PDF → Markdown via bundled Calibre `ebook-convert` (TXT output with
  `--txt-output-formatting markdown`, then rename to `.md`).
- Output next to source or into a chosen folder; collision-safe naming; progress +
  cancel. No OCR or password unlock in v1. Quality depends on PDF text structure.

**PDF tools backlog (parked)**
- Compress presets via Ghostscript sidecar (screen / ebook / printer)
- Password-protected PDF open / unlock (with user-supplied password only)
- Split by bookmarks or fixed page counts
- Form fill / flatten
- OCR for scanned PDFs
- Linearize / web-optimize

### 7. YouTube downloader
Paste a link, choose what to save, download locally. No accounts, no uploads — only
pulls media to disk.

- **Intake** — paste a YouTube URL (watch, Shorts, or `youtu.be`). Resolve metadata
  immediately: title, channel, duration, thumbnail, and available formats.
- **Download mode**
  - **Video** — pick resolution / container from what’s available (e.g. best,
    1080p, 720p, …). Prefer muxed streams when present; otherwise download video +
    audio and mux locally (FFmpeg sidecar).
  - **Audio only** — extract/download best audio and save as MP3 or M4A (user choice),
    with a sensible bitrate default and optional quality picker.
- **Output** — collision-safe filename derived from the video title (sanitized for
  Windows); default to a remembered download folder or a one-off picker. Never
  overwrite without warning.
- **Progress** — download progress bar, cancel, and “reveal in Explorer” when done.
- **Batch (later)** — paste multiple URLs or a playlist link; queue with per-item
  mode (video vs audio) and a summary when finished.

**YouTube downloader backlog (parked)**
- Playlist / channel batch with selective checkboxes
- Subtitle / caption download (optional sidecar `.srt` / `.vtt`)
- Remember last format + audio-only preference
- Clipboard watch: offer to paste when a YouTube URL is on the clipboard
- Rate-limit / retry UX when YouTube throttles or changes extractors

**Note on local-first:** this tool reaches the network only to fetch the media the user
asked for. Nothing is uploaded; no YouTube login is required for public videos.

### 8. Music downloader
Paste a YouTube / YouTube Music or Spotify link and download tracks locally as MP3.

- **Intake** — paste a URL; SAK detects the platform and resolves track metadata
  (single tracks, albums, playlists on YouTube; Spotify track / album / playlist).
- **Spotify** — metadata from Spotify (oEmbed for tracks; Web API for albums /
  playlists with optional local Client ID / Secret). Audio is **matched on YouTube**
  via yt-dlp search — not ripped from Spotify.
- **YouTube** — resolved directly via bundled **yt-dlp** + **Deno** sidecars; converted
  with bundled **FFmpeg** to **MP3 320 kbps** with tags and cover art when available.
- **Output** — collision-safe filenames (`Artist - Title.mp3`), remembered download
  folder, progress + cancel, reveal in Explorer.
- **Engine note:** evaluated [lucida](https://www.npmjs.com/package/lucida) (Node,
  account tokens, FLAC-first) — rejected in favour of yt-dlp sidecar (also reused later
  for the YouTube video downloader).

**Music downloader backlog (parked)**
- SoundCloud / Bandcamp (yt-dlp already supports them)
- Clipboard watch for music URLs
- Duration-based match validation for Spotify → YouTube search
- Lyrics download

### 9. Text converter
Paste text, pick a conversion, get the result instantly — a local take on sites like
[textconverter.net](https://www.textconverter.net/) and [lingojam.com](https://lingojam.com/).
No network, no accounts; pure in-browser transforms.

- **Intake** — text area for paste / type; optional “clear” and “copy input”.
- **Convert** — pick a mode from a list (or searchable picker); output updates live as
  the user types or switches modes. Starter set:
  - Case: upper / lower / title / sentence / alternating / inverse
  - Shape: reverse, upside-down, mirrored
  - Unicode “fonts”: bold, italic, bold-italic, monospace, script, fraktur, small caps,
    bubbles, squares, fullwidth, and similar decorative maps
  - Encoding-ish: strikethrough, underline (combining), Morse, binary (optional later)
- **Output** — live result pane with one-click **Copy**; optional “swap” (output → input)
  for chaining transforms.
- **Scope** — keep it a single tool with many modes, not one tool per style. Prefer a
  small shared transform registry (id, label, `fn(text) → text`) so new modes are one
  function + one list entry.

**Text converter backlog (parked)**
- Favorite / pin modes
- Remember last mode
- Batch file mode (`.txt` in → converted sibling out)
- Custom user-defined character maps

### Future tool ideas (parking lot)
- Image converter / compressor (format conversion beyond crop)
- Duplicate file finder
- Bulk renamer (patterns, numbering, EXIF dates)
- Hash/checksum calculator
- Text diff tool
- Screenshot / screen recording organizer

## Stack — decided

### Chosen: **Tauri 2 + React + TypeScript + FFmpeg** ✅

| Layer | Choice | Why |
|---|---|---|
| App shell | **Tauri 2** (Rust core, webview UI) | Lightweight (~10–20 MB vs Electron's 150+ MB), fast, native file access, single `.exe` for Windows, auto-updater available |
| Frontend | **React + TypeScript + Vite** | Best-in-class UI flexibility for video preview, timelines, drag & drop; huge ecosystem |
| Styling | **Tailwind CSS** (or plain CSS modules) | Fast to iterate, consistent look across tools |
| Media engine | **FFmpeg / FFprobe** (bundled binaries, driven from Rust) | The industry standard for everything video/audio; covers every video feature above |
| Tool state | Per-tool local state + a small core store (Zustand) | Tools stay decoupled; no global state spaghetti |

**Why this fits SAK:**
- Web-tech UI makes the clip trimmer (video preview, frame scrubbing, timeline) far easier
  than any native widget toolkit.
- Rust handles file-system work and FFmpeg process orchestration quickly and safely.
- FFmpeg is bundled with the app (sidecar binaries), so there are no external dependencies
  to install.
- The tool registry pattern maps cleanly onto a React router + a Rust command-per-tool
  backend.

### Alternatives considered

| Stack | Verdict |
|---|---|
| **Electron + React** | Same UI benefits, easier hiring/ecosystem, but much heavier binaries and RAM use. Fine fallback if Tauri's Rust side becomes friction. |
| **Python + PySide6** | Fastest to write new tools in, great FFmpeg subprocess support — but video-preview UI (scrubbing, timelines) is noticeably clunkier than web tech. |
| **Python + FastAPI + browser UI** | No installable app feel; managing a local server + browser tab is awkward for a personal tool. |

## Architecture

```
SAK/
├── src-tauri/              # Rust core
│   └── src/
│       ├── main.rs
│       ├── ffmpeg/         # FFmpeg/FFprobe wrapper (spawn, progress parsing, cancel)
│       └── tools/          # Backend logic per tool (one module each)
├── src/                    # React frontend
│   ├── core/
│   │   ├── registry.ts     # THE tool registry: id, name, icon, route, component
│   │   ├── router.tsx      # Routes generated from the registry
│   │   └── store.ts        # Shared app state
│   ├── ui/                 # Shared components (file picker, drop zone, progress bar,
│   │                       #   video player, job queue panel)
│   └── tools/              # One folder per tool — the plugin surface
│       ├── video-encode/
│       ├── video-remux/
│       ├── audio-convert/
│       ├── size-reducer/
│       ├── clip-trimmer/
│       └── ext-changer/
├── resources/              # Bundled ffmpeg/ffprobe binaries
└── plan.md
```

**Adding a new tool:**
1. Create `src/tools/<tool-name>/` containing its UI component and logic.
2. If it needs native work, add a Rust module in `src-tauri/src/tools/` exposing one or two
   Tauri commands.
3. Add one entry to `core/registry.ts`.
4. Done — it appears in the home screen grid with routing wired up automatically.

**Shared core services** (built once, reused by every tool):
- File/folder picker + drag-and-drop intake
- Job queue with per-file progress and cancellation (FFmpeg progress parsing)
- Output-location policy (suffix, sibling folder, custom folder — never overwrite by default)
- Recent files / tool history

## Roadmap

1. **Foundation** ✅ *(done 2026-07-29)* — Tauri + React app scaffolded, tool registry,
   home screen with tool grid, shared file-picker/drop-zone components, FFmpeg 8.1.2
   bundled as sidecar and verified running from the UI.
2. **File extension changer** ✅ *(done 2026-07-29)* — pure rename with file/folder
   intake, optional from-filter, preview table with collision warnings, batch apply
   via Rust (never overwrites).
3. **ICO converter** ✅ *(done 2026-07-29)* — single-image intake, square crop
   with center guide, selectable icon sizes, separate collision-safe `.ico` exports
   via Rust image encoding.
4. **Image cropper** ✅ *(done 2026-07-29)* — freeform crop with center guide,
   PNG/JPEG/WebP export, collision-safe sibling output.
5. **Clip trimmer (single clip)** ✅ *(done 2026-07-30)* — video preview with sound,
   timeline in/out selection, lossless stream-copy trim to a collision-safe sibling file.
6. **Clip trimmer polish** ✅ *(done 2026-07-30)* — accurate re-encode toggle, loop
   selection preview, mark in/out buttons, frame/time nudges, auto-bumped output names,
   reveal in Explorer.
7. **Remux (no loss)** ✅ *(done 2026-07-31)* — batch video intake, MP4/MKV/MOV/WebM/TS/M4V
   targets, stream-copy remux via shared FFmpeg runner (progress + cancel), pattern naming
   with disk collision auto-bump, remembered output folder, compatibility warnings,
   drop-incompatible toggle, single-file stream picker, per-file results in preview table.
8. **Video tools**
   - **Re-encode** ✅ *(done 2026-08-02)* — batch encode with H.264 / H.265 / VP9 / AV1,
     CRF + preset + resolution, shared FFmpeg runner (progress + cancel), audio copy or
     AAC/Opus fallback, collision-safe naming.
   - **Size reducer** ✅ *(done 2026-08-02)* — target size (ABR) or quality (CRF) modes,
     pre-run size estimates, H.264 / H.265, shared FFmpeg runner (progress + cancel),
     collision-safe naming.
   - **Audio convert** ✅ *(done 2026-08-04)* — batch convert audio to AAC / Opus with
     bitrate presets; video stream-copy; keeps source container; shared FFmpeg runner
     (progress + cancel); collision-safe naming.
9. **Clip trimmer (batch)** ✅ *(done 2026-08-05)* — folder/multi queue: interactive
   trim-or-delete (Recycle Bin) workflow with “clip N of M” and end summary.
10. **PDF tools** ✅ *(done 2026-08-05; Resize 2026-09-16)* — one tool with Open /
    Edit / Merge / Convert / Resize modes (pdf.js view + pdf-lib page surgery);
    collision-safe outputs; Compress parked (Ghostscript later).
11. **PDF to EPUB** ✅ — standalone tool; bundled Calibre `ebook-convert` for
    reflowable EPUB; single-file workflow; collision-safe output; progress +
    cancel. Limitations: source-dependent reflow quality, no OCR for scanned PDFs,
    no password-protected PDFs.
11b. **PDF to Markdown** ✅ — standalone tool; Calibre TXT markdown output renamed
    to `.md`; same UX as EPUB (collision-safe, progress, cancel); no OCR.
12. **Music downloader** ✅ *(done 2026-08-14)* — paste YouTube / Spotify URL → resolve
    tracks → download MP3 320 kbps via bundled yt-dlp + Deno + FFmpeg; Spotify albums /
    playlists need optional local Spotify API credentials; collision-safe output folder.
13. **YouTube downloader** — paste URL → metadata preview → download video (mux via
  FFmpeg when needed) or audio-only (MP3 / M4A); remembered folder, progress +
  cancel. Playlist/batch later. *(yt-dlp sidecar shared with music downloader.)*
14. **Text converter** — paste/type text, pick a transform (case, reverse/upside-down,
  Unicode “fonts”, etc.), live output + copy. Pure frontend; no Rust needed for v1.
15. **Grow** — add tools from the parking lot as needs come up.
