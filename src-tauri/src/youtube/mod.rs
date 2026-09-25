use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

use crate::ytdlp::{
    self, bump_output_path, command_no_window, is_retryable_download_error,
    parse_download_percent, resolve_sidecar_path, sanitize_filename, trim_stderr_tail,
    YtdlpState, YTDLP_RETRY_SLEEP_MS,
};

const PROGRESS_EVENT: &str = "youtube-progress";
const DONE_EVENT: &str = "youtube-done";
const RESOLVE_TIMEOUT_SECS: u64 = 60;
const DEFAULT_MAX_HEIGHT: u32 = 1080;
/// Full list — android last (often only low-res progressive under SABR).
const YTDLP_VIDEO_PLAYER_CLIENT_FALLBACKS: &[&str] = &[
    "youtube:player_client=default,-android_sdkless",
    "youtube:player_client=tv_simply",
    "youtube:player_client=mweb",
    "youtube:player_client=android",
];
/// High-res requests skip android — it frequently "succeeds" at ~360p and hides 403s.
const YTDLP_VIDEO_PLAYER_CLIENT_FALLBACKS_HIRES: &[&str] = &[
    "youtube:player_client=default,-android_sdkless",
    "youtube:player_client=tv_simply",
    "youtube:player_client=mweb",
];
/// English manual + auto (incl. en-GB). Keep this narrow — broad `all`/`nl` lists
/// hit YouTube HTTP 429 and abort the whole download.
const YTDLP_SUB_LANGS: &str = "en.*,en";

fn player_client_fallbacks(max_height: u32) -> &'static [&'static str] {
    let max_height = normalize_max_height(max_height);
    if max_height == 0 || max_height >= 1080 {
        YTDLP_VIDEO_PLAYER_CLIENT_FALLBACKS_HIRES
    } else {
        YTDLP_VIDEO_PLAYER_CLIENT_FALLBACKS
    }
}
const MAX_OUTPUT_STEM_CHARS: usize = 120;
const VIDEO_ID_LEN: usize = 11;

/// Normalize a UI quality preset to max height (0 = best / uncapped).
pub fn normalize_max_height(value: u32) -> u32 {
    match value {
        0 | 480 | 720 | 1080 | 1440 | 2160 => value,
        _ => DEFAULT_MAX_HEIGHT,
    }
}

fn max_width_for_height(max_height: u32) -> u32 {
    match max_height {
        2160 => 3840,
        1440 => 2560,
        1080 => 1920,
        720 => 1280,
        480 => 854,
        _ => 1920,
    }
}

