use regex::Regex;
use serde::Deserialize;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

use crate::music::{MusicDownloadItem, MusicDownloadResult, MusicResolveResult, MusicTrackPreview};

pub struct YtdlpState {
    active: Mutex<Option<ActiveJob>>,
}

struct ActiveJob {
    job_id: String,
    child: Option<tauri_plugin_shell::process::CommandChild>,
    cancelled: bool,
}

impl YtdlpState {
    pub fn new() -> Self {
        Self {
            active: Mutex::new(None),
        }
    }

    /// Reserve the global download slot for `job_id` (no child yet).
    pub fn try_reserve(&self, job_id: &str) -> Result<(), String> {
        let mut guard = self.active.lock().map_err(|e| e.to_string())?;
        if guard.is_some() {
            return Err("another download is already running".to_string());
        }
        *guard = Some(ActiveJob {
            job_id: job_id.to_string(),
            child: None,
            cancelled: false,
        });
        Ok(())
    }

    /// Attach a spawned sidecar child to the reserved job.
    pub fn attach_child(
        &self,
        job_id: &str,
        child: tauri_plugin_shell::process::CommandChild,
    ) -> Result<(), String> {
        let mut guard = self.active.lock().map_err(|e| e.to_string())?;
        match guard.as_mut() {
            Some(job) if job.job_id == job_id && !job.cancelled => {
                job.child = Some(child);
                Ok(())
            }
            other => {
                let _ = child.kill();
                match other {
                    Some(job) if job.job_id == job_id && job.cancelled => {
                        Err("download was cancelled".to_string())
                    }
                    Some(_) => Err("job id does not match active download".to_string()),
                    None => Err("download was cancelled".to_string()),
                }
            }
        }
    }

    /// Drop the child handle after the process exits, keeping the job reservation.
    /// Returns `true` if cancel was requested for this job (or reservation is gone).
    pub fn clear_child(&self, job_id: &str) -> Result<bool, String> {
        let mut guard = self.active.lock().map_err(|e| e.to_string())?;
        match guard.as_mut() {
            Some(job) if job.job_id == job_id => {
                job.child = None;
                Ok(job.cancelled)
            }
            Some(_) => Err("job id does not match active download".to_string()),
            None => Ok(true),
        }
    }

