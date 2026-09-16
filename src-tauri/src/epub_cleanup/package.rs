use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use zip::read::ZipArchive;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

pub fn extract_epub(epub_path: &Path, dest_dir: &Path) -> Result<(), String> {
    if dest_dir.exists() {
        fs::remove_dir_all(dest_dir).map_err(|e| e.to_string())?;
    }
    fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;

    let file = File::open(epub_path).map_err(|e| e.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|e| e.to_string())?;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
        let out_path = dest_dir.join(&name);
        if name.ends_with('/') {
            fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut buffer = Vec::new();
        entry.read_to_end(&mut buffer).map_err(|e| e.to_string())?;
        fs::write(&out_path, buffer).map_err(|e| e.to_string())?;
    }

    Ok(())
}

pub fn repackage_epub(source_dir: &Path, output_path: &Path) -> Result<(), String> {
    let temp_path = output_path.with_extension("epub.tmp");
    if temp_path.exists() {
        fs::remove_file(&temp_path).map_err(|e| e.to_string())?;
    }

    let file = File::create(&temp_path).map_err(|e| e.to_string())?;
    let mut writer = ZipWriter::new(file);

    let stored = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .unix_permissions(0o644);
    let deflated = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644);

    let mimetype_path = source_dir.join("mimetype");
    if mimetype_path.is_file() {
        writer
            .start_file("mimetype", stored)
            .map_err(|e| e.to_string())?;
        let bytes = fs::read(&mimetype_path).map_err(|e| e.to_string())?;
        writer.write_all(&bytes).map_err(|e| e.to_string())?;
    }

    let mut files = Vec::new();
    collect_files(source_dir, source_dir, &mut files)?;
    files.sort();

    for relative in files {
        if relative == "mimetype" {
            continue;
        }
        let full_path = source_dir.join(&relative);
        let options = deflated;
        writer
            .start_file(&relative, options)
            .map_err(|e| e.to_string())?;
        let bytes = fs::read(&full_path).map_err(|e| e.to_string())?;
        writer.write_all(&bytes).map_err(|e| e.to_string())?;
    }

    writer.finish().map_err(|e| e.to_string())?;
    if output_path.exists() {
        fs::remove_file(output_path).map_err(|e| e.to_string())?;
    }
    fs::rename(&temp_path, output_path).map_err(|e| e.to_string())?;
    Ok(())
}

fn collect_files(base: &Path, current: &Path, out: &mut Vec<String>) -> Result<(), String> {
    for entry in fs::read_dir(current).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            collect_files(base, &path, out)?;
        } else {
            let relative = path
                .strip_prefix(base)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            out.push(relative);
        }
    }
    Ok(())
}

pub fn resolve_href(root: &Path, href: &str) -> Result<PathBuf, String> {
    let href_path = href.split('#').next().unwrap_or(href);
    let decoded = href_path.replace("%20", " ");
    let opf_parent = root;
    let joined = opf_parent.join(decoded);
    if joined.is_file() {
        Ok(joined)
    } else {
        Err(format!("missing package file: {href}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repackage_puts_mimetype_first() {
        let dir = std::env::temp_dir().join(format!("sak-epub-repack-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let source = dir.join("src");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("mimetype"), "application/epub+zip").unwrap();
        fs::write(source.join("content.opf"), "<package/>").unwrap();

        let out = dir.join("book.epub");
        repackage_epub(&source, &out).unwrap();

        let file = File::open(&out).unwrap();
        let mut archive = ZipArchive::new(file).unwrap();
        assert_eq!(archive.by_index(0).unwrap().name(), "mimetype");
        assert_eq!(
            archive.by_index(0).unwrap().compression(),
            zip::CompressionMethod::Stored
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