/// Build yt-dlp `-f` selector for a max height (0 = best available).
/// For ≤1080p prefer AVC (fewer mid-download 403s). For 1440/4K prefer highest
/// matching DASH first (AVC rarely exists above 1080).
pub fn video_format_selector(max_height: u32) -> String {
    let max_height = normalize_max_height(max_height);
    if max_height == 0 {
        return concat!(
            "bv*[ext=mp4]+ba[ext=m4a]/",
            "bv*+ba/b"
        )
        .to_string();
    }
    let w = max_width_for_height(max_height);
    let h = max_height;
    if h <= 1080 {
        format!(
            "bv*[width<={w}][height<={h}][vcodec^=avc1]+ba[acodec^=mp4a]/bv*[width<={w}][height<={h}][ext=mp4]+ba[ext=m4a]/bv*[width<={w}][height<={h}]+ba/b[width<={w}][height<={h}]"
        )
    } else {
        format!(
            "bv*[width<={w}][height<={h}][ext=mp4]+ba[ext=m4a]/bv*[width<={w}][height<={h}]+ba/b[width<={w}][height<={h}]"
        )
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YoutubeResolveResult {
    pub title: String,
    pub channel: Option<String>,
    pub duration_secs: Option<f64>,
    pub thumbnail_url: Option<String>,
    pub webpage_url: String,
    pub video_id: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YoutubeDownloadResult {
    pub ok: bool,
    pub error: Option<String>,
    pub path: Option<String>,
    #[serde(default)]
    pub subtitle_paths: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YoutubeProgressPayload {
    pub job_id: String,
    pub ratio: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YoutubeDonePayload {
    pub job_id: String,
    pub ok: bool,
    pub error: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Deserialize)]
struct YtdlpVideoMeta {
    id: Option<String>,
    title: Option<String>,
    channel: Option<String>,
    uploader: Option<String>,
    duration: Option<f64>,
    thumbnail: Option<String>,
    webpage_url: Option<String>,
    #[serde(default)]
    thumbnails: Vec<YtdlpThumbnail>,
}

#[derive(Debug, Deserialize)]
struct YtdlpThumbnail {
    url: Option<String>,
}

/// Strict YouTube single-video URL gate. Returns a canonical watch URL + video id.
pub fn parse_youtube_video_url(raw: &str) -> Result<(String, String), String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("paste a YouTube video URL".to_string());
    }

    let parsed = reqwest::Url::parse(trimmed).map_err(|_| {
        "invalid URL — paste a full YouTube link (https://www.youtube.com/watch?v=… or youtu.be/…)"
            .to_string()
    })?;

    if parsed.scheme() != "https" {
        return Err("URL must start with https://".to_string());
    }

    let host = parsed
        .host_str()
        .ok_or_else(|| "URL is missing a host".to_string())?
        .to_ascii_lowercase();

    let video_id = match host.as_str() {
        "youtu.be" => {
            let id = parsed
                .path_segments()
                .and_then(|mut s| s.next())
                .unwrap_or("")
                .trim();
            validate_video_id(id)?
        }
        "youtube.com" | "www.youtube.com" | "m.youtube.com" | "music.youtube.com" => {
            extract_youtube_com_video_id(&parsed)?
        }
        _ => {
            return Err(
                "only youtube.com / music.youtube.com / youtu.be video links are supported"
                    .to_string(),
            );
        }
    };

    Ok((
        format!("https://www.youtube.com/watch?v={video_id}"),
        video_id,
    ))
}

fn validate_video_id(id: &str) -> Result<String, String> {
    if id.len() == VIDEO_ID_LEN
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        Ok(id.to_string())
    } else {
        Err("could not find a valid YouTube video id in that URL".to_string())
    }
}

fn extract_youtube_com_video_id(parsed: &reqwest::Url) -> Result<String, String> {
    let segments: Vec<&str> = parsed
        .path_segments()
        .map(|s| s.filter(|p| !p.is_empty()).collect())
        .unwrap_or_default();

    if segments.is_empty() {
        return Err("URL path does not point to a video".to_string());
    }

    let first = segments[0].to_ascii_lowercase();
    match first.as_str() {
        "watch" => {
            let id = parsed
                .query_pairs()
                .find(|(k, _)| k == "v")
                .map(|(_, v)| v.to_string())
                .unwrap_or_default();
            validate_video_id(id.trim())
        }
        "shorts" | "live" | "embed" | "v" => {
            let id = segments.get(1).copied().unwrap_or("");
            validate_video_id(id)
        }
        "playlist" | "channel" | "c" | "user" | "feed" | "results" => Err(
            "playlists, channels, and search pages are not supported — paste a single video link"
                .to_string(),
        ),
        _ if first.starts_with('@') => Err(
            "channel pages are not supported — paste a single video link".to_string(),
        ),
        _ => Err(
            "unsupported YouTube URL — paste a watch, Shorts, live, or youtu.be link".to_string(),
        ),
    }
}

pub fn truncate_title_stem(title: &str) -> String {
    let cleaned = sanitize_filename(title);
    if cleaned.chars().count() <= MAX_OUTPUT_STEM_CHARS {
        return cleaned;
    }
    cleaned
        .chars()
        .take(MAX_OUTPUT_STEM_CHARS)
        .collect::<String>()
        .trim_end()
        .to_string()
}

fn pick_thumbnail(meta: &YtdlpVideoMeta) -> Option<String> {
    if let Some(url) = meta.thumbnail.as_ref().filter(|u| !u.is_empty()) {
        return Some(url.clone());
    }
    meta.thumbnails
        .iter()
        .rev()
        .find_map(|t| t.url.clone().filter(|u| !u.is_empty()))
}

fn build_common_sidecar_args(
    app: &AppHandle,
    player_client_args: &str,
) -> Result<Vec<String>, String> {
    let deno = resolve_sidecar_path(app, "deno")?;
    let deno_arg = format!("deno:{}", deno.to_string_lossy());
    Ok(vec![
        "--no-warnings".to_string(),
        "--no-playlist".to_string(),
        "--extractor-args".to_string(),
        player_client_args.to_string(),
        "--js-runtimes".to_string(),
        deno_arg,
    ])
}

fn build_video_download_args(
    app: &AppHandle,
    output_path: &Path,
    download_url: &str,
    player_client_args: &str,
    max_height: u32,
    write_subs: bool,
) -> Result<Vec<String>, String> {
    let ffmpeg = resolve_sidecar_path(app, "ffmpeg")?;
    // skip=translated_subs avoids hundreds of auto-translated tracks (HTTP 429).
    let extractor_args = if write_subs {
        format!("{player_client_args};skip=translated_subs")
    } else {
        player_client_args.to_string()
    };
    let mut args = build_common_sidecar_args(app, &extractor_args)?;
    args.extend([
        "--newline".to_string(),
        "--retries".to_string(),
        "5".to_string(),
        "--fragment-retries".to_string(),
        "5".to_string(),
        "-f".to_string(),
        video_format_selector(max_height),
        "--merge-output-format".to_string(),
        "mp4".to_string(),
        "--remux-video".to_string(),
        "mp4".to_string(),
        "--ffmpeg-location".to_string(),
        ffmpeg.to_string_lossy().to_string(),
        "--no-overwrites".to_string(),
    ]);
    if write_subs {
        args.extend([
            "--write-subs".to_string(),
            "--write-auto-subs".to_string(),
            "--sub-langs".to_string(),
            YTDLP_SUB_LANGS.to_string(),
            "--convert-subs".to_string(),
            "srt".to_string(),
        ]);
    }
    // Use %(ext)s so sidecars are `stem.en.srt`, not `stem.mp4.en.srt`.
    let output_template = match output_path.parent() {
        Some(parent) => {
            let stem = output_path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("video");
            parent.join(format!("{stem}.%(ext)s"))
        }
        None => PathBuf::from(format!(
            "{}.%(ext)s",
            output_path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("video")
        )),
    };
    args.extend([
        "-o".to_string(),
        output_template.to_string_lossy().to_string(),
        download_url.to_string(),
    ]);
    Ok(args)
}

fn run_ytdlp_json_sync(
    ytdlp: &Path,
    args: &[String],
) -> Result<(bool, String, String), String> {
    let output = command_no_window(ytdlp)
        .args(args)
        .output()
        .map_err(|e| format!("failed to run yt-dlp: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    Ok((output.status.success(), stdout, stderr))
}

pub async fn resolve_youtube_video(
    app: &AppHandle,
    url: String,
) -> Result<YoutubeResolveResult, String> {
    let (canonical, video_id) = parse_youtube_video_url(&url)?;
    let ytdlp = resolve_sidecar_path(app, "yt-dlp")?;

    let mut last_error = None;
    for player_client_args in YTDLP_VIDEO_PLAYER_CLIENT_FALLBACKS {
        let mut args = build_common_sidecar_args(app, player_client_args)?;
        args.extend([
            "-J".to_string(),
            "--skip-download".to_string(),
            canonical.clone(),
        ]);

        let ytdlp_path = ytdlp.clone();
        let args_owned = args.clone();
        let timed = tokio::time::timeout(
            Duration::from_secs(RESOLVE_TIMEOUT_SECS),
            tokio::task::spawn_blocking(move || run_ytdlp_json_sync(&ytdlp_path, &args_owned)),
        )
        .await;

        let (ok, stdout, stderr) = match timed {
            Ok(Ok(inner)) => inner?,
            Ok(Err(e)) => return Err(format!("yt-dlp resolve task failed: {e}")),
            Err(_) => {
                last_error = Some("timed out resolving video metadata".to_string());
                continue;
            }
        };

        if !ok {
            last_error = Some(trim_stderr_tail(&stderr, 1500));
            if !is_retryable_download_error(last_error.as_deref().unwrap_or(""))
                && !stderr.to_ascii_lowercase().contains("sign in")
                && !stderr.to_ascii_lowercase().contains("confirm your age")
            {
                // Still try next client for extractor quirks.
            }
            continue;
        }

        let meta: YtdlpVideoMeta = serde_json::from_str(stdout.trim()).map_err(|e| {
            format!(
                "failed to parse yt-dlp metadata: {e}; {}",
                trim_stderr_tail(&stdout, 400)
            )
        })?;

        let thumbnail_url = pick_thumbnail(&meta);
        let duration_secs = meta.duration;
        let id = meta
            .id
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| video_id.clone());
        let title = meta
            .title
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "Untitled".to_string());
        let channel = meta
            .channel
            .or(meta.uploader)
            .filter(|s| !s.trim().is_empty());
        let webpage_url = meta
            .webpage_url
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| canonical.clone());

        return Ok(YoutubeResolveResult {
            title,
            channel,
            duration_secs,
            thumbnail_url,
            webpage_url,
            video_id: id,
        });
    }

    Err(last_error.unwrap_or_else(|| "could not resolve YouTube video".to_string()))
}

