use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;

use super::types::{ManifestItem, SpineItem};

#[derive(Debug, Clone)]
pub struct OpfDocument {
    pub manifest: Vec<ManifestItem>,
    pub spine: Vec<SpineItem>,
    pub spine_toc: Option<String>,
    pub title: Option<String>,
    pub identifier: Option<String>,
}

pub fn find_opf_path(container_xml: &str) -> Result<String, String> {
    let mut reader = Reader::from_str(container_xml);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Empty(e)) | Ok(Event::Start(e)) => {
                if e.name().as_ref() == b"rootfile" {
                    for attr in e.attributes().flatten() {
                        if attr.key.as_ref() == b"full-path" {
                            return Ok(String::from_utf8_lossy(&attr.value).into_owned());
                        }
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(e.to_string()),
            _ => {}
        }
        buf.clear();
    }
    Err("OPF path not found in container.xml".to_string())
}

pub fn parse_opf(opf_xml: &str, _opf_path: &str) -> Result<OpfDocument, String> {
    let mut reader = Reader::from_str(opf_xml);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();

    let mut manifest = Vec::new();
    let mut spine = Vec::new();
    let mut spine_toc = None;
    let mut title = None;
    let mut identifier = None;

    let mut in_manifest = false;
    let mut in_spine = false;
    let mut in_metadata = false;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name = e.name().as_ref().to_vec();
                if name.as_slice() == b"metadata" {
                    in_metadata = true;
                } else if name.as_slice() == b"manifest" {
                    in_manifest = true;
                } else if name.as_slice() == b"spine" {
                    in_spine = true;
                    for attr in e.attributes().flatten() {
                        if attr.key.as_ref() == b"toc" {
                            spine_toc = Some(String::from_utf8_lossy(&attr.value).into_owned());
                        }
                    }
                } else if in_manifest && name.as_slice() == b"item" {
                    push_manifest_item(&e, &mut manifest);
                } else if in_spine && name.as_slice() == b"itemref" {
                    push_spine_itemref(&e, &mut spine);
                } else if in_metadata {
                    if name.as_slice() == b"title" {
                        title = Some(read_text(&mut reader, &mut buf)?);
                    } else if name.as_slice() == b"identifier" || name.as_slice() == b"dc:identifier" {
                        identifier = Some(read_text(&mut reader, &mut buf)?);
                    }
                }
            }
            Ok(Event::End(e)) => {
                let name = e.name().as_ref().to_vec();
                if name.as_slice() == b"metadata" {
                    in_metadata = false;
                } else if name.as_slice() == b"manifest" {
                    in_manifest = false;
                } else if name.as_slice() == b"spine" {
                    in_spine = false;
                }
            }
            Ok(Event::Empty(e)) => {
                let name = e.name().as_ref().to_vec();
                if in_manifest && name.as_slice() == b"item" {
                    push_manifest_item(&e, &mut manifest);
                } else if in_spine && name.as_slice() == b"itemref" {
                    push_spine_itemref(&e, &mut spine);
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(e.to_string()),
            _ => {}
        }
        buf.clear();
    }

    Ok(OpfDocument {
        manifest,
        spine,
        spine_toc,
        title,
        identifier,
    })
}

fn push_manifest_item(e: &BytesStart, manifest: &mut Vec<ManifestItem>) {
    let mut id = String::new();
    let mut href = String::new();
    let mut media_type = String::new();
    let mut properties = None;
    for attr in e.attributes().flatten() {
        match attr.key.as_ref() {
            b"id" => id = String::from_utf8_lossy(&attr.value).into_owned(),
            b"href" => href = String::from_utf8_lossy(&attr.value).into_owned(),
            b"media-type" => media_type = String::from_utf8_lossy(&attr.value).into_owned(),
            b"properties" => properties = Some(String::from_utf8_lossy(&attr.value).into_owned()),
            _ => {}
        }
    }
    manifest.push(ManifestItem {
        id,
        href,
        media_type,
        properties,
    });
}

fn push_spine_itemref(e: &BytesStart, spine: &mut Vec<SpineItem>) {
    for attr in e.attributes().flatten() {
        if attr.key.as_ref() == b"idref" {
            spine.push(SpineItem {
                idref: String::from_utf8_lossy(&attr.value).into_owned(),
            });
        }
    }
}

fn read_text(reader: &mut Reader<&[u8]>, buf: &mut Vec<u8>) -> Result<String, String> {
    match reader.read_event_into(buf) {
        Ok(Event::Text(text)) => Ok(text.unescape().map_err(|e| e.to_string())?.into_owned()),
        Ok(Event::CData(text)) => Ok(String::from_utf8_lossy(&text).into_owned()),
        _ => Ok(String::new()),
    }
}

pub fn manifest_href<'a>(doc: &'a OpfDocument, idref: &str) -> Option<&'a str> {
    doc.manifest
        .iter()
        .find(|item| item.id == idref)
        .map(|item| item.href.as_str())
}

pub fn find_nav_item(doc: &OpfDocument) -> Option<&ManifestItem> {
    doc.manifest.iter().find(|item| {
        item.properties
            .as_deref()
            .is_some_and(|props| props.split_whitespace().any(|p| p == "nav"))
    })
}

pub fn find_ncx_item(doc: &OpfDocument) -> Option<&ManifestItem> {
    if let Some(toc_id) = &doc.spine_toc {
        return doc.manifest.iter().find(|item| item.id == *toc_id);
    }
    doc.manifest
        .iter()
        .find(|item| item.media_type == "application/x-dtbncx+xml")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_container_finds_opf() {
        let xml = r#"<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#;
        assert_eq!(find_opf_path(xml).unwrap(), "OEBPS/content.opf");
    }
}