    /// Release the job reservation when the whole download finishes (including cleanup).
    pub fn release(&self, job_id: &str) -> Result<(), String> {
        let mut guard = self.active.lock().map_err(|e| e.to_string())?;
        match guard.take() {
            Some(job) if job.job_id == job_id => Ok(()),
            Some(other) => {
                *guard = Some(other);
                Err("job id does not match active download".to_string())
            }
            None => Ok(()),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicProgressPayload {
    pub job_id: String,
    pub ratio: f64,
    pub track_index: u32,
    pub track_total: u32,
    pub track_title: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicDonePayload {
    pub job_id: String,
    pub ok: bool,
    pub error: Option<String>,
    pub results: Vec<MusicDownloadResult>,
}

const PROGRESS_EVENT: &str = "music-progress";
const DONE_EVENT: &str = "music-done";
/// Prefer m4a (140/139) over opus webm (251), which often 403s on YouTube's android client.
const YTDLP_AUDIO_FORMAT: &str = "140/139/251/bestaudio/best";
pub const YTDLP_PLAYER_CLIENT_FALLBACKS: &[&str] = &[
    "youtube:player_client=default,-android_sdkless",
    "youtube:player_client=default,web",
    "youtube:player_client=default,tv,web",
];
const YTDLP_SEARCH_FALLBACKS: usize = 10;
const YTDLP_TRACK_SLEEP_MS: u64 = 1200;
const YTDLP_TRACK_SLEEP_AFTER_FAIL_MS: u64 = 3000;
const MAX_OUTPUT_STEM_CHARS: usize = 120;
pub const YTDLP_RETRY_SLEEP_MS: u64 = 1500;
const DEFAULT_MP3_BITRATE_KBPS: u32 = 320;

pub fn normalize_mp3_bitrate_kbps(value: u32) -> u32 {
    match value {
        128 | 192 | 256 | 320 => value,
        _ => DEFAULT_MP3_BITRATE_KBPS,
    }
}

fn mp3_quality_arg(kbps: u32) -> String {
    format!("{}K", normalize_mp3_bitrate_kbps(kbps))
}

fn sidecar_file_name(base: &str) -> String {
    if cfg!(windows) {
        format!("{base}-x86_64-pc-windows-msvc.exe")
    } else if cfg!(target_os = "macos") {
        format!("{base}-x86_64-apple-darwin")
    } else {
        format!("{base}-x86_64-unknown-linux-gnu")
    }
}

pub fn resolve_sidecar_path(app: &AppHandle, base: &str) -> Result<PathBuf, String> {
    let file_name = sidecar_file_name(base);

    if let Ok(resource_dir) = app.path().resource_dir() {
        for candidate in [
            resource_dir.join(&file_name),
            resource_dir.join("binaries").join(&file_name),
        ] {
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }

    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(&file_name);
    if dev.is_file() {
        return Ok(dev);
    }

    Err(format!(
        "{base} sidecar not found. Run `node scripts/setup-music-tools.mjs`."
    ))
}

/// Build a process command that does not flash a console window on Windows.
pub fn command_no_window(exe: &Path) -> std::process::Command {
    let mut cmd = std::process::Command::new(exe);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

pub fn read_ytdlp_version(app: &AppHandle) -> Result<String, String> {
    let exe = resolve_sidecar_path(app, "yt-dlp")?;
    let output = command_no_window(&exe)
        .arg("--version")
        .output()
        .map_err(|e| format!("failed to run yt-dlp: {e}"))?;

    let version = String::from_utf8_lossy(if output.status.success() {
        &output.stdout
    } else {
        &output.stderr
    })
    .trim()
    .to_string();

    if version.is_empty() {
        Ok("unknown".to_string())
    } else {
        Ok(version.lines().next().unwrap_or(&version).to_string())
    }
}

pub fn trim_stderr_tail(stderr: &str, max_chars: usize) -> String {
    let trimmed = stderr.trim();
    if trimmed.len() <= max_chars {
        return trimmed.to_string();
    }
    trimmed
        .chars()
        .skip(trimmed.len() - max_chars)
        .collect()
}

pub fn is_youtube_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.contains("youtube.com/")
        || lower.contains("music.youtube.com/")
        || lower.contains("youtu.be/")
}

pub fn sanitize_filename(name: &str) -> String {
    const INVALID: [char; 9] = ['\\', '/', ':', '*', '?', '"', '<', '>', '|'];
    const RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
        "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];

    let mut cleaned: String = name
        .chars()
        .map(|c| {
            if INVALID.contains(&c) || c.is_control() || c == '%' {
                '_'
            } else {
                c
            }
        })
        .collect();
    cleaned = cleaned.trim().trim_end_matches(['.', ' ']).to_string();
    if cleaned.is_empty() {
        return "track".to_string();
    }

    let upper = cleaned.to_ascii_uppercase();
    if RESERVED
        .iter()
        .any(|r| upper == *r || upper.starts_with(&format!("{r}.")))
    {
        cleaned = format!("_{cleaned}");
    }
    cleaned
}

fn primary_artist_for_search(artist: &str) -> String {
    artist
        .split(',')
        .next()
        .unwrap_or(artist)
        .split('&')
        .next()
        .unwrap_or(artist)
        .trim()
        .to_string()
}

fn search_title_for_match(title: &str) -> String {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"(?i)\s*[\(\[](?:ft\.|feat\.|featuring|with)[^)\]]*[\)\]]").expect("feat regex")
    });

    let mut cleaned = title.trim().to_string();
    while let Some(found) = re.find(&cleaned) {
        cleaned.replace_range(found.range(), "");
    }
    cleaned.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate_output_stem(stem: &str) -> String {
    if stem.chars().count() <= MAX_OUTPUT_STEM_CHARS {
        return stem.to_string();
    }
    stem.chars()
        .take(MAX_OUTPUT_STEM_CHARS)
        .collect::<String>()
        .trim_end()
        .to_string()
}

pub fn default_output_stem(artist: &str, title: &str) -> String {
    let stem = format!(
        "{} - {}",
        primary_artist_for_search(artist),
        search_title_for_match(title)
    );
    truncate_output_stem(&sanitize_filename(&stem))
}

/// Find a collision-safe path `{stem}.{ext}` / `{stem}-N.{ext}`. Errors if none free.
pub fn bump_output_path(dir: &Path, stem: &str, ext: &str) -> Result<PathBuf, String> {
    let base = sanitize_filename(stem);
    let ext = ext.trim_start_matches('.');
    if ext.is_empty() {
        return Err("output extension is required".to_string());
    }

    let first = dir.join(format!("{base}.{ext}"));
    if !first.exists() {
        return Ok(first);
    }
    for n in 2..=9999 {
        let candidate = dir.join(format!("{base}-{n}.{ext}"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(format!(
        "could not find a free filename for \"{base}.{ext}\" — too many collisions"
    ))
}

pub fn parse_download_percent(line: &str) -> Option<f64> {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"(?i)\[download\]\s+(\d+(?:\.\d+)?)%").unwrap());
    re.captures(line)
        .and_then(|caps| caps.get(1))
        .and_then(|m| m.as_str().parse::<f64>().ok())
        .map(|pct| (pct / 100.0).clamp(0.0, 1.0))
}

#[derive(Debug, Deserialize)]
struct YtdlpFlatEntry {
    id: Option<String>,
    title: Option<String>,
    url: Option<String>,
    duration: Option<f64>,
    entries: Option<Vec<YtdlpFlatEntry>>,
}

fn youtube_watch_url(id: &str) -> String {
    format!("https://www.youtube.com/watch?v={id}")
}

fn track_from_ytdlp(entry: &YtdlpFlatEntry, fallback_id: &str) -> MusicTrackPreview {
    let id = entry
        .id
        .clone()
        .or_else(|| entry.url.clone())
        .unwrap_or_else(|| fallback_id.to_string());
    let title = entry
        .title
        .clone()
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| "Untitled".to_string());
    let download_query = entry
        .url
        .clone()
        .filter(|u| u.starts_with("http"))
        .unwrap_or_else(|| youtube_watch_url(&id));

    MusicTrackPreview {
        id,
        title: title.clone(),
        artist: "YouTube".to_string(),
        album: None,
        duration_secs: entry.duration,
        thumbnail_url: None,
        source: "youtube".to_string(),
        download_query,
        original_url: None,
    }
}

pub async fn resolve_youtube_url(app: &AppHandle, url: &str) -> Result<MusicResolveResult, String> {
    let ytdlp = resolve_sidecar_path(app, "yt-dlp")?;
    let output = command_no_window(&ytdlp)
        .args([
            "-J",
            "--flat-playlist",
            "--no-warnings",
            "--no-playlist-reverse",
            url,
        ])
        .output()
        .map_err(|e| format!("failed to run yt-dlp: {e}"))?;

    if !output.status.success() {
        return Err(trim_stderr_tail(
            &String::from_utf8_lossy(&output.stderr),
            2000,
        ));
    }

    let json = String::from_utf8_lossy(&output.stdout);
    let root: YtdlpFlatEntry = serde_json::from_str(&json)
        .map_err(|e| format!("failed to parse yt-dlp metadata: {e}"))?;

    let mut tracks = Vec::new();
    if let Some(entries) = root.entries {
        for (index, entry) in entries.into_iter().enumerate() {
            tracks.push(track_from_ytdlp(&entry, &format!("yt-{index}")));
        }
    } else {
        tracks.push(track_from_ytdlp(&root, "yt-0"));
    }

    if tracks.is_empty() {
        return Err("No tracks found in YouTube URL".to_string());
    }

    let title = root
        .title
        .or_else(|| tracks.first().map(|t| t.title.clone()));

    Ok(MusicResolveResult {
        platform: "youtube".to_string(),
        title,
        tracks,
        notice: None,
    })
}

#[derive(Debug, Deserialize)]
struct YtdlpSearchEntry {
    id: Option<String>,
    url: Option<String>,
    title: Option<String>,
    duration: Option<f64>,
    channel: Option<String>,
    channel_is_verified: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct YtdlpSearchResult {
    entries: Option<Vec<YtdlpSearchEntry>>,
}

fn expand_ytsearch_query(query: &str) -> String {
    if let Some(rest) = query.strip_prefix("ytsearch1:") {
        format!("ytsearch15:{rest}")
    } else if let Some(rest) = query.strip_prefix("ytsearch10:") {
        format!("ytsearch15:{rest}")
    } else if query.starts_with("ytsearch") {
        query.to_string()
    } else {
        format!("ytsearch15:{query}")
    }
}

pub fn build_ytsearch_query(artist: &str, title: &str) -> String {
    format!(
        "ytsearch15:{} {} topic",
        primary_artist_for_search(artist),
        search_title_for_match(title)
    )
}

fn normalize_for_match(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace())
        .collect::<String>()
        .to_ascii_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn score_ytsearch_entry(
    entry: &YtdlpSearchEntry,
    artist: &str,
    title: &str,
    expected_duration_secs: Option<f64>,
) -> f64 {
    let mut score = 0.0;
    let normalized_title = normalize_for_match(&search_title_for_match(title));
    let normalized_artist = normalize_for_match(&primary_artist_for_search(artist));

    if let (Some(expected), Some(actual)) = (expected_duration_secs, entry.duration) {
        let diff = (actual - expected).abs();
        score += 120.0 - diff.min(120.0);
    }

    if let Some(entry_title) = entry.title.as_deref() {
        let normalized_entry = normalize_for_match(entry_title);
        let lower_entry = entry_title.to_ascii_lowercase();

        if normalized_entry == normalized_title {
            score += 80.0;
            if !normalized_entry.contains(&normalized_artist) {
                // Bare song title uploads (often blocked Topic-style copies).
                score -= 30.0;
            }
        } else if normalized_entry.contains(&normalized_title) {
            score += 40.0;
        }

        if normalized_entry.contains(&normalized_artist) {
            score += 20.0;
        } else if entry
            .channel
            .as_deref()
            .is_some_and(|channel| normalize_for_match(channel).contains(&normalized_artist))
        {
            score += 15.0;
        }

        if lower_entry.contains("official audio")
            || lower_entry.contains("official video")
            || lower_entry.contains("official lyric")
        {
            score += 20.0;
        }
    }

    if entry
        .channel
        .as_deref()
        .is_some_and(|channel| channel.ends_with(" - Topic"))
    {
        // Auto-generated Topic uploads match metadata well but often 403 on download.
        score -= 35.0;
    }

    if entry.channel_is_verified == Some(true) {
        score += 15.0;
    }

    score
}

fn rank_ytsearch_entries<'a>(
    entries: &'a [YtdlpSearchEntry],
    artist: &str,
    title: &str,
    expected_duration_secs: Option<f64>,
    limit: usize,
) -> Vec<&'a YtdlpSearchEntry> {
    let mut ranked = entries.iter().collect::<Vec<_>>();
    ranked.sort_by(|left, right| {
        score_ytsearch_entry(right, artist, title, expected_duration_secs)
            .partial_cmp(&score_ytsearch_entry(
                left,
                artist,
                title,
                expected_duration_secs,
            ))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    ranked.truncate(limit);
    ranked
}

fn watch_url_from_entry(entry: &YtdlpSearchEntry) -> Option<String> {
    if let Some(url) = entry.url.as_ref().filter(|value| value.starts_with("http")) {
        return Some(url.clone());
    }
    entry
        .id
        .as_ref()
        .filter(|id| !id.is_empty())
        .map(|id| format!("https://www.youtube.com/watch?v={id}"))
}

pub fn resolve_ytsearch_watch_urls(
    app: &AppHandle,
    _query: &str,
    artist: &str,
    title: &str,
    expected_duration_secs: Option<f64>,
) -> Result<Vec<String>, String> {
    let ytdlp = resolve_sidecar_path(app, "yt-dlp")?;
    let deno = resolve_sidecar_path(app, "deno")?;
    let expanded = expand_ytsearch_query(&build_ytsearch_query(artist, title));

    let output = command_no_window(&ytdlp)
        .args([
            "-J",
            "--flat-playlist",
            "--no-warnings",
            "--js-runtimes",
            &format!("deno:{}", deno.to_string_lossy()),
            &expanded,
        ])
        .output()
        .map_err(|e| format!("failed to run yt-dlp search: {e}"))?;

    if !output.status.success() {
        return Err(trim_stderr_tail(
            &String::from_utf8_lossy(&output.stderr),
            2000,
        ));
    }

    let parsed: YtdlpSearchResult = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("failed to parse yt-dlp search results: {e}"))?;
    let entries = parsed
        .entries
        .unwrap_or_default()
        .into_iter()
        .filter(|entry| entry.id.is_some() || entry.url.is_some())
        .collect::<Vec<_>>();

    if entries.is_empty() {
        return Err(format!("No YouTube match found for \"{artist} - {title}\""));
    }

    let ranked = rank_ytsearch_entries(
        &entries,
        artist,
        title,
        expected_duration_secs,
        YTDLP_SEARCH_FALLBACKS,
    );
    let urls = ranked
        .into_iter()
        .filter_map(watch_url_from_entry)
        .collect::<Vec<_>>();

    if urls.is_empty() {
        return Err(format!(
            "YouTube matches for \"{artist} - {title}\" did not include watch URLs"
        ));
    }

    Ok(urls)
}

pub async fn resolve_download_targets(
    app: &AppHandle,
    query: &str,
    artist: &str,
    title: &str,
    expected_duration_secs: Option<f64>,
) -> Result<Vec<String>, String> {
    let trimmed = query.trim();
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        return Ok(vec![trimmed.to_string()]);
    }
    if trimmed.starts_with("ytsearch") {
        return resolve_ytsearch_watch_urls(app, trimmed, artist, title, expected_duration_secs);
    }
    Err(format!("Unsupported download query: {trimmed}"))
}

fn build_download_args(
    app: &AppHandle,
    output_path: &Path,
    download_url: &str,
    player_client_args: &str,
    audio_quality_kbps: u32,
) -> Result<Vec<String>, String> {
    let ffmpeg = resolve_sidecar_path(app, "ffmpeg")?;
    let deno = resolve_sidecar_path(app, "deno")?;
    let deno_arg = format!("deno:{}", deno.to_string_lossy());

    Ok(vec![
        "--newline".to_string(),
        "--no-warnings".to_string(),
        "--retries".to_string(),
        "5".to_string(),
        "--fragment-retries".to_string(),
        "5".to_string(),
        "--extractor-args".to_string(),
        player_client_args.to_string(),
        "-f".to_string(),
        YTDLP_AUDIO_FORMAT.to_string(),
        "-x".to_string(),
        "--audio-format".to_string(),
        "mp3".to_string(),
        "--audio-quality".to_string(),
        mp3_quality_arg(audio_quality_kbps),
        "--embed-metadata".to_string(),
        "--ffmpeg-location".to_string(),
        ffmpeg.to_string_lossy().to_string(),
        "--js-runtimes".to_string(),
        deno_arg,
        "-o".to_string(),
        output_path.to_string_lossy().to_string(),
        download_url.to_string(),
    ])
}

pub fn is_retryable_download_error(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("403")
        || lower.contains("forbidden")
        || lower.contains("video unavailable")
        || lower.contains("unable to download video data")
        || lower.contains("timed out")
        || lower.contains("connection reset")
}

async fn run_single_download(
    app: &AppHandle,
    state: &YtdlpState,
    job_id: &str,
    download_url: &str,
    output_path: PathBuf,
    track_index: u32,
    track_total: u32,
    track_title: &str,
    player_client_args: &str,
    audio_quality_kbps: u32,
) -> Result<(bool, Option<String>), String> {
    let args = build_download_args(
        app,
        &output_path,
        download_url,
        player_client_args,
        audio_quality_kbps,
    )?;

    let (mut rx, child) = app
        .shell()
        .sidecar("yt-dlp")
        .map_err(|e| e.to_string())?
        .args(args)
        .spawn()
        .map_err(|e| e.to_string())?;

    if let Err(err) = state.attach_child(job_id, child) {
        // Dropping child without kill; cancel already took the slot. Soft-fail as cancelled.
        let _ = err;
        return Ok((false, Some("cancelled".to_string())));
    }

    let mut stderr = String::new();
    let mut exit_code: Option<i32> = None;
    let mut last_ratio = 0.0;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                let chunk = String::from_utf8_lossy(&bytes);
                for line in chunk.lines() {
                    if let Some(ratio) = parse_download_percent(line) {
                        if ratio > last_ratio {
                            last_ratio = ratio;
                            let overall = ((track_index as f64) + ratio) / track_total as f64;
                            let _ = app.emit(
                                PROGRESS_EVENT,
                                MusicProgressPayload {
                                    job_id: job_id.to_string(),
                                    ratio: overall.clamp(0.0, 1.0),
                                    track_index,
                                    track_total,
                                    track_title: Some(track_title.to_string()),
                                },
                            );
                        }
                    }
                }
            }
            CommandEvent::Stderr(bytes) => {
                let chunk = String::from_utf8_lossy(&bytes);
                stderr.push_str(&chunk);
                for line in chunk.lines() {
                    if let Some(ratio) = parse_download_percent(line) {
                        if ratio > last_ratio {
                            last_ratio = ratio;
                            let overall = ((track_index as f64) + ratio) / track_total as f64;
                            let _ = app.emit(
                                PROGRESS_EVENT,
                                MusicProgressPayload {
                                    job_id: job_id.to_string(),
                                    ratio: overall.clamp(0.0, 1.0),
                                    track_index,
                                    track_total,
                                    track_title: Some(track_title.to_string()),
                                },
                            );
                        }
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

    let ok = exit_code == Some(0) && output_path.is_file();
    let error = if ok {
        None
    } else if was_cancelled {
        Some("cancelled".to_string())
    } else if !output_path.is_file() && exit_code == Some(0) {
        Some("download finished but output file was not found".to_string())
    } else {
        Some(trim_stderr_tail(&stderr, 2000))
    };

    Ok((ok, error))
}

async fn run_download_with_fallbacks(
    app: &AppHandle,
    state: &YtdlpState,
    job_id: &str,
    download_urls: &[String],
    output_path: PathBuf,
    track_index: u32,
    track_total: u32,
    track_title: &str,
    audio_quality_kbps: u32,
) -> Result<(bool, Option<String>), String> {
    let mut last_error = None;
    let mut attempt = 0usize;

    for download_url in download_urls {
        for player_client_args in YTDLP_PLAYER_CLIENT_FALLBACKS {
            if attempt > 0 {
                if output_path.is_file() {
                    let _ = std::fs::remove_file(&output_path);
                }
                tokio::time::sleep(std::time::Duration::from_millis(YTDLP_RETRY_SLEEP_MS)).await;
            }

            let (ok, error) = run_single_download(
                app,
                state,
                job_id,
                download_url,
                output_path.clone(),
                track_index,
                track_total,
                track_title,
                player_client_args,
                audio_quality_kbps,
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
                break;
            }
        }
    }

    Ok((false, last_error))
}

pub async fn run_music_download_job(
    app: &AppHandle,
    state: &YtdlpState,
    job_id: String,
    output_dir: String,
    items: Vec<MusicDownloadItem>,
    audio_quality_kbps: u32,
) -> Result<(bool, Option<String>, Vec<MusicDownloadResult>), String> {
    if items.is_empty() {
        return Err("no tracks selected".to_string());
    }

    let dir = PathBuf::from(&output_dir);
    if !dir.is_dir() {
        return Err("output folder not found".to_string());
    }

    state.try_reserve(&job_id)?;

    let outcome = run_music_download_job_inner(
        app,
        state,
        &job_id,
        dir,
        items,
        audio_quality_kbps,
    )
    .await;

    let _ = state.release(&job_id);
    outcome
}

async fn run_music_download_job_inner(
    app: &AppHandle,
    state: &YtdlpState,
    job_id: &str,
    dir: PathBuf,
    items: Vec<MusicDownloadItem>,
    audio_quality_kbps: u32,
) -> Result<(bool, Option<String>, Vec<MusicDownloadResult>), String> {
    let track_total = items.len() as u32;
    let mut results: Vec<MusicDownloadResult> = Vec::with_capacity(items.len());
    let mut cancelled = false;

    for (index, item) in items.into_iter().enumerate() {
        if index > 0 {
            let delay_ms = match results.last() {
                Some(last) if !last.ok => YTDLP_TRACK_SLEEP_AFTER_FAIL_MS,
                _ => YTDLP_TRACK_SLEEP_MS,
            };
            tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        }

        let stem = item
            .output_stem
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| default_output_stem(&item.artist, &item.title));
        let output_path = match bump_output_path(&dir, &stem, "mp3") {
            Ok(path) => path,
            Err(error) => {
                results.push(MusicDownloadResult {
                    id: item.id.clone(),
                    path: dir.join(format!("{stem}.mp3")).to_string_lossy().to_string(),
                    ok: false,
                    error: Some(error),
                });
                continue;
            }
        };

        let download_urls = match resolve_download_targets(
            app,
            &item.download_query,
            &item.artist,
            &item.title,
            item.duration_secs,
        )
        .await
        {
            Ok(urls) => urls,
            Err(error) => {
                results.push(MusicDownloadResult {
                    id: item.id.clone(),
                    path: output_path.to_string_lossy().to_string(),
                    ok: false,
                    error: Some(error),
                });
                continue;
            }
        };

        let (ok, error) = run_download_with_fallbacks(
            app,
            state,
            job_id,
            &download_urls,
            output_path.clone(),
            index as u32,
            track_total,
            &item.title,
            audio_quality_kbps,
        )
        .await?;

        if error.as_deref() == Some("cancelled") {
            cancelled = true;
            results.push(MusicDownloadResult {
                id: item.id,
                path: output_path.to_string_lossy().to_string(),
                ok: false,
                error: error.clone(),
            });
            break;
        }

        results.push(MusicDownloadResult {
            id: item.id.clone(),
            path: output_path.to_string_lossy().to_string(),
            ok,
            error: error.clone(),
        });
    }

    let ok_count = results.iter().filter(|result| result.ok).count();
    let failed_count = results.iter().filter(|result| !result.ok).count();
    let overall_ok = !cancelled && failed_count == 0 && ok_count == results.len();

    let overall_error = if cancelled {
        Some("cancelled".to_string())
    } else if overall_ok {
        None
    } else if failed_count > 0 {
        let first_error = results
            .iter()
            .find_map(|result| result.error.clone())
            .unwrap_or_else(|| "unknown error".to_string());
        Some(format!(
            "{ok_count} of {} downloaded; {failed_count} failed: {first_error}",
            results.len()
        ))
    } else {
        Some("one or more tracks failed".to_string())
    };

    Ok((overall_ok, overall_error, results))
}

pub fn cancel_job(state: &YtdlpState, job_id: &str) -> Result<(), String> {
    let mut guard = state.active.lock().map_err(|e| e.to_string())?;
    let Some(job) = guard.as_mut() else {
        return Err("no active download".to_string());
    };
    if job.job_id != job_id {
        return Err("job id does not match active download".to_string());
    }
    job.cancelled = true;
    if let Some(child) = job.child.take() {
        child.kill().map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn emit_music_done(
    app: &AppHandle,
    job_id: String,
    ok: bool,
    error: Option<String>,
    results: Vec<MusicDownloadResult>,
) {
    let _ = app.emit(
        DONE_EVENT,
        MusicDonePayload {
            job_id,
            ok,
            error,
            results,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_official_upload_over_topic_channel() {
        let topic = YtdlpSearchEntry {
            id: Some("topic".to_string()),
            url: None,
            title: Some("Dead Presidents II".to_string()),
            duration: Some(267.0),
            channel: Some("JAY-Z - Topic".to_string()),
            channel_is_verified: None,
        };
        let official = YtdlpSearchEntry {
            id: Some("official".to_string()),
            url: None,
            title: Some("JAY-Z - Dead Presidents II (Official Lyric Video)".to_string()),
            duration: Some(273.0),
            channel: Some("JAY-Z".to_string()),
            channel_is_verified: Some(true),
        };

        let topic_score = score_ytsearch_entry(&topic, "JAY-Z", "Dead Presidents II", Some(267.0));
        let official_score =
            score_ytsearch_entry(&official, "JAY-Z", "Dead Presidents II", Some(267.0));

        assert!(official_score > topic_score);
    }

    #[test]
    fn prefers_official_audio_for_logic_wu_tang_forever() {
        let auto_upload = YtdlpSearchEntry {
            id: Some("topic".to_string()),
            url: None,
            title: Some("Wu Tang Forever".to_string()),
            duration: Some(488.0),
            channel: Some("Logic".to_string()),
            channel_is_verified: None,
        };
        let official = YtdlpSearchEntry {
            id: Some("official".to_string()),
            url: None,
            title: Some("Logic - Wu Tang Forever ft. Wu Tang Clan (Official Audio)".to_string()),
            duration: Some(488.0),
            channel: Some("Visionary Music Group".to_string()),
            channel_is_verified: None,
        };

        let artist = "Logic, Ghostface Killah, Raekwon";
        let title = "Wu Tang Forever (ft. Ghostface Killah, Raekwon, RZA, Method Man)";

        let auto_score = score_ytsearch_entry(&auto_upload, artist, title, Some(488.0));
        let official_score = score_ytsearch_entry(&official, artist, title, Some(488.0));

        assert!(official_score > auto_score);
    }

    #[test]
    fn strips_featured_artists_from_search_title() {
        assert_eq!(
            search_title_for_match("Wu Tang Forever (ft. Ghostface Killah, Method Man)"),
            "Wu Tang Forever"
        );
    }

    #[test]
    fn shortens_collaboration_output_stem() {
        let artist = "Logic, Ghostface Killah, Raekwon, RZA, Method Man";
        let title = "Wu Tang Forever (ft. Ghostface Killah, Raekwon, RZA, Method Man)";
        let stem = default_output_stem(artist, title);
        assert!(stem.chars().count() <= MAX_OUTPUT_STEM_CHARS);
        assert!(stem.starts_with("Logic - Wu Tang Forever"));
    }

    #[test]
    fn sanitize_and_bump_output_path() {
        assert!(!sanitize_filename("a%(b)").contains('%'));
        assert!(sanitize_filename("NUL").starts_with('_'));

        let dir = std::env::temp_dir().join(format!(
            "sak-ytdlp-bump-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("song.mp3"), b"x").unwrap();
        let next = bump_output_path(&dir, "song", "mp3").unwrap();
        assert_eq!(next.file_name().unwrap(), "song-2.mp3");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