fn cleanup_job_temps(output_path: &Path, clean_subs: bool) {
    let Some(parent) = output_path.parent() else {
        return;
    };
    let Some(stem) = output_path.file_stem() else {
        return;
    };
    let stem = stem.to_string_lossy();
    let final_name = output_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    if let Ok(entries) = std::fs::read_dir(parent) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.as_ref() == final_name {
                continue;
            }
            let remove = is_ytdlp_temp_for_stem(name.as_ref(), stem.as_ref())
                || (clean_subs && is_subtitle_for_stem(name.as_ref(), stem.as_ref()));
            if remove {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

/// Collect `.srt` / `.vtt` sidecars written next to the video for this stem.
pub fn collect_subtitle_paths(output_path: &Path) -> Vec<String> {
    let Some(parent) = output_path.parent() else {
        return Vec::new();
    };
    let Some(stem) = output_path.file_stem() else {
        return Vec::new();
    };
    let stem = stem.to_string_lossy();
    let mut paths = Vec::new();
    if let Ok(entries) = std::fs::read_dir(parent) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if is_subtitle_for_stem(name.as_ref(), stem.as_ref()) && entry.path().is_file() {
                paths.push(entry.path().to_string_lossy().to_string());
            }
        }
    }
    paths.sort();
    paths
}

