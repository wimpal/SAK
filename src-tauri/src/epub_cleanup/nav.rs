use super::opf::OpfDocument;
use super::types::ContentAnalysis;

pub struct NavEntry {
    pub label: String,
    pub href: String,
}

pub fn build_nav_entries(
    doc: &OpfDocument,
    analyses: &[ContentAnalysis],
) -> Vec<NavEntry> {
    let mut entries = Vec::new();
    for (index, spine_item) in doc.spine.iter().enumerate() {
        let analysis = analyses.get(index);
        let href = super::opf::manifest_href(doc, &spine_item.idref).unwrap_or("");
        let label = analysis
            .and_then(|a| a.heading.clone())
            .filter(|h| !h.is_empty())
            .unwrap_or_else(|| fallback_label(doc, &spine_item.idref, href));
        entries.push(NavEntry {
            label,
            href: href.to_string(),
        });
    }
    entries
}

fn fallback_label(doc: &OpfDocument, idref: &str, href: &str) -> String {
    doc.manifest
        .iter()
        .find(|item| item.id == idref)
        .map(|item| item.href.clone())
        .unwrap_or_else(|| href.to_string())
}

pub fn write_ncx(title: &str, identifier: &str, entries: &[NavEntry]) -> String {
    let mut body = String::new();
    body.push_str("<?xml version='1.0' encoding='utf-8'?>\n");
    body.push_str("<ncx xmlns=\"http://www.daisy.org/z3986/2005/ncx/\" version=\"2005-1\" xml:lang=\"en\">\n");
    body.push_str("  <head>\n");
    body.push_str(&format!(
        "    <meta name=\"dtb:uid\" content=\"{}\"/>\n",
        xml_escape(identifier)
    ));
    body.push_str("    <meta name=\"dtb:depth\" content=\"1\"/>\n");
    body.push_str("    <meta name=\"dtb:totalPageCount\" content=\"0\"/>\n");
    body.push_str("    <meta name=\"dtb:maxPageNumber\" content=\"0\"/>\n");
    body.push_str("  </head>\n");
    body.push_str("  <docTitle><text>");
    body.push_str(&xml_escape(title));
    body.push_str("</text></docTitle>\n");
    body.push_str("  <navMap>\n");
    for (index, entry) in entries.iter().enumerate() {
        let play_order = index + 1;
        body.push_str(&format!(
            "    <navPoint id=\"navPoint{play_order}\" playOrder=\"{play_order}\">\n"
        ));
        body.push_str("      <navLabel><text>");
        body.push_str(&xml_escape(&entry.label));
        body.push_str("</text></navLabel>\n");
        body.push_str(&format!(
            "      <content src=\"{}\"/>\n",
            xml_escape(&entry.href)
        ));
        body.push_str("    </navPoint>\n");
    }
    body.push_str("  </navMap>\n");
    body.push_str("</ncx>\n");
    body
}

pub fn write_nav_xhtml(title: &str, entries: &[NavEntry]) -> String {
    let mut body = String::new();
    body.push_str("<?xml version='1.0' encoding='utf-8'?>\n");
    body.push_str("<html xmlns=\"http://www.w3.org/1999/xhtml\" xmlns:epub=\"http://www.idpf.org/2007/ops\">\n");
    body.push_str("  <head><title>");
    body.push_str(&xml_escape(title));
    body.push_str("</title></head>\n");
    body.push_str("  <body>\n");
    body.push_str("    <nav epub:type=\"toc\" id=\"toc\">\n");
    body.push_str("      <h1>Table of Contents</h1>\n");
    body.push_str("      <ol>\n");
    for entry in entries {
        body.push_str("        <li><a href=\"");
        body.push_str(&xml_escape_attr(&entry.href));
        body.push_str("\">");
        body.push_str(&xml_escape(&entry.label));
        body.push_str("</a></li>\n");
    }
    body.push_str("      </ol>\n");
    body.push_str("    </nav>\n");
    body.push_str("  </body>\n");
    body.push_str("</html>\n");
    body
}

fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn xml_escape_attr(text: &str) -> String {
    xml_escape(text).replace('"', "&quot;")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::epub_cleanup::content::analyze_xhtml;
        use crate::epub_cleanup::opf::OpfDocument;
        use crate::epub_cleanup::types::{ManifestItem, SpineItem};

    #[test]
    fn ncx_play_order_is_sequential() {
        let entries = vec![
            NavEntry {
                label: "Foreword".to_string(),
                href: "part001.html".to_string(),
            },
            NavEntry {
                label: "Chapter 1".to_string(),
                href: "part002.html".to_string(),
            },
        ];
        let ncx = write_ncx("Book", "id-1", &entries);
        assert!(ncx.contains("playOrder=\"1\""));
        assert!(ncx.contains("playOrder=\"2\""));
    }

    #[test]
    fn build_nav_entries_uses_headings() {
        let doc = OpfDocument {
            manifest: vec![
                ManifestItem {
                    id: "c1".to_string(),
                    href: "part001.html".to_string(),
                    media_type: "application/xhtml+xml".to_string(),
                    properties: None,
                },
            ],
            spine: vec![SpineItem { idref: "c1".to_string() }],
            spine_toc: None,
            title: None,
            identifier: None,
        };
        let analyses = vec![analyze_xhtml(
            "<html><body><h1>Foreword</h1><p>hello</p></body></html>",
        )];
        let entries = build_nav_entries(&doc, &analyses);
        assert_eq!(entries[0].label, "Foreword");
    }
}
