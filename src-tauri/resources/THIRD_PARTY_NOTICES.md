# Third-party notices

## Calibre (PDF → EPUB conversion)

SAK bundles the Calibre `ebook-convert` tool for local PDF → EPUB conversion when
you run `node scripts/setup-calibre.mjs` and build the app.

- **Project:** Calibre — https://calibre-ebook.com/
- **License:** GNU General Public License v3 (GPLv3)
- **Source:** https://github.com/kovidgoyal/calibre

Under GPLv3, recipients of this application must be able to obtain the complete
corresponding source for the bundled Calibre version. Include the Calibre version
string shown in the PDF → EPUB tool and point users to the official source release
matching that version.

Do not commit the Calibre binaries to this repository; they are downloaded at
build/setup time into `src-tauri/resources/calibre/`.