fn is_subtitle_for_stem(name: &str, stem: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if !(lower.ends_with(".srt") || lower.ends_with(".vtt")) {
        return false;
    }
    let stem_lower = stem.to_ascii_lowercase();
    // Expected with `stem.%(ext)s`: stem.en.srt
    if lower == format!("{stem_lower}.srt") || lower == format!("{stem_lower}.vtt") {
        return true;
    }
    if lower.starts_with(&format!("{stem_lower}.")) {
        return true;
    }
    // Legacy / literal `-o stem.mp4` naming: stem.mp4.en.srt
    if lower.starts_with(&format!("{stem_lower}.mp4.")) {
        return true;
    }
    false
}

/// Only remove temps that clearly belong to this output stem (not sibling user files).
fn is_ytdlp_temp_for_stem(name: &str, stem: &str) -> bool {
    let exact = [
        format!("{stem}.part"),
        format!("{stem}.ytdl"),
        format!("{stem}.mp4.part"),
        format!("{stem}.temp.mp4"),
    ];
    if exact.iter().any(|n| n == name) {
        return true;
    }
    // yt-dlp fragment names: {stem}.f137.mp4, {stem}.f140.m4a, optionally .part
    let prefix = format!("{stem}.f");
    if !name.starts_with(&prefix) {
        return false;
    }
    let rest = &name[prefix.len()..];
    let base = rest.strip_suffix(".part").unwrap_or(rest);
    base.chars().next().is_some_and(|c| c.is_ascii_digit())
        && (base.ends_with(".mp4")
            || base.ends_with(".m4a")
            || base.ends_with(".webm")
            || base.ends_with(".mkv"))
}

fn remove_output_if_present(output_path: &Path, clean_subs: bool) {
    if output_path.is_file() {
        let _ = std::fs::remove_file(output_path);
    }
    cleanup_job_temps(output_path, clean_subs);
}

