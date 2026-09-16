# Calibre runtime (bundled)

This folder holds the **portable Calibre** runtime used by the PDF → EPUB tool.

It is **not committed to git**. Run from the repo root:

```bash
node scripts/setup-calibre.mjs
```

After setup, `ebook-convert.exe` must exist somewhere under this folder (typically
in a `Calibre/` subfolder for the portable layout).

## License

Calibre is distributed under the **GNU General Public License v3**. See
`../THIRD_PARTY_NOTICES.md` for redistribution requirements.
