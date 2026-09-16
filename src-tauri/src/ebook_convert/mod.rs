use std::io::{BufRead, BufReader};

use std::path::{Path, PathBuf};

use std::process::{Child, Command, Stdio};

use std::sync::Mutex;



use serde::Serialize;

use tauri::{AppHandle, Emitter, Manager};



pub struct EbookConvertState {

    active: Mutex<Option<ActiveJob>>,

}



struct ActiveJob {

    job_id: String,

    child: Child,

    /// Paths written during the job that should be removed on cancel.

    cleanup_paths: Vec<PathBuf>,

}



impl EbookConvertState {

    pub fn new() -> Self {

        Self {

            active: Mutex::new(None),

        }

    }

}



#[derive(Clone, Copy, Debug, PartialEq, Eq)]

pub enum ConvertOutputKind {

    Epub,

    Markdown,

}



#[derive(Clone, Serialize)]

#[serde(rename_all = "camelCase")]

pub struct EbookConvertProgressPayload {

    pub job_id: String,

    pub ratio: f64,

}



#[derive(Clone, Serialize)]

#[serde(rename_all = "camelCase")]

pub struct EbookConvertDonePayload {

    pub job_id: String,

    pub ok: bool,

    pub error: Option<String>,

}



const PROGRESS_EVENT: &str = "ebook-convert-progress";

const DONE_EVENT: &str = "ebook-convert-done";



fn trim_stderr_tail(stderr: &str, max_chars: usize) -> String {

    let trimmed = stderr.trim();

    if trimmed.len() <= max_chars {

        return trimmed.to_string();

    }

    trimmed

        .chars()

        .skip(trimmed.len() - max_chars)

        .collect()

}



fn parse_progress_ratio(line: &str) -> Option<f64> {

    for token in line.split_whitespace() {

        if let Some(num) = token.strip_suffix('%') {

            if let Ok(value) = num.parse::<f64>() {

                return Some((value / 100.0).clamp(0.0, 1.0));

            }

        }

    }

    None

}



fn calibre_exe_name() -> &'static str {

    if cfg!(windows) {

        "ebook-convert.exe"

    } else {

        "ebook-convert"

    }

}



fn calibre_candidates() -> Vec<PathBuf> {

    let mut candidates = Vec::new();



    if let Ok(dir) = std::env::var("SAK_CALIBRE_DIR") {

        candidates.push(PathBuf::from(dir));

    }



    candidates.push(

        PathBuf::from(env!("CARGO_MANIFEST_DIR"))

            .join("resources")

            .join("calibre"),

    );



    #[cfg(windows)]

    {

        candidates.push(PathBuf::from(r"C:\Program Files\Calibre2"));

        candidates.push(PathBuf::from(r"C:\Program Files (x86)\Calibre2"));

    }



    candidates

}



fn find_ebook_convert_dir(root: &Path) -> Option<PathBuf> {

    let direct = root.join(calibre_exe_name());

    if direct.is_file() {

        return Some(root.to_path_buf());

    }



    let entries = std::fs::read_dir(root).ok()?;

    for entry in entries.flatten() {

        let path = entry.path();

        if path.is_dir() {

            if let Some(found) = find_ebook_convert_dir(&path) {

                return Some(found);

            }

        }

    }



    None

}



fn resolve_calibre_root(app: &AppHandle) -> Result<PathBuf, String> {

    if let Ok(resource_dir) = app.path().resource_dir() {

        let bundled = resource_dir.join("calibre");

        if let Some(dir) = find_ebook_convert_dir(&bundled) {

            return Ok(dir);

        }

    }



    for candidate in calibre_candidates() {

        if let Some(dir) = find_ebook_convert_dir(&candidate) {

            return Ok(dir);

        }

    }



    Err(

        "Calibre runtime not found. Run `node scripts/setup-calibre.mjs` to download it."

            .to_string(),

    )

}



pub fn resolve_ebook_convert_exe(app: &AppHandle) -> Result<PathBuf, String> {

    let root = resolve_calibre_root(app)?;

    let exe = root.join(calibre_exe_name());

    if exe.is_file() {

        Ok(exe)

    } else {

        Err(format!(

            "ebook-convert not found in {}",

            root.to_string_lossy()

        ))

    }

}



pub fn read_ebook_convert_version(app: &AppHandle) -> Result<String, String> {

    let exe = resolve_ebook_convert_exe(app)?;

    let output = Command::new(&exe)

        .arg("--version")

        .output()

        .map_err(|e| format!("failed to run ebook-convert: {e}"))?;



    if !output.status.success() {

        return Err(trim_stderr_tail(

            &String::from_utf8_lossy(&output.stderr),

            500,

        ));

    }



    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();

    if version.is_empty() {

        Ok("unknown".to_string())

    } else {

        Ok(version)

    }

}