async fn run_single_video_download(
    app: &AppHandle,
    state: &YtdlpState,
    job_id: &str,
    download_url: &str,
    output_path: &Path,
    player_client_args: &str,
    max_height: u32,
    write_subs: bool,
) -> Result<(bool, Option<String>), String> {
    let args = build_video_download_args(
        app,
        output_path,
        download_url,
        player_client_args,
        max_height,
        write_subs,
    )?;

    let (mut rx, child) = app
        .shell()
        .sidecar("yt-dlp")
        .map_err(|e| e.to_string())?
        .args(args)
        .spawn()
        .map_err(|e| e.to_string())?;

    if let Err(_err) = state.attach_child(job_id, child) {
        return Ok((false, Some("cancelled".to_string())));
    }

    let mut stderr = String::new();
    let mut stdout_buf = String::new();
    let mut stderr_buf = String::new();
    let mut exit_code: Option<i32> = None;
    let mut stage_index: u32 = 0;
    let mut last_stage_ratio = 0.0;
    // Assume up to 3 stages (video, audio, merge) for rough overall progress.
    const MAX_STAGES: f64 = 3.0;

    let process_line = |line: &str, stage_index: &mut u32, last_stage_ratio: &mut f64| -> Option<f64> {
        let lower = line.to_ascii_lowercase();
        if lower.contains("[download]") && lower.contains("destination") {
            *stage_index = stage_index.saturating_add(1);
            *last_stage_ratio = 0.0;
        }
        if let Some(ratio) = parse_download_percent(line) {
            if ratio + 0.001 < *last_stage_ratio {
                *stage_index = stage_index.saturating_add(1);
            }
            *last_stage_ratio = ratio;
            let overall = ((*stage_index as f64) + ratio) / MAX_STAGES;
            return Some(overall.clamp(0.0, 0.99));
        }
        None
    };

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                let chunk = String::from_utf8_lossy(&bytes);
                stdout_buf.push_str(&chunk);
                while let Some(pos) = stdout_buf.find('\n') {
                    let line = stdout_buf[..pos].trim_end_matches('\r').to_string();
                    stdout_buf.drain(..=pos);
                    if let Some(ratio) =
                        process_line(&line, &mut stage_index, &mut last_stage_ratio)
                    {
                        let _ = app.emit(
                            PROGRESS_EVENT,
                            YoutubeProgressPayload {
                                job_id: job_id.to_string(),
                                ratio,
                            },
                        );
                    }
                }
            }
            CommandEvent::Stderr(bytes) => {
                let chunk = String::from_utf8_lossy(&bytes);
                stderr.push_str(&chunk);
                stderr_buf.push_str(&chunk);
                while let Some(pos) = stderr_buf.find('\n') {
                    let line = stderr_buf[..pos].trim_end_matches('\r').to_string();
                    stderr_buf.drain(..=pos);
                    if let Some(ratio) =
                        process_line(&line, &mut stage_index, &mut last_stage_ratio)
                    {
                        let _ = app.emit(
                            PROGRESS_EVENT,
                            YoutubeProgressPayload {
                                job_id: job_id.to_string(),
                                ratio,
                            },
                        );
                    }
                }
            }
            CommandEvent::Terminated(payload) => {
                exit_code = payload.code;
                break;
            }
            CommandEvent::Error(message) => {
                stderr.push_str(&message);
                break;
            }
            _ => {}
        }
    }

    let was_cancelled = state.clear_child(job_id)?;

    let path_ok = output_path.is_file()
        && output_path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("mp4"));
    let ok = exit_code == Some(0) && path_ok;

    if ok {
        let _ = app.emit(
            PROGRESS_EVENT,
            YoutubeProgressPayload {
                job_id: job_id.to_string(),
                ratio: 1.0,
            },
        );
    }

    let error = if ok {
        None
    } else if was_cancelled {
        remove_output_if_present(output_path, write_subs);
        Some("cancelled".to_string())
    } else if exit_code == Some(0) && !path_ok {
        remove_output_if_present(output_path, write_subs);
        Some("download finished but MP4 output was not found".to_string())
    } else {
        remove_output_if_present(output_path, write_subs);
        Some(trim_stderr_tail(&stderr, 2000))
    };

    Ok((ok, error))
}

