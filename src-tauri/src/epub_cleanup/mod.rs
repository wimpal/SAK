mod content;
mod detect;
mod nav;
mod opf;
mod package;
mod types;

pub use types::CleanupReport;

use std::fs;
use std::path::Path;

use content::analyze_xhtml;
use detect::detect_phantom_prefix;
use nav::{build_nav_entries, write_nav_xhtml, write_ncx};
use opf::{find_nav_item, find_ncx_item, find_opf_path, manifest_href, parse_opf, OpfDocument};
use package::{extract_epub, repackage_epub, resolve_href};
use types::{ContentAnalysis, SpineItem};

pub fn cleanup_calibre_epub(epub_path: &Path) -> CleanupReport {
    match cleanup_inner(epub_path) {
        Ok(report) => report,
        Err(err) => {
            log::warn!("epub cleanup skipped: {err}");
            CleanupReport::skipped(err)
        }
    }
}

fn cleanup_inner(epub_path: &Path) -> Result<CleanupReport, String> {
    let temp_root = std::env::temp_dir().join(format!(
        "sak-epub-cleanup-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let extract_dir = temp_root.join("extracted");
    let _ = fs::remove_dir_all(&temp_root);

    extract_epub(epub_path, &extract_dir)?;

    let container_xml =
        fs::read_to_string(extract_dir.join("META-INF/container.xml")).map_err(|e| e.to_string())?;
    let opf_rel = find_opf_path(&container_xml)?;
    let opf_path = extract_dir.join(&opf_rel);
    let opf_xml = fs::read_to_string(&opf_path).map_err(|e| e.to_string())?;
    let mut doc = parse_opf(&opf_xml, &opf_rel)?;

    let opf_base = opf_path
        .parent()
        .ok_or_else(|| "invalid OPF path".to_string())?;

    let analyses = analyze_spine(&doc, opf_base)?;
    let detection = detect_phantom_prefix(&analyses);
    if detection.remove_count == 0 {
        let _ = fs::remove_dir_all(&temp_root);
        return Ok(CleanupReport::skipped(detection.reason));
    }

    let remove_end = detection.remove_start + detection.remove_count;
    doc.spine.drain(detection.remove_start..remove_end);
    let mut cleaned_analyses = analyses;
    cleaned_analyses.drain(detection.remove_start..remove_end);

    let updated_opf = rewrite_opf_spine(&opf_xml, &doc.spine)?;
    fs::write(&opf_path, updated_opf).map_err(|e| e.to_string())?;

    let nav_entries = build_nav_entries(&doc, &cleaned_analyses);
    let book_title = doc
        .title
        .clone()
        .unwrap_or_else(|| "Untitled".to_string());
    let book_id = doc
        .identifier
        .clone()
        .unwrap_or_else(|| "sak-epub".to_string());

    if let Some(ncx_item) = find_ncx_item(&doc).cloned() {
        let ncx_path = opf_base.join(&ncx_item.href);
        let ncx_xml = write_ncx(&book_title, &book_id, &nav_entries);
        fs::write(ncx_path, ncx_xml).map_err(|e| e.to_string())?;
    }

    if let Some(nav_item) = find_nav_item(&doc).cloned() {
        let nav_path = opf_base.join(&nav_item.href);
        let nav_xml = write_nav_xhtml(&book_title, &nav_entries);
        fs::write(nav_path, nav_xml).map_err(|e| e.to_string())?;
    }

    repackage_epub(&extract_dir, epub_path)?;
    let _ = fs::remove_dir_all(&temp_root);

    Ok(CleanupReport::cleaned(detection.remove_count))
}

fn analyze_spine(doc: &OpfDocument, opf_base: &Path) -> Result<Vec<ContentAnalysis>, String> {
    let mut analyses = Vec::new();
    for spine_item in &doc.spine {
        let href = manifest_href(doc, &spine_item.idref)
            .ok_or_else(|| format!("missing manifest item for {}", spine_item.idref))?;
        let file_path = resolve_href(opf_base, href)?;
        let html = fs::read_to_string(file_path).map_err(|e| e.to_string())?;
        analyses.push(analyze_xhtml(&html));
    }
    Ok(analyses)
}

fn rewrite_opf_spine(opf_xml: &str, spine: &[SpineItem]) -> Result<String, String> {
    let start = opf_xml
        .find("<spine")
        .ok_or_else(|| "spine element not found".to_string())?;
    let end = opf_xml[start..]
        .find("</spine>")
        .ok_or_else(|| "spine end not found".to_string())?
        + start
        + "</spine>".len();

    let toc_attr = opf_xml[start..end]
        .lines()
        .next()
        .and_then(|line| {
            line.split("toc=\"")
                .nth(1)
                .map(|rest| rest.split('"').next().unwrap_or("").to_string())
        })
        .filter(|value| !value.is_empty());

    let mut replacement = String::from("<spine");
    if let Some(toc) = toc_attr {
        replacement.push_str(&format!(" toc=\"{toc}\""));
    }
    replacement.push_str(">\n");
    for item in spine {
        replacement.push_str(&format!("    <itemref idref=\"{}\"/>\n", item.idref));
    }
    replacement.push_str("  </spine>");

    let mut out = String::new();
    out.push_str(&opf_xml[..start]);
    out.push_str(&replacement);
    out.push_str(&opf_xml[end..]);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, ZipWriter};

    fn write_fixture_epub(path: &Path, opf: &str, chapters: &[(&str, &str)]) {
        let file = std::fs::File::create(path).unwrap();
        let mut writer = ZipWriter::new(file);
        let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

        writer.start_file("mimetype", stored).unwrap();
        writer
            .write_all(b"application/epub+zip")
            .unwrap();

        writer
            .start_file("META-INF/container.xml", deflated)
            .unwrap();
        writer
            .write_all(
                br#"<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#,
            )
            .unwrap();

        writer.start_file("content.opf", deflated).unwrap();
        writer.write_all(opf.as_bytes()).unwrap();

        for (name, html) in chapters {
            writer.start_file(*name, deflated).unwrap();
            writer.write_all(html.as_bytes()).unwrap();
        }

        writer.start_file("toc.ncx", deflated).unwrap();
        writer
            .write_all(
                br#"<?xml version='1.0'?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap></navMap></ncx>"#,
            )
            .unwrap();

        writer.finish().unwrap();
    }

    #[test]
    fn cleanup_removes_phantom_prefix_from_fixture() {
        let dir = std::env::temp_dir().join(format!(
            "sak-epub-cleanup-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let epub_path = dir.join("book.epub");

        let opf = r#"<?xml version='1.0'?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Fixture Book</dc:title>
    <dc:language>en</dc:language>
    <dc:identifier id="id">fixture-id</dc:identifier>
  </metadata>
  <manifest>
    <item id="c1" href="part001.html" media-type="application/xhtml+xml"/>
    <item id="c2" href="part002.html" media-type="application/xhtml+xml"/>
    <item id="c3" href="part003.html" media-type="application/xhtml+xml"/>
    <item id="c4" href="part004.html" media-type="application/xhtml+xml"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="c1"/>
    <itemref idref="c2"/>
    <itemref idref="c3"/>
    <itemref idref="c4"/>
  </spine>
</package>"#;

        let thin = |title: &str| {
            format!(
                "<html><body><h2>{title}</h2><p>subtitle only</p></body></html>"
            )
        };
        let fat = |title: &str| {
            format!(
                "<html><body><h2>{title}</h2><p>{}</p></body></html>",
                "word ".repeat(120)
            )
        };

        write_fixture_epub(
            &epub_path,
            opf,
            &[
                ("part001.html", &thin("Chapter 4: Find the Elements")),
                ("part002.html", &thin("Chapter 5: Risks and Rabbit Holes")),
                ("part003.html", &fat("Chapter 4: Find the Elements")),
                ("part004.html", &fat("Chapter 5: Risks and Rabbit Holes")),
            ],
        );
        let report = cleanup_calibre_epub(&epub_path);
        assert_eq!(report.action, "cleaned");
        assert_eq!(report.removed_spine_items, 2);

        let extract_dir = dir.join("verify");
        extract_epub(&epub_path, &extract_dir).unwrap();
        let updated_opf = fs::read_to_string(extract_dir.join("content.opf")).unwrap();
        assert!(updated_opf.matches(r#"<itemref idref="c3"/>"#).count() >= 1);
        assert!(!updated_opf.contains(r#"<itemref idref="c1"/>"#));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cleanup_skips_when_no_duplicates() {
        let dir = std::env::temp_dir().join(format!(
            "sak-epub-cleanup-skip-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let epub_path = dir.join("book.epub");

        let opf = r#"<?xml version='1.0'?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Fixture Book</dc:title>
    <dc:language>en</dc:language>
    <dc:identifier id="id">fixture-id</dc:identifier>
  </metadata>
  <manifest>
    <item id="c1" href="part001.html" media-type="application/xhtml+xml"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="c1"/>
  </spine>
</package>"#;

        let html = format!(
            "<html><body><h1>Chapter 1</h1><p>{}</p></body></html>",
            "word ".repeat(120)
        );
        write_fixture_epub(&epub_path, opf, &[("part001.html", &html)]);

        let before = fs::read(&epub_path).unwrap();
        let report = cleanup_calibre_epub(&epub_path);
        assert_eq!(report.action, "skipped");
        let after = fs::read(&epub_path).unwrap();
        assert_eq!(before, after);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cleanup_without_ncx_still_rewrites_spine() {
        let dir = std::env::temp_dir().join(format!(
            "sak-epub-cleanup-no-ncx-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let epub_path = dir.join("book.epub");

        let opf = r#"<?xml version='1.0'?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Fixture Book</dc:title>
    <dc:language>en</dc:language>
    <dc:identifier id="id">fixture-id</dc:identifier>
  </metadata>
  <manifest>
    <item id="c1" href="part001.html" media-type="application/xhtml+xml"/>
    <item id="c2" href="part002.html" media-type="application/xhtml+xml"/>
    <item id="c3" href="part003.html" media-type="application/xhtml+xml"/>
    <item id="c4" href="part004.html" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
    <itemref idref="c3"/>
    <itemref idref="c4"/>
  </spine>
</package>"#;

        let thin = |title: &str| {
            format!("<html><body><h2>{title}</h2><p>subtitle only</p></body></html>")
        };
        let fat = |title: &str| {
            format!(
                "<html><body><h2>{title}</h2><p>{}</p></body></html>",
                "word ".repeat(120)
            )
        };

        let file = std::fs::File::create(&epub_path).unwrap();
        let mut writer = ZipWriter::new(file);
        let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        writer.start_file("mimetype", stored).unwrap();
        writer
            .write_all(b"application/epub+zip")
            .unwrap();
        writer
            .start_file("META-INF/container.xml", deflated)
            .unwrap();
        writer
            .write_all(
                br#"<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#,
            )
            .unwrap();
        writer.start_file("content.opf", deflated).unwrap();
        writer.write_all(opf.as_bytes()).unwrap();
        for (name, html) in [
            ("part001.html", thin("Chapter 4: Find the Elements")),
            ("part002.html", thin("Chapter 5: Risks and Rabbit Holes")),
            ("part003.html", fat("Chapter 4: Find the Elements")),
            ("part004.html", fat("Chapter 5: Risks and Rabbit Holes")),
        ] {
            writer.start_file(name, deflated).unwrap();
            writer.write_all(html.as_bytes()).unwrap();
        }
        writer.finish().unwrap();

        let report = cleanup_calibre_epub(&epub_path);
        assert_eq!(report.action, "cleaned");
        assert_eq!(report.removed_spine_items, 2);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cleanup_skips_ambiguous_thin_front_matter() {
        let dir = std::env::temp_dir().join(format!(
            "sak-epub-cleanup-ambiguous-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let epub_path = dir.join("book.epub");

        let opf = r#"<?xml version='1.0'?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Fixture Book</dc:title>
    <dc:language>en</dc:language>
    <dc:identifier id="id">fixture-id</dc:identifier>
  </metadata>
  <manifest>
    <item id="c1" href="part001.html" media-type="application/xhtml+xml"/>
    <item id="c2" href="part002.html" media-type="application/xhtml+xml"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>"#;

        let foreword = "<html><body><h2>Foreword</h2><p>Short dedication only.</p></body></html>";
        let chapter = format!(
            "<html><body><h1>Chapter 1</h1><p>{}</p></body></html>",
            "word ".repeat(120)
        );
        write_fixture_epub(
            &epub_path,
            opf,
            &[("part001.html", foreword), ("part002.html", &chapter)],
        );

        let before = fs::read(&epub_path).unwrap();
        let report = cleanup_calibre_epub(&epub_path);
        assert_eq!(report.action, "skipped");
        let after = fs::read(&epub_path).unwrap();
        assert_eq!(before, after);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cleanup_skips_malformed_package() {
        let dir = std::env::temp_dir().join(format!(
            "sak-epub-cleanup-bad-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let epub_path = dir.join("book.epub");
        fs::write(&epub_path, b"not-an-epub").unwrap();

        let report = cleanup_calibre_epub(&epub_path);
        assert_eq!(report.action, "skipped");
        assert_eq!(fs::read(&epub_path).unwrap(), b"not-an-epub");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    #[ignore = "manual regression against a local Shape Up EPUB export"]
    fn shapeup_regression_cleanup() {
        let epub_path = std::path::PathBuf::from(r"d:\Legally acquired files\boenkies\Shape Up Stop Running in Circles and Ship Work that Matters (Ryan Singer) (z-library.sk, 1lib.sk, z-lib.sk).epub");
        if !epub_path.is_file() {
            return;
        }

        let dir = std::env::temp_dir().join(format!("sak-shapeup-regression-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let working = dir.join("book.epub");
        fs::copy(&epub_path, &working).unwrap();

        let report = cleanup_calibre_epub(&working);
        assert_eq!(report.action, "cleaned");
        assert!(report.removed_spine_items >= 10);

        let extract_dir = dir.join("extracted");
        extract_epub(&working, &extract_dir).unwrap();
        let opf_xml = fs::read_to_string(extract_dir.join("content.opf")).unwrap();
        let doc = parse_opf(&opf_xml, "content.opf").unwrap();
        let ncx = fs::read_to_string(extract_dir.join("toc.ncx")).unwrap();

        assert!(ncx.contains("Foreword by Jason Fried"));
        assert!(ncx.contains("1: Introduction"));
        assert!(doc.spine.len() >= 35);

        let first_content = analyze_spine(&doc, &extract_dir).unwrap();
        let first_heading = first_content
            .iter()
            .find_map(|item| item.heading.clone())
            .unwrap_or_default();
        assert!(
            first_heading.contains("Shape Up")
                || first_heading.contains("Table of Contents")
                || first_heading.contains("Foreword")
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