fn extension_lower(path: &Path) -> String {

    path.extension()

        .and_then(|e| e.to_str())

        .map(|e| e.to_ascii_lowercase())

        .unwrap_or_default()

}



fn validate_pdf_source(path: &Path) -> Result<(), String> {

    if !path.is_file() {

        return Err("source file not found".to_string());

    }



    if extension_lower(path) != "pdf" {

        return Err("source must be a .pdf file".to_string());

    }



    Ok(())

}



fn validate_epub_output(path: &Path) -> Result<(), String> {

    if extension_lower(path) != "epub" {

        return Err("output must be a .epub file".to_string());

    }

    Ok(())

}



fn validate_markdown_output(path: &Path) -> Result<(), String> {

    if extension_lower(path) != "md" {

        return Err("output must be a .md file".to_string());

    }

    Ok(())

}



/// Sibling temp path Calibre writes for Markdown (TXT plugin → rename to .md).

pub fn markdown_temp_txt_path(md_path: &Path) -> PathBuf {

    let mut temp = md_path.to_path_buf();

    temp.set_extension("sak-md-tmp.txt");

    temp

}



pub fn build_convert_args(

    source_path: &str,

    output_path: &str,

    title: Option<&str>,

) -> Vec<String> {

    let mut args = vec![

        source_path.to_string(),

        output_path.to_string(),

        "--enable-heuristics".to_string(),

    ];



    if let Some(title) = title.map(str::trim).filter(|t| !t.is_empty()) {

        args.push("--title".to_string());

        args.push(title.to_string());

    }



    args

}



pub fn build_markdown_convert_args(

    source_path: &str,

    temp_txt_path: &str,

    title: Option<&str>,

) -> Vec<String> {

    let mut args = build_convert_args(source_path, temp_txt_path, title);

    args.push("--txt-output-formatting".to_string());

    args.push("markdown".to_string());

    args

}



fn remove_paths(paths: &[PathBuf]) {

    for path in paths {

        let _ = std::fs::remove_file(path);

    }

}



pub async fn run_ebook_convert_job(

    app: &AppHandle,

    state: &EbookConvertState,

    job_id: String,

    source_path: String,

    output_path: String,

    title: Option<String>,

    kind: ConvertOutputKind,

) -> Result<(bool, Option<String>), String> {

    if state

        .active

        .lock()

        .map_err(|e| e.to_string())?

        .is_some()

    {

        return Err("another ebook conversion is already running".to_string());

    }



    let source = PathBuf::from(&source_path);

    let out_path = PathBuf::from(&output_path);

    validate_pdf_source(&source)?;



    let (calibre_output, cleanup_paths, args) = match kind {

        ConvertOutputKind::Epub => {

            validate_epub_output(&out_path)?;

            if out_path.exists() {

                return Err("target already exists".to_string());

            }

            let args = build_convert_args(&source_path, &output_path, title.as_deref());

            (out_path.clone(), vec![out_path.clone()], args)

        }

        ConvertOutputKind::Markdown => {

            validate_markdown_output(&out_path)?;

            if out_path.exists() {

                return Err("target already exists".to_string());

            }

            let temp_txt = markdown_temp_txt_path(&out_path);

            if temp_txt.exists() {

                return Err("temporary conversion file already exists".to_string());

            }

            let temp_str = temp_txt.to_string_lossy().into_owned();

            let args = build_markdown_convert_args(&source_path, &temp_str, title.as_deref());

            (

                temp_txt.clone(),

                vec![temp_txt, out_path.clone()],

                args,

            )

        }

    };



    let calibre_root = resolve_calibre_root(app)?;

    let exe = calibre_root.join(calibre_exe_name());



    let mut command = Command::new(&exe);

    command

        .args(&args)

        .current_dir(&calibre_root)

        .stdout(Stdio::null())

        .stderr(Stdio::piped());



    #[cfg(windows)]

    {

        use std::os::windows::process::CommandExt;

        const CREATE_NO_WINDOW: u32 = 0x08000000;

        command.creation_flags(CREATE_NO_WINDOW);

    }



    let mut child = command

        .spawn()

        .map_err(|e| format!("failed to start ebook-convert: {e}"))?;



    let stderr = child

        .stderr

        .take()

        .ok_or_else(|| "failed to capture ebook-convert stderr".to_string())?;



    state

        .active

        .lock()

        .map_err(|e| e.to_string())?

        .replace(ActiveJob {

            job_id: job_id.clone(),

            child,

            cleanup_paths: cleanup_paths.clone(),

        });



    let app_for_reader = app.clone();

    let job_id_for_reader = job_id.clone();

    let reader = tauri::async_runtime::spawn(async move {

        let reader = BufReader::new(stderr);

        let mut stderr_text = String::new();

        let mut last_ratio = 0.0_f64;



        for line in reader.lines().map_while(Result::ok) {

            stderr_text.push_str(&line);

            stderr_text.push('\n');

            if let Some(ratio) = parse_progress_ratio(&line) {

                if ratio > last_ratio {

                    last_ratio = ratio;

                    let _ = app_for_reader.emit(

                        PROGRESS_EVENT,

                        EbookConvertProgressPayload {

                            job_id: job_id_for_reader.clone(),

                            ratio,

                        },

                    );

                }

            }

        }



        stderr_text

    });



    let mut exit_ok = false;

    let mut cancelled = false;



    loop {

        let finished = {

            let mut guard = state.active.lock().map_err(|e| e.to_string())?;

            match guard.as_mut() {

                Some(job) if job.job_id == job_id => match job.child.try_wait() {

                    Ok(Some(status)) => {

                        exit_ok = status.success();

                        guard.take();

                        true

                    }

                    Ok(None) => false,

                    Err(e) => {

                        guard.take();

                        return Err(format!("failed while waiting for ebook-convert: {e}"));

                    }

                },

                Some(_) => {

                    return Err("job id does not match active conversion".to_string());

                }

                None => {

                    cancelled = true;

                    true

                }

            }

        };



        if finished {

            break;

        }



        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    }



    let stderr = reader.await.map_err(|e| e.to_string())?;



    let mut ok = exit_ok && !cancelled;

    let mut error = if ok {

        None

    } else if cancelled {

        Some("cancelled".to_string())

    } else {

        Some(trim_stderr_tail(&stderr, 2000))

    };



    if ok && kind == ConvertOutputKind::Markdown {

        if !calibre_output.is_file() {

            ok = false;

            error = Some("conversion produced no output file".to_string());

            remove_paths(&cleanup_paths);

        } else if let Err(e) = std::fs::rename(&calibre_output, &out_path) {

            // Cross-device rename can fail; fall back to copy + delete.

            match std::fs::copy(&calibre_output, &out_path) {

                Ok(_) => {

                    let _ = std::fs::remove_file(&calibre_output);

                }

                Err(copy_err) => {

                    ok = false;

                    error = Some(format!(

                        "failed to finalize markdown output: {e}; copy fallback: {copy_err}"

                    ));

                    remove_paths(&cleanup_paths);

                }

            }

        }

    }



    if !ok {

        remove_paths(&cleanup_paths);

    }



    let _ = app.emit(

        DONE_EVENT,

        EbookConvertDonePayload {

            job_id: job_id.clone(),

            ok,

            error: error.clone(),

        },

    );



    Ok((ok, error))

}