async fn run_video_download_with_fallbacks(
    app: &AppHandle,
    state: &YtdlpState,
    job_id: &str,
    download_url: &str,
    output_path: &Path,
    max_height: u32,
    write_subs: bool,
) -> Result<(bool, Option<String>), String> {
    let mut last_error = None;
    let mut attempt = 0usize;

    for player_client_args in player_client_fallbacks(max_height) {
        if attempt > 0 {
            remove_output_if_present(output_path, write_subs);
            tokio::time::sleep(Duration::from_millis(YTDLP_RETRY_SLEEP_MS)).await;
        }

        let (ok, error) = run_single_video_download(
            app,
            state,
            job_id,
            download_url,
            output_path,
            player_client_args,
            max_height,
            write_subs,
        )
        .await?;

        attempt += 1;

        if ok {
            return Ok((true, None));
        }
        if error.as_deref() == Some("cancelled") {
            return Ok((false, error));
        }

        last_error = error.clone();
        if !error.as_deref().is_some_and(is_retryable_download_error) {
            // Still try next player client — format availability differs by client.
            continue;
        }
    }

    let mut final_error = last_error.unwrap_or_else(|| "download failed".to_string());
    if final_error.to_ascii_lowercase().contains("403") {
        final_error = format!(
            "{final_error}\nTip: update yt-dlp with `node scripts/setup-music-tools.mjs` and try again."
        );
    }
    Ok((false, Some(final_error)))
}

pub async fn run_youtube_download(
    app: &AppHandle,
    state: &YtdlpState,
    job_id: String,
    url: String,
    output_dir: String,
    title_hint: Option<String>,
    max_height: Option<u32>,
    write_subs: Option<bool>,
) -> Result<YoutubeDownloadResult, String> {
    let (canonical, _video_id) = parse_youtube_video_url(&url)?;
    let dir = PathBuf::from(&output_dir);
    if !dir.is_dir() {
        return Err("output folder not found".to_string());
    }

    let max_height = normalize_max_height(max_height.unwrap_or(DEFAULT_MAX_HEIGHT));
    let write_subs = write_subs.unwrap_or(true);
    let stem = title_hint
        .filter(|s| !s.trim().is_empty())
        .map(|s| truncate_title_stem(&s))
        .unwrap_or_else(|| "video".to_string());
    let output_path = bump_output_path(&dir, &stem, "mp4")?;

    state.try_reserve(&job_id)?;

    let outcome = run_video_download_with_fallbacks(
        app,
        state,
        &job_id,
        &canonical,
        &output_path,
        max_height,
        write_subs,
    )
    .await;

    let _ = state.release(&job_id);

    let (ok, error) = outcome?;
    let path = if ok {
        Some(output_path.to_string_lossy().to_string())
    } else {
        None
    };
    let subtitle_paths = if ok && write_subs {
        collect_subtitle_paths(&output_path)
    } else {
        Vec::new()
    };

    let result = YoutubeDownloadResult {
        ok,
        error: error.clone(),
        path: path.clone(),
        subtitle_paths,
    };

    let _ = app.emit(
        DONE_EVENT,
        YoutubeDonePayload {
            job_id,
            ok,
            error,
            path,
        },
    );

    Ok(result)
}

pub fn cancel_youtube_job(state: &YtdlpState, job_id: &str) -> Result<(), String> {
    ytdlp::cancel_job(state, job_id)
}

