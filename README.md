# Behold! my SAK.

Local-first Windows desktop toolbox: one app, many small tools. A digital Swiss Army Knife.

**Stack:** Tauri 2 · React 19 · TypeScript · Vite · Tailwind CSS v4

## Tools


| Category | Tools                                                          |
| -------- | -------------------------------------------------------------- |
| Video    | Encoder, remux, audio convert, size reducer, clip trimmer      |
| Files    | Extension changer                                              |
| Image    | ICO converter, image cropper                                   |
| PDF      | Open / edit / merge / convert / resize, PDF→EPUB, PDF→Markdown |
| Audio    | Music downloader (YouTube / Spotify)                           |


## Setup

```bash
npm install
node scripts/setup-music-tools.mjs   # yt-dlp + Deno (music downloader)
node scripts/setup-calibre.mjs       # Calibre (PDF→EPUB / Markdown)
npm run tauri dev                    # development
npm run tauri build                  # production installer
```

FFmpeg/FFprobe ship as Tauri sidecars. Target: Windows `x86_64-pc-windows-msvc`.

## Adding a tool

1. `src/tools/<id>/index.tsx` — page body (default export)
2. Entry in `src/core/registry.ts`
3. Lazy route in `src/core/router.tsx`
4. Optional Tauri command in `src-tauri/src/lib.rs` + capabilities

See [AGENTS.md](AGENTS.md) for conventions and [plan.md](plan.md) for the roadmap.