pub fn cancel_job(state: &EbookConvertState, job_id: &str) -> Result<(), String> {

    let mut guard = state.active.lock().map_err(|e| e.to_string())?;

    let job = guard.take();

    if job.is_none() {

        return Err("no active ebook conversion".to_string());

    }

    let mut job = job.unwrap();

    if job.job_id != job_id {

        *guard = Some(job);

        return Err("job id does not match active conversion".to_string());

    }



    remove_paths(&job.cleanup_paths);

    job.cleanup_paths.clear();



    job.child.kill().map_err(|e| e.to_string())?;

    Ok(())

}



#[cfg(test)]

mod tests {

    use super::*;



    #[test]

    fn parse_progress_ratio_reads_percent_tokens() {

        assert_eq!(parse_progress_ratio("  42%"), Some(0.42));

        assert_eq!(parse_progress_ratio("Converting input 100%"), Some(1.0));

        assert_eq!(parse_progress_ratio("no progress here"), None);

    }



    #[test]

    fn build_convert_args_includes_title_when_present() {

        let args = build_convert_args("in.pdf", "out.epub", Some("My Book"));

        assert_eq!(args[0], "in.pdf");

        assert_eq!(args[1], "out.epub");

        assert!(args.contains(&"--title".to_string()));

        assert!(args.contains(&"My Book".to_string()));

    }



    #[test]

    fn build_convert_args_omits_blank_title() {

        let args = build_convert_args("in.pdf", "out.epub", Some("   "));

        assert!(!args.contains(&"--title".to_string()));

    }



    #[test]

    fn build_markdown_convert_args_sets_txt_markdown_formatting() {

        let args = build_markdown_convert_args("in.pdf", "out.sak-md-tmp.txt", Some("Doc"));

        assert_eq!(args[0], "in.pdf");

        assert_eq!(args[1], "out.sak-md-tmp.txt");

        assert!(args.contains(&"--txt-output-formatting".to_string()));

        assert!(args.contains(&"markdown".to_string()));

        assert!(args.contains(&"--title".to_string()));

        assert!(args.contains(&"Doc".to_string()));

    }



    #[test]

    fn markdown_temp_txt_path_swaps_extension() {

        let path = markdown_temp_txt_path(Path::new(r"C:\docs\report.md"));

        assert_eq!(path, PathBuf::from(r"C:\docs\report.sak-md-tmp.txt"));

    }

}