#[cfg(test)]
fn build_video_format_args_for_test() -> Vec<String> {
    vec![
        "-f".to_string(),
        video_format_selector(1080),
        "--merge-output-format".to_string(),
        "mp4".to_string(),
        "--remux-video".to_string(),
        "mp4".to_string(),
        "--no-playlist".to_string(),
        "--no-overwrites".to_string(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn accepts_watch_shorts_and_youtu_be() {
        let cases = [
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://youtube.com/watch?v=dQw4w9WgXcQ&list=PLxxxx",
            "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://youtu.be/dQw4w9WgXcQ",
            "https://www.youtube.com/shorts/dQw4w9WgXcQ",
            "https://www.youtube.com/live/dQw4w9WgXcQ",
            "https://www.youtube.com/embed/dQw4w9WgXcQ",
        ];
        for url in cases {
            let (canonical, id) = parse_youtube_video_url(url).expect(url);
            assert_eq!(id, "dQw4w9WgXcQ");
            assert_eq!(canonical, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
        }
    }

    #[test]
    fn rejects_hostile_and_non_video_urls() {
        let cases = [
            "https://notyoutube.com/watch?v=dQw4w9WgXcQ",
            "https://example.com/?u=https://youtube.com/watch?v=dQw4w9WgXcQ",
            "https://www.youtube.com/playlist?list=PLxxxx",
            "https://www.youtube.com/@SomeChannel",
            "https://www.youtube.com/channel/UCxxxx",
            "https://www.youtube.com/results?search_query=test",
            "http://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "ftp://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://youtu.be/short",
            "",
        ];
        for url in cases {
            assert!(parse_youtube_video_url(url).is_err(), "should reject {url}");
        }
    }

    #[test]
    fn ytdlp_temp_matcher_is_stem_specific() {
        assert!(is_ytdlp_temp_for_stem("clip.f137.mp4", "clip"));
        assert!(is_ytdlp_temp_for_stem("clip.f140.m4a.part", "clip"));
        assert!(is_ytdlp_temp_for_stem("clip.part", "clip"));
        assert!(!is_ytdlp_temp_for_stem("clip.final.mp4", "clip"));
        assert!(!is_ytdlp_temp_for_stem("clipography.webm", "clip"));
        assert!(!is_ytdlp_temp_for_stem("other.f137.mp4", "clip"));
    }

    #[test]
    fn sanitize_blocks_template_and_reserved_names() {
        assert!(!sanitize_filename("100%(complete)").contains('%'));
        assert!(sanitize_filename("CON").starts_with('_'));
        assert_eq!(sanitize_filename("   "), "track");
    }

    #[test]
    fn bump_mp4_never_returns_existing_path() {
        let dir = std::env::temp_dir().join(format!(
            "sak-yt-bump-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let a = dir.join("clip.mp4");
        fs::write(&a, b"x").unwrap();
        let next = bump_output_path(&dir, "clip", "mp4").unwrap();
        assert_eq!(next, dir.join("clip-2.mp4"));
        assert!(!next.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn video_format_args_include_mp4_contract() {
        let args = build_video_format_args_for_test();
        assert!(args.iter().any(|a| a == "--merge-output-format"));
        assert!(args.iter().any(|a| a == "--remux-video"));
        assert!(args.iter().any(|a| a == "--no-overwrites"));
        assert!(args.iter().any(|a| a.contains("height<=1080")));
        assert!(args.iter().any(|a| a.contains("width<=1920")));
        assert!(args.iter().any(|a| a.contains("ext=mp4")));
    }

    #[test]
    fn quality_presets_map_to_format_caps() {
        let sel = video_format_selector(720);
        assert!(sel.contains("height<=720"));
        assert!(sel.contains("width<=1280"));
        assert!(sel.contains("vcodec^=avc1"));
        assert!(!sel.contains(' '));
        let sel4k = video_format_selector(2160);
        assert!(sel4k.contains("height<=2160"));
        assert!(!sel4k.contains("vcodec^=avc1"));
        assert_eq!(normalize_max_height(999), 1080);
        assert!(!video_format_selector(0).contains("height<="));
    }

    #[test]
    fn subtitle_stem_matcher() {
        assert!(is_subtitle_for_stem("clip.en.srt", "clip"));
        assert!(is_subtitle_for_stem("clip.en-US.srt", "clip"));
        assert!(is_subtitle_for_stem("clip.en-GB.srt", "clip"));
        assert!(is_subtitle_for_stem("clip.srt", "clip"));
        assert!(is_subtitle_for_stem("clip.mp4.en-GB.srt", "clip"));
        assert!(!is_subtitle_for_stem("clip.mp4", "clip"));
        assert!(!is_subtitle_for_stem("other.en.srt", "clip"));
    }

    #[test]
    fn video_player_fallbacks_skip_android_for_hires() {
        assert!(YTDLP_VIDEO_PLAYER_CLIENT_FALLBACKS
            .iter()
            .any(|c| *c == "youtube:player_client=android"));
        assert!(!player_client_fallbacks(2160)
            .iter()
            .any(|c| *c == "youtube:player_client=android"));
        assert!(player_client_fallbacks(480)
            .iter()
            .any(|c| *c == "youtube:player_client=android"));
    }
}
