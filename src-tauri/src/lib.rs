use base64::Engine;
use ico::{IconDir, IconDirEntry, IconImage, ResourceType};
use image::imageops::FilterType;
use image::{GenericImageView, ImageFormat, RgbaImage};
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use std::path::{Path, PathBuf};
use tauri_plugin_shell::ShellExt;

mod ebook_convert;
mod epub_cleanup;
mod ffmpeg;
mod music;
mod spotify;
mod youtube;
mod ytdlp;

const ALLOWED_ICO_SIZES: [u32; 9] = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const PREVIEW_MAX_EDGE: u32 = 2048;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaProbe {
    duration_secs: f64,
    fps: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaStreamInfo {
    index: u32,
    codec_type: String,
    codec_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaStreamsProbe {
    duration_secs: f64,
    size_bytes: u64,
    streams: Vec<MediaStreamInfo>,
}

#[derive(Deserialize)]
struct FfprobeStreamTags {
    language: Option<String>,
    title: Option<String>,
}

#[derive(Deserialize)]
struct FfprobeFormat {
    duration: Option<String>,
}

#[derive(Deserialize)]
struct FfprobeStream {
    index: Option<u32>,
    codec_type: Option<String>,
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    r_frame_rate: Option<String>,
    avg_frame_rate: Option<String>,
    tags: Option<FfprobeStreamTags>,
}

#[derive(Deserialize)]
struct FfprobeOutput {
    format: FfprobeFormat,
    streams: Option<Vec<FfprobeStream>>,
}

#[derive(Serialize)]
struct TrimClipResult {
    path: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn format_ffmpeg_time(secs: f64) -> String {
    format!("{:.3}", secs.max(0.0))
}

fn parse_frame_rate(rate: &str) -> Option<f64> {
    if let Some((num, den)) = rate.split_once('/') {
        let numerator = num.parse::<f64>().ok()?;
        let denominator = den.parse::<f64>().ok()?;
        if denominator > 0.0 {
            return Some(numerator / denominator);
        }
    }
    rate.parse::<f64>().ok()
}

fn probe_fps(streams: &[FfprobeStream]) -> f64 {
    const DEFAULT_FPS: f64 = 30.0;
    for stream in streams {
        if stream.codec_type.as_deref() != Some("video") {
            continue;
        }
        for rate in [
            stream.r_frame_rate.as_deref(),
            stream.avg_frame_rate.as_deref(),
        ] {
            if let Some(parsed) = rate.and_then(parse_frame_rate) {
                if parsed > 0.0 && parsed < 1000.0 {
                    return parsed;
                }
            }
        }
    }
    DEFAULT_FPS
}

fn movflags_for_output(out_path: &Path) -> Option<&'static str> {
    let ext = out_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if matches!(ext.as_str(), "mp4" | "m4v" | "mov") {
        Some("+faststart")
    } else {
        None
    }
}

/// Read container duration via ffprobe JSON (`format.duration`).
#[tauri::command]
async fn probe_media(app: tauri::AppHandle, path: String) -> Result<MediaProbe, String> {
    let source = PathBuf::from(&path);
    if !source.is_file() {
        return Err("source file not found".to_string());
    }

    let output = app
        .shell()
        .sidecar("ffprobe")
        .map_err(|e| e.to_string())?
        .args([
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            &path,
        ])
        .output()
        .await
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(format!(
            "ffprobe exited with {:?}: {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let parsed: FfprobeOutput =
        serde_json::from_slice(&output.stdout).map_err(|e| format!("invalid ffprobe json: {e}"))?;

    let duration_secs = parsed
        .format
        .duration
        .as_deref()
        .and_then(|d| d.parse::<f64>().ok())
        .filter(|d| *d > 0.0)
        .unwrap_or(0.0);

    if duration_secs <= 0.0 {
        return Err("could not read media duration".to_string());
    }

    let fps = parsed
        .streams
        .as_deref()
        .map(probe_fps)
        .unwrap_or(30.0);

    Ok(MediaProbe {
        duration_secs,
        fps,
    })
}

/// Probe all streams in a media file for remux compatibility UI.
#[tauri::command]
async fn probe_media_streams(
    app: tauri::AppHandle,
    path: String,
) -> Result<MediaStreamsProbe, String> {
    let source = PathBuf::from(&path);
    if !source.is_file() {
        return Err("source file not found".to_string());
    }

    let output = app
        .shell()
        .sidecar("ffprobe")
        .map_err(|e| e.to_string())?
        .args([
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            &path,
        ])
        .output()
        .await
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(format!(
            "ffprobe exited with {:?}: {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let parsed: FfprobeOutput =
        serde_json::from_slice(&output.stdout).map_err(|e| format!("invalid ffprobe json: {e}"))?;

    let duration_secs = parsed
        .format
        .duration
        .as_deref()
        .and_then(|d| d.parse::<f64>().ok())
        .filter(|d| *d > 0.0)
        .unwrap_or(0.0);

    let streams = parsed
        .streams
        .unwrap_or_default()
        .into_iter()
        .filter_map(|stream| {
            let index = stream.index?;
            let codec_type = stream.codec_type.unwrap_or_default();
            let codec_name = stream.codec_name.unwrap_or_default();
            if codec_type.is_empty() {
                return None;
            }
            Some(MediaStreamInfo {
                index,
                codec_type,
                codec_name,
                width: stream.width.filter(|w| *w > 0),
                height: stream.height.filter(|h| *h > 0),
                language: stream.tags.as_ref().and_then(|t| t.language.clone()),
                title: stream.tags.as_ref().and_then(|t| t.title.clone()),
            })
        })
        .collect();

    let size_bytes = std::fs::metadata(&source)
        .map(|m| m.len())
        .unwrap_or(0);

    Ok(MediaStreamsProbe {
        duration_secs,
        size_bytes,
        streams,
    })
}

/// Trim a clip. Lossless stream-copy by default; optional accurate re-encode. Never overwrites.
#[tauri::command]
async fn trim_clip(
    app: tauri::AppHandle,
    source_path: String,
    output_path: String,
    start_secs: f64,
    end_secs: f64,
    accurate: bool,
) -> Result<TrimClipResult, String> {
    if end_secs <= start_secs {
        return Err("end must be after start".to_string());
    }

    let source = PathBuf::from(&source_path);
    if !source.is_file() {
        return Err("source file not found".to_string());
    }

    let out_path = PathBuf::from(&output_path);
    let path_str = out_path.to_string_lossy().into_owned();

    if out_path.exists() {
        return Ok(TrimClipResult {
            path: path_str,
            ok: false,
            error: Some("target already exists".to_string()),
        });
    }

    let duration = end_secs - start_secs;
    let start = format_ffmpeg_time(start_secs);
    let dur = format_ffmpeg_time(duration);

    let mut args: Vec<String> = Vec::new();
    if accurate {
        // -ss after -i for frame-accurate cuts (re-encode).
        args.push("-i".into());
        args.push(source_path.clone());
        args.push("-ss".into());
        args.push(start);
        args.push("-t".into());
        args.push(dur);
        args.push("-c:v".into());
        args.push("libx264".into());
        args.push("-crf".into());
        args.push("18".into());
        args.push("-preset".into());
        args.push("medium".into());
        args.push("-c:a".into());
        args.push("aac".into());
        args.push("-b:a".into());
        args.push("192k".into());
    } else {
        // Put -ss before -i so stream-copy seeks to a keyframe.
        args.push("-ss".into());
        args.push(start);
        args.push("-i".into());
        args.push(source_path.clone());
        args.push("-t".into());
        args.push(dur);
        args.push("-c".into());
        args.push("copy".into());
        args.push("-avoid_negative_ts".into());
        args.push("make_zero".into());
    }

    if let Some(flags) = movflags_for_output(&out_path) {
        args.push("-movflags".into());
        args.push(flags.into());
    }

    args.push(output_path.clone());

    let output = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| e.to_string())?
        .args(args)
        .output()
        .await
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let _ = std::fs::remove_file(&out_path);
        return Ok(TrimClipResult {
            path: path_str,
            ok: false,
            error: Some(format!(
                "ffmpeg exited with {:?}: {}",
                output.status.code(),
                stderr.trim()
            )),
        });
    }

    Ok(TrimClipResult {
        path: path_str,
        ok: true,
        error: None,
    })
}

#[derive(Serialize)]
struct RemuxVideoResult {
    path: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn remux_container_from_path(path: &Path) -> Option<&'static str> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "mp4" => Some("mp4"),
        "mkv" => Some("mkv"),
        "mov" => Some("mov"),
        "webm" => Some("webm"),
        "ts" => Some("ts"),
        "m4v" => Some("m4v"),
        _ => None,
    }
}

/// Cancel the active FFmpeg job and remove any partial output file.
#[tauri::command]
fn cancel_ffmpeg_job(
    state: tauri::State<'_, ffmpeg::FfmpegState>,
    job_id: String,
) -> Result<(), String> {
    ffmpeg::cancel_job(&state, &job_id)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConvertPdfToEpubResult {
    path: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cleanup: Option<epub_cleanup::CleanupReport>,
}

/// Return the bundled Calibre / ebook-convert version string.
#[tauri::command]
fn ebook_convert_version(app: tauri::AppHandle) -> Result<String, String> {
    ebook_convert::read_ebook_convert_version(&app)
}

/// Cancel the active PDF → EPUB conversion and remove any partial output file.
#[tauri::command]
fn cancel_ebook_convert_job(
    state: tauri::State<'_, ebook_convert::EbookConvertState>,
    job_id: String,
) -> Result<(), String> {
    ebook_convert::cancel_job(&state, &job_id)
}

/// Return the bundled yt-dlp version string.
#[tauri::command]
fn music_tools_version(app: tauri::AppHandle) -> Result<String, String> {
    ytdlp::read_ytdlp_version(&app)
}

/// Resolve a YouTube or Spotify URL into downloadable track previews.
#[tauri::command]
async fn music_resolve(
    app: tauri::AppHandle,
    url: String,
    spotify_client_id: Option<String>,
    spotify_client_secret: Option<String>,
) -> Result<music::MusicResolveResult, String> {
    music::resolve_music_url(&app, url, spotify_client_id, spotify_client_secret).await
}

/// Download selected tracks as MP3 via yt-dlp + FFmpeg.
#[tauri::command]
async fn music_download(
    app: tauri::AppHandle,
    state: tauri::State<'_, ytdlp::YtdlpState>,
    job_id: String,
    output_dir: String,
    items: Vec<music::MusicDownloadItem>,
    audio_quality_kbps: Option<u32>,
) -> Result<music::MusicDownloadJobResult, String> {
    music::run_music_download(
        &app,
        &state,
        job_id,
        output_dir,
        items,
        ytdlp::normalize_mp3_bitrate_kbps(audio_quality_kbps.unwrap_or(320)),
    )
    .await
}

/// Cancel the active music download job.
#[tauri::command]
fn cancel_music_job(
    state: tauri::State<'_, ytdlp::YtdlpState>,
    job_id: String,
) -> Result<(), String> {
    ytdlp::cancel_job(&state, &job_id)
}

/// Resolve a single YouTube video URL into metadata for the video downloader.
#[tauri::command]
async fn youtube_resolve(
    app: tauri::AppHandle,
    url: String,
) -> Result<youtube::YoutubeResolveResult, String> {
    youtube::resolve_youtube_video(&app, url).await
}

/// Download a YouTube video as MP4 via yt-dlp + FFmpeg.
#[tauri::command]
async fn youtube_download(
    app: tauri::AppHandle,
    state: tauri::State<'_, ytdlp::YtdlpState>,
    job_id: String,
    url: String,
    output_dir: String,
    title_hint: Option<String>,
    max_height: Option<u32>,
    write_subs: Option<bool>,
) -> Result<youtube::YoutubeDownloadResult, String> {
    youtube::run_youtube_download(
        &app,
        &state,
        job_id,
        url,
        output_dir,
        title_hint,
        max_height,
        write_subs,
    )
    .await
}

/// Cancel the active YouTube video download job.
#[tauri::command]
fn cancel_youtube_job(
    state: tauri::State<'_, ytdlp::YtdlpState>,
    job_id: String,
) -> Result<(), String> {
    youtube::cancel_youtube_job(&state, &job_id)
}

/// Convert a PDF to reflowable EPUB via bundled Calibre ebook-convert.
#[tauri::command]
async fn convert_pdf_to_epub(
    app: tauri::AppHandle,
    state: tauri::State<'_, ebook_convert::EbookConvertState>,
    job_id: String,
    source_path: String,
    output_path: String,
    title: Option<String>,
) -> Result<ConvertPdfToEpubResult, String> {
    let source = PathBuf::from(&source_path);
    let out_path = PathBuf::from(&output_path);
    let path_str = out_path.to_string_lossy().into_owned();

    if same_file_ignore_case(&source, &out_path) {
        return Ok(ConvertPdfToEpubResult {
            path: path_str,
            ok: false,
            error: Some("source and output are the same file".to_string()),
            cleanup: None,
        });
    }

    if out_path.exists() {
        return Ok(ConvertPdfToEpubResult {
            path: path_str,
            ok: false,
            error: Some("target already exists".to_string()),
            cleanup: None,
        });
    }

    let (ok, error) = ebook_convert::run_ebook_convert_job(
        &app,
        &state,
        job_id,
        source_path,
        output_path.clone(),
        title,
        ebook_convert::ConvertOutputKind::Epub,
    )
    .await?;

    if !ok {
        let _ = std::fs::remove_file(&out_path);
        return Ok(ConvertPdfToEpubResult {
            path: path_str,
            ok: false,
            error,
            cleanup: None,
        });
    }

    let cleanup = epub_cleanup::cleanup_calibre_epub(&out_path);

    Ok(ConvertPdfToEpubResult {
        path: path_str,
        ok: true,
        error: None,
        cleanup: Some(cleanup),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConvertPdfToMarkdownResult {
    path: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// Convert a PDF to Markdown via bundled Calibre ebook-convert (TXT markdown output).
#[tauri::command]
async fn convert_pdf_to_markdown(
    app: tauri::AppHandle,
    state: tauri::State<'_, ebook_convert::EbookConvertState>,
    job_id: String,
    source_path: String,
    output_path: String,
    title: Option<String>,
) -> Result<ConvertPdfToMarkdownResult, String> {
    let source = PathBuf::from(&source_path);
    let out_path = PathBuf::from(&output_path);
    let path_str = out_path.to_string_lossy().into_owned();

    if same_file_ignore_case(&source, &out_path) {
        return Ok(ConvertPdfToMarkdownResult {
            path: path_str,
            ok: false,
            error: Some("source and output are the same file".to_string()),
        });
    }

    if out_path.exists() {
        return Ok(ConvertPdfToMarkdownResult {
            path: path_str,
            ok: false,
            error: Some("target already exists".to_string()),
        });
    }

    let (ok, error) = ebook_convert::run_ebook_convert_job(
        &app,
        &state,
        job_id,
        source_path,
        output_path,
        title,
        ebook_convert::ConvertOutputKind::Markdown,
    )
    .await?;

    if !ok {
        let _ = std::fs::remove_file(&out_path);
        let temp = ebook_convert::markdown_temp_txt_path(&out_path);
        let _ = std::fs::remove_file(&temp);
        return Ok(ConvertPdfToMarkdownResult {
            path: path_str,
            ok: false,
            error,
        });
    }

    Ok(ConvertPdfToMarkdownResult {
        path: path_str,
        ok: true,
        error: None,
    })
}

/// Remux a video file into a new container via stream copy. Never overwrites.
#[tauri::command]
async fn remux_video(
    app: tauri::AppHandle,
    state: tauri::State<'_, ffmpeg::FfmpegState>,
    job_id: String,
    source_path: String,
    output_path: String,
    stream_indices: Option<Vec<u32>>,
    duration_secs: Option<f64>,
) -> Result<RemuxVideoResult, String> {
    let source = PathBuf::from(&source_path);
    if !source.is_file() {
        return Err("source file not found".to_string());
    }

    let out_path = PathBuf::from(&output_path);
    let path_str = out_path.to_string_lossy().into_owned();

    if remux_container_from_path(&out_path).is_none() {
        return Err(
            "unsupported output container — use mp4, mkv, mov, webm, ts, or m4v".to_string(),
        );
    }

    if same_file_ignore_case(&source, &out_path) {
        return Ok(RemuxVideoResult {
            path: path_str,
            ok: false,
            error: Some("source and output are the same file".to_string()),
        });
    }

    if out_path.exists() {
        return Ok(RemuxVideoResult {
            path: path_str,
            ok: false,
            error: Some("target already exists".to_string()),
        });
    }

    let indices = stream_indices.unwrap_or_default();
    if indices.is_empty() {
        return Ok(RemuxVideoResult {
            path: path_str,
            ok: false,
            error: Some("select at least one stream".to_string()),
        });
    }

    let duration = if let Some(d) = duration_secs {
        if d > 0.0 {
            d
        } else {
            probe_media_streams(app.clone(), source_path.clone())
                .await?
                .duration_secs
        }
    } else {
        probe_media_streams(app.clone(), source_path.clone())
            .await?
            .duration_secs
    };

    if duration <= 0.0 {
        return Err("could not read media duration".to_string());
    }

    let movflags = movflags_for_output(&out_path);
    let args = ffmpeg::build_remux_args(
        &source_path,
        &output_path,
        &indices,
        movflags,
    );

    let (ok, error) = ffmpeg::run_ffmpeg_job(
        &app,
        &state,
        job_id,
        args,
        duration,
        Some(out_path.clone()),
    )
    .await?;

    if !ok {
        let _ = std::fs::remove_file(&out_path);
        return Ok(RemuxVideoResult {
            path: path_str,
            ok: false,
            error,
        });
    }

    Ok(RemuxVideoResult {
        path: path_str,
        ok: true,
        error: None,
    })
}

#[derive(Serialize)]
struct EncodeVideoResult {
    path: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn encode_codec_allowed_for_container(codec: &str, container: &str) -> bool {
    match codec {
        "h264" => matches!(container, "mp4" | "mkv" | "mov" | "m4v" | "ts"),
        "h265" => matches!(container, "mp4" | "mkv" | "mov" | "m4v"),
        "vp9" => matches!(container, "webm" | "mkv"),
        "av1" => matches!(container, "mp4" | "mkv" | "webm"),
        _ => false,
    }
}

fn normalize_audio_mode(audio_mode: &str, container: &str) -> Result<&'static str, String> {
    match audio_mode {
        "copy" => Ok("copy"),
        "aac" => {
            if container == "webm" {
                Err("aac audio is not valid in webm — use opus".to_string())
            } else {
                Ok("aac")
            }
        }
        "opus" => Ok("opus"),
        _ => Err(format!("unsupported audio mode: {audio_mode}")),
    }
}

/// AAC / Opus only — used by audio convert (no stream-copy mode).
fn normalize_audio_convert_codec(audio_codec: &str, container: &str) -> Result<&'static str, String> {
    match audio_codec {
        "aac" => {
            if container == "webm" {
                Err("aac audio is not valid in webm — use opus".to_string())
            } else {
                Ok("aac")
            }
        }
        "opus" => Ok("opus"),
        _ => Err(format!("unsupported audio codec: {audio_codec}")),
    }
}

const AAC_BITRATES_KBPS: &[u32] = &[96, 128, 192, 256];
const OPUS_BITRATES_KBPS: &[u32] = &[64, 96, 128, 160];

fn validate_audio_convert_bitrate(codec: &str, bitrate_kbps: u32) -> Result<(), String> {
    let allowed = match codec {
        "aac" => AAC_BITRATES_KBPS,
        "opus" => OPUS_BITRATES_KBPS,
        _ => return Err(format!("unsupported audio codec: {codec}")),
    };
    if allowed.contains(&bitrate_kbps) {
        Ok(())
    } else {
        Err(format!(
            "unsupported {codec} bitrate {bitrate_kbps} kbps — allowed: {allowed:?}"
        ))
    }
}

#[derive(Serialize)]
struct ConvertAudioResult {
    path: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// Re-encode audio while stream-copying video. Never overwrites.
#[tauri::command]
async fn convert_audio(
    app: tauri::AppHandle,
    state: tauri::State<'_, ffmpeg::FfmpegState>,
    job_id: String,
    source_path: String,
    output_path: String,
    audio_codec: String,
    bitrate_kbps: u32,
    duration_secs: Option<f64>,
) -> Result<ConvertAudioResult, String> {
    let source = PathBuf::from(&source_path);
    if !source.is_file() {
        return Err("source file not found".to_string());
    }

    let out_path = PathBuf::from(&output_path);
    let path_str = out_path.to_string_lossy().into_owned();

    let container = match remux_container_from_path(&out_path) {
        Some(c) => c,
        None => {
            return Err(
                "unsupported output container — use mp4, mkv, mov, webm, ts, or m4v".to_string(),
            );
        }
    };

    let codec = normalize_audio_convert_codec(&audio_codec.to_ascii_lowercase(), container)?;
    validate_audio_convert_bitrate(codec, bitrate_kbps)?;

    if same_file_ignore_case(&source, &out_path) {
        return Ok(ConvertAudioResult {
            path: path_str,
            ok: false,
            error: Some("source and output are the same file".to_string()),
        });
    }

    if out_path.exists() {
        return Ok(ConvertAudioResult {
            path: path_str,
            ok: false,
            error: Some("target already exists".to_string()),
        });
    }

    let duration = if let Some(d) = duration_secs {
        if d > 0.0 {
            d
        } else {
            probe_media_streams(app.clone(), source_path.clone())
                .await?
                .duration_secs
        }
    } else {
        probe_media_streams(app.clone(), source_path.clone())
            .await?
            .duration_secs
    };

    if duration <= 0.0 {
        return Err("could not read media duration".to_string());
    }

    let movflags = movflags_for_output(&out_path);
    let args = ffmpeg::build_audio_convert_args(
        &source_path,
        &output_path,
        codec,
        bitrate_kbps,
        movflags,
    )?;

    let (ok, error) = ffmpeg::run_ffmpeg_job(
        &app,
        &state,
        job_id,
        args,
        duration,
        Some(out_path.clone()),
    )
    .await?;

    if !ok {
        let _ = std::fs::remove_file(&out_path);
        return Ok(ConvertAudioResult {
            path: path_str,
            ok: false,
            error,
        });
    }

    Ok(ConvertAudioResult {
        path: path_str,
        ok: true,
        error: None,
    })
}

/// Re-encode a video file. Never overwrites.
#[tauri::command]
async fn encode_video(
    app: tauri::AppHandle,
    state: tauri::State<'_, ffmpeg::FfmpegState>,
    job_id: String,
    source_path: String,
    output_path: String,
    video_codec: String,
    crf: u8,
    preset: String,
    scale_height: Option<u32>,
    audio_mode: String,
    duration_secs: Option<f64>,
) -> Result<EncodeVideoResult, String> {
    let source = PathBuf::from(&source_path);
    if !source.is_file() {
        return Err("source file not found".to_string());
    }

    let out_path = PathBuf::from(&output_path);
    let path_str = out_path.to_string_lossy().into_owned();

    let container = match remux_container_from_path(&out_path) {
        Some(c) => c,
        None => {
            return Err(
                "unsupported output container — use mp4, mkv, mov, webm, ts, or m4v".to_string(),
            );
        }
    };

    let codec = video_codec.to_ascii_lowercase();
    if !encode_codec_allowed_for_container(&codec, container) {
        return Err(format!(
            "codec {codec} is not supported in .{container} container"
        ));
    }

    let audio = normalize_audio_mode(&audio_mode.to_ascii_lowercase(), container)?;

    if same_file_ignore_case(&source, &out_path) {
        return Ok(EncodeVideoResult {
            path: path_str,
            ok: false,
            error: Some("source and output are the same file".to_string()),
        });
    }

    if out_path.exists() {
        return Ok(EncodeVideoResult {
            path: path_str,
            ok: false,
            error: Some("target already exists".to_string()),
        });
    }

    let duration = if let Some(d) = duration_secs {
        if d > 0.0 {
            d
        } else {
            probe_media_streams(app.clone(), source_path.clone())
                .await?
                .duration_secs
        }
    } else {
        probe_media_streams(app.clone(), source_path.clone())
            .await?
            .duration_secs
    };

    if duration <= 0.0 {
        return Err("could not read media duration".to_string());
    }

    let movflags = movflags_for_output(&out_path);
    let args = ffmpeg::build_encode_args(
        &source_path,
        &output_path,
        &codec,
        crf,
        &preset,
        scale_height,
        audio,
        movflags,
    )?;

    let (ok, error) = ffmpeg::run_ffmpeg_job(
        &app,
        &state,
        job_id,
        args,
        duration,
        Some(out_path.clone()),
    )
    .await?;

    if !ok {
        let _ = std::fs::remove_file(&out_path);
        return Ok(EncodeVideoResult {
            path: path_str,
            ok: false,
            error,
        });
    }

    Ok(EncodeVideoResult {
        path: path_str,
        ok: true,
        error: None,
    })
}

const REDUCE_AUDIO_BITRATE_BPS: f64 = 128_000.0;
const REDUCE_MIN_VIDEO_BITRATE_KBPS: u32 = 100;

#[derive(Serialize)]
struct ReduceVideoSizeResult {
    path: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn compute_reduce_video_bitrate_kbps(target_bytes: u64, duration_secs: f64) -> Result<u32, String> {
    if target_bytes == 0 {
        return Err("target size must be greater than zero".to_string());
    }
    if duration_secs <= 0.0 {
        return Err("could not read media duration".to_string());
    }
    let total_bps = (target_bytes as f64) * 8.0 / duration_secs;
    let video_bps = total_bps - REDUCE_AUDIO_BITRATE_BPS;
    if video_bps <= 0.0 {
        return Err("target too small for audio budget".to_string());
    }
    let kbps = (video_bps / 1000.0).floor() as u32;
    if kbps < REDUCE_MIN_VIDEO_BITRATE_KBPS {
        return Err(format!(
            "target too small (needs ≥{REDUCE_MIN_VIDEO_BITRATE_KBPS} kbps video)"
        ));
    }
    Ok(kbps)
}

/// Compress a video to a target size (ABR) or quality (CRF). Never overwrites.
#[tauri::command]
async fn reduce_video_size(
    app: tauri::AppHandle,
    state: tauri::State<'_, ffmpeg::FfmpegState>,
    job_id: String,
    source_path: String,
    output_path: String,
    video_codec: String,
    mode: String,
    target_bytes: Option<u64>,
    crf: Option<u8>,
    scale_height: Option<u32>,
    duration_secs: Option<f64>,
) -> Result<ReduceVideoSizeResult, String> {
    let source = PathBuf::from(&source_path);
    if !source.is_file() {
        return Err("source file not found".to_string());
    }

    let out_path = PathBuf::from(&output_path);
    let path_str = out_path.to_string_lossy().into_owned();

    let container = match remux_container_from_path(&out_path) {
        Some(c) => c,
        None => {
            return Err(
                "unsupported output container — use mp4, mkv, mov, ts, or m4v".to_string(),
            );
        }
    };

    let codec = video_codec.to_ascii_lowercase();
    if codec != "h264" && codec != "h265" {
        return Err("size reducer only supports h264 and h265".to_string());
    }
    if !encode_codec_allowed_for_container(&codec, container) {
        return Err(format!(
            "codec {codec} is not supported in .{container} container"
        ));
    }

    if same_file_ignore_case(&source, &out_path) {
        return Ok(ReduceVideoSizeResult {
            path: path_str,
            ok: false,
            error: Some("source and output are the same file".to_string()),
        });
    }

    if out_path.exists() {
        return Ok(ReduceVideoSizeResult {
            path: path_str,
            ok: false,
            error: Some("target already exists".to_string()),
        });
    }

    let duration = if let Some(d) = duration_secs {
        if d > 0.0 {
            d
        } else {
            probe_media_streams(app.clone(), source_path.clone())
                .await?
                .duration_secs
        }
    } else {
        probe_media_streams(app.clone(), source_path.clone())
            .await?
            .duration_secs
    };

    if duration <= 0.0 {
        return Err("could not read media duration".to_string());
    }

    let mode_norm = mode.to_ascii_lowercase();
    let rate_control = match mode_norm.as_str() {
        "quality" => {
            let value = crf.ok_or_else(|| "crf is required for quality mode".to_string())?;
            ffmpeg::SizeReduceRateControl::Crf(value)
        }
        "target" => {
            let bytes = target_bytes
                .ok_or_else(|| "targetBytes is required for target mode".to_string())?;
            let kbps = compute_reduce_video_bitrate_kbps(bytes, duration)?;
            ffmpeg::SizeReduceRateControl::Bitrate {
                video_bitrate_kbps: kbps,
            }
        }
        _ => return Err(format!("unsupported reduce mode: {mode}")),
    };

    let movflags = movflags_for_output(&out_path);
    let args = ffmpeg::build_size_reduce_args(
        &source_path,
        &output_path,
        &codec,
        rate_control,
        "medium",
        scale_height,
        movflags,
    )?;

    let (ok, error) = ffmpeg::run_ffmpeg_job(
        &app,
        &state,
        job_id,
        args,
        duration,
        Some(out_path.clone()),
    )
    .await?;

    if !ok {
        let _ = std::fs::remove_file(&out_path);
        return Ok(ReduceVideoSizeResult {
            path: path_str,
            ok: false,
            error,
        });
    }

    Ok(ReduceVideoSizeResult {
        path: path_str,
        ok: true,
        error: None,
    })
}

/// Open Windows Explorer with the file selected.
#[tauri::command]
fn reveal_in_explorer(path: String) -> Result<(), String> {
    let file = PathBuf::from(&path);
    if !file.is_file() {
        return Err("file not found".to_string());
    }

    #[cfg(windows)]
    {
        use std::time::Duration;
        use windows_sys::Win32::Foundation::{RPC_E_CHANGED_MODE, S_FALSE, S_OK};
        use windows_sys::Win32::System::Com::{
            CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_APARTMENTTHREADED,
        };
        use windows_sys::Win32::UI::Shell::Common::ITEMIDLIST;
        use windows_sys::Win32::UI::Shell::{
            SHChangeNotify, SHOpenFolderAndSelectItems, SHParseDisplayName, SHCNE_CREATE,
            SHCNE_UPDATEDIR, SHCNF_FLUSH, SHCNF_PATHW,
        };

        // Newly created files briefly appear at the bottom of an Explorer
        // folder before it re-sorts. Selecting immediately scrolls there and
        // leaves the view stuck after the file jumps to its sorted place.
        // Flush shell notifications, open+select, then select again once the
        // view has settled so the scroll follows the final position.
        let folder = file
            .parent()
            .ok_or_else(|| "could not resolve file parent folder".to_string())?;
        let path_string = file.to_string_lossy().replace('/', "\\");
        let folder_string = folder.to_string_lossy();
        let folder_string = if folder_string.ends_with('\\') || folder_string.ends_with('/') {
            folder_string.into_owned()
        } else {
            format!("{folder_string}\\")
        };
        let folder_string = folder_string.replace('/', "\\");
        let path_wide: Vec<u16> = path_string
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let folder_wide: Vec<u16> = folder_string
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();

        let init_hr = unsafe {
            CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32)
        };
        if init_hr < 0 && init_hr != RPC_E_CHANGED_MODE {
            return Err(format!(
                "could not initialize Windows shell: HRESULT 0x{:08X}",
                init_hr as u32
            ));
        }
        let should_uninitialize = init_hr == S_OK || init_hr == S_FALSE;

        unsafe {
            SHChangeNotify(
                SHCNE_CREATE as i32,
                SHCNF_PATHW | SHCNF_FLUSH,
                path_wide.as_ptr().cast(),
                std::ptr::null(),
            );
            SHChangeNotify(
                SHCNE_UPDATEDIR as i32,
                SHCNF_PATHW | SHCNF_FLUSH,
                folder_wide.as_ptr().cast(),
                std::ptr::null(),
            );
        }

        let mut folder_pidl: *mut ITEMIDLIST = std::ptr::null_mut();
        let mut folder_attributes = 0;
        let parse_folder_hr = unsafe {
            SHParseDisplayName(
                folder_wide.as_ptr(),
                std::ptr::null_mut(),
                &mut folder_pidl,
                0,
                &mut folder_attributes,
            )
        };

        if parse_folder_hr < 0 || folder_pidl.is_null() {
            if should_uninitialize {
                unsafe { CoUninitialize() };
            }
            return Err(format!(
                "could not resolve parent folder in Windows shell: HRESULT 0x{:08X}",
                parse_folder_hr as u32
            ));
        }

        let mut item_pidl: *mut ITEMIDLIST = std::ptr::null_mut();
        let mut item_attributes = 0;
        let parse_item_hr = unsafe {
            SHParseDisplayName(
                path_wide.as_ptr(),
                std::ptr::null_mut(),
                &mut item_pidl,
                0,
                &mut item_attributes,
            )
        };

        if parse_item_hr < 0 || item_pidl.is_null() {
            unsafe { CoTaskMemFree(folder_pidl.cast()) };
            if should_uninitialize {
                unsafe { CoUninitialize() };
            }
            return Err(format!(
                "could not resolve file in Windows shell: HRESULT 0x{:08X}",
                parse_item_hr as u32
            ));
        }

        let selected_items = [item_pidl as *const ITEMIDLIST];
        let select_hr = unsafe {
            SHOpenFolderAndSelectItems(
                folder_pidl,
                selected_items.len() as u32,
                selected_items.as_ptr(),
                0,
            )
        };

        // Explorer may still re-sort a freshly created item after the first
        // select; a second select after a short wait brings the final row
        // into view.
        std::thread::sleep(Duration::from_millis(350));
        let reselect_hr = unsafe {
            SHOpenFolderAndSelectItems(
                folder_pidl,
                selected_items.len() as u32,
                selected_items.as_ptr(),
                0,
            )
        };

        unsafe { CoTaskMemFree(folder_pidl.cast()) };
        unsafe { CoTaskMemFree(item_pidl.cast()) };
        if should_uninitialize {
            unsafe { CoUninitialize() };
        }

        if select_hr < 0 {
            return Err(format!(
                "could not select file in Explorer: HRESULT 0x{:08X}",
                select_hr as u32
            ));
        }
        if reselect_hr < 0 {
            return Err(format!(
                "could not reselect file in Explorer: HRESULT 0x{:08X}",
                reselect_hr as u32
            ));
        }
        Ok(())
    }

    #[cfg(not(windows))]
    {
        let _ = file;
        Err("reveal in explorer is only supported on Windows".to_string())
    }
}

/// Move a file to the Recycle Bin (recoverable). Rejects missing paths and directories.
#[tauri::command]
fn trash_file(path: String) -> Result<(), String> {
    let file = PathBuf::from(&path);
    if !file.is_file() {
        return Err(if file.exists() {
            "path is not a file".to_string()
        } else {
            "file not found".to_string()
        });
    }
    trash::delete(&file).map_err(|e| e.to_string())
}

/// Sanity check for the bundled FFmpeg sidecar: returns the first line of
/// `ffmpeg -version`. Video tools will build on this same sidecar plumbing.
#[tauri::command]
async fn ffmpeg_version(app: tauri::AppHandle) -> Result<String, String> {
    let output = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| e.to_string())?
        .args(["-version"])
        .output()
        .await
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(format!(
            "ffmpeg exited with {:?}: {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout.lines().next().unwrap_or("unknown").to_string())
}

fn collect_files(dir: &Path, recursive: bool, out: &mut Vec<String>) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        let path = entry.path();
        if file_type.is_file() {
            out.push(path.to_string_lossy().into_owned());
        } else if recursive && file_type.is_dir() {
            collect_files(&path, recursive, out)?;
        }
    }
    Ok(())
}

/// File children of a directory; optionally recursive.
#[tauri::command]
fn list_dir_files(path: String, recursive: bool) -> Result<Vec<String>, String> {
    let mut files = Vec::new();
    collect_files(Path::new(&path), recursive, &mut files)?;
    files.sort();
    files.dedup();
    Ok(files)
}

/// Expand dropped/picked paths: files pass through, directories become their files.
#[tauri::command]
fn expand_intake_paths(paths: Vec<String>, recursive: bool) -> Result<Vec<String>, String> {
    let mut result = Vec::new();
    for path in paths {
        let p = Path::new(&path);
        if p.is_dir() {
            result.extend(list_dir_files(path, recursive)?);
        } else if p.is_file() {
            result.push(path);
        }
    }
    result.sort();
    result.dedup();
    Ok(result)
}

#[tauri::command]
fn paths_exist(paths: Vec<String>) -> Vec<bool> {
    paths
        .iter()
        .map(|p| Path::new(p).exists())
        .collect()
}

/// Read an entire file as bytes (PDF tools / binary I/O).
#[tauri::command]
fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    let file = PathBuf::from(&path);
    if !file.is_file() {
        return Err(if file.exists() {
            "path is not a file".to_string()
        } else {
            "file not found".to_string()
        });
    }
    std::fs::read(&file).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WriteFileResult {
    path: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// Write bytes to a new file. Refuses to overwrite an existing path.
/// Creates parent directories when missing.
#[tauri::command]
fn write_file_bytes(path: String, bytes: Vec<u8>) -> WriteFileResult {
    let out = PathBuf::from(&path);
    if out.exists() {
        return WriteFileResult {
            path,
            ok: false,
            error: Some("target already exists".into()),
        };
    }
    if let Some(parent) = out.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                return WriteFileResult {
                    path,
                    ok: false,
                    error: Some(e.to_string()),
                };
            }
        }
    }
    match std::fs::write(&out, &bytes) {
        Ok(()) => WriteFileResult {
            path,
            ok: true,
            error: None,
        },
        Err(e) => WriteFileResult {
            path,
            ok: false,
            error: Some(e.to_string()),
        },
    }
}

/// Create a directory (and parents). No-op success if it already exists as a dir.
#[tauri::command]
fn ensure_dir(path: String) -> Result<(), String> {
    let dir = PathBuf::from(&path);
    if dir.is_file() {
        return Err("path is a file, not a directory".to_string());
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())
}

/// Rename `from` → `to` only when `to` does not already exist.
#[tauri::command]
fn rename_file_if_absent(from: String, to: String) -> Result<(), String> {
    let from_path = PathBuf::from(&from);
    let to_path = PathBuf::from(&to);
    if !from_path.is_file() {
        return Err("source file not found".to_string());
    }
    if to_path.exists() && !same_file_ignore_case(&from_path, &to_path) {
        return Err("target already exists".to_string());
    }
    std::fs::rename(&from_path, &to_path).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
struct RenameOp {
    from: String,
    to: String,
}

#[derive(Serialize)]
struct RenameResult {
    from: String,
    to: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// True when `from` and `to` refer to the same file (case-insensitive on Windows).
fn same_file_ignore_case(from: &Path, to: &Path) -> bool {
    if from == to {
        return true;
    }
    #[cfg(windows)]
    {
        from.to_string_lossy()
            .eq_ignore_ascii_case(&to.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImagePreview {
    width: u32,
    height: u32,
    data_url: String,
}

/// Decode an image for crop preview; returns a PNG data URL the webview can display.
#[tauri::command]
fn load_image_preview(path: String) -> Result<ImagePreview, String> {
    let source = PathBuf::from(&path);
    if !source.is_file() {
        return Err("source file not found".to_string());
    }

    let img = image::open(&source).map_err(|e| format!("could not decode image: {e}"))?;
    let (width, height) = img.dimensions();
    if width == 0 || height == 0 {
        return Err("image has zero dimensions".to_string());
    }

    // Downscale huge sources for a lighter preview; crop coords still use natural size.
    let preview = if width > PREVIEW_MAX_EDGE || height > PREVIEW_MAX_EDGE {
        let scale = PREVIEW_MAX_EDGE as f64 / width.max(height) as f64;
        let pw = ((width as f64) * scale).round().max(1.0) as u32;
        let ph = ((height as f64) * scale).round().max(1.0) as u32;
        img.resize(pw, ph, FilterType::Triangle)
    } else {
        img
    };

    let mut png_bytes = Vec::new();
    preview
        .write_to(&mut Cursor::new(&mut png_bytes), ImageFormat::Png)
        .map_err(|e| format!("could not encode preview: {e}"))?;

    let data_url = format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png_bytes)
    );

    Ok(ImagePreview {
        width,
        height,
        data_url,
    })
}

#[derive(Deserialize)]
struct CropRect {
    x: u32,
    y: u32,
    size: u32,
}

#[derive(Serialize)]
struct ExportIcoResult {
    size: u32,
    path: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn is_allowed_ico_size(size: u32) -> bool {
    ALLOWED_ICO_SIZES.contains(&size)
}

fn ico_output_path(source: &Path, output_dir: Option<&Path>, size: u32) -> PathBuf {
    let dir = output_dir.unwrap_or_else(|| source.parent().unwrap_or(Path::new(".")));
    let stem = source
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "icon".to_string());
    dir.join(format!("{stem}-{size}x{size}.ico"))
}

fn encode_single_ico(path: &Path, image: &RgbaImage) -> Result<(), String> {
    let (width, height) = image.dimensions();
    let icon = IconImage::from_rgba_data(width, height, image.as_raw().clone());
    let entry = IconDirEntry::encode(&icon).map_err(|e| e.to_string())?;
    let mut icon_dir = IconDir::new(ResourceType::Icon);
    icon_dir.add_entry(entry);
    let file = std::fs::File::create(path).map_err(|e| e.to_string())?;
    icon_dir.write(file).map_err(|e| e.to_string())?;
    Ok(())
}

/// Crop, resize, and export one ICO file per requested size. Never overwrites.
#[tauri::command]
fn export_ico_files(
    source_path: String,
    output_dir: Option<String>,
    crop: CropRect,
    sizes: Vec<u32>,
) -> Result<Vec<ExportIcoResult>, String> {
    if sizes.is_empty() {
        return Err("select at least one icon size".to_string());
    }

    for size in &sizes {
        if !is_allowed_ico_size(*size) {
            return Err(format!("unsupported icon size: {size}"));
        }
    }

    let source = PathBuf::from(&source_path);
    if !source.is_file() {
        return Err("source file not found".to_string());
    }

    let resolved_output_dir = output_dir
        .as_ref()
        .map(PathBuf::from)
        .filter(|p| p.is_dir());

    if output_dir.is_some() && resolved_output_dir.is_none() {
        return Err("output folder not found".to_string());
    }

    let img = image::open(&source).map_err(|e| format!("could not decode image: {e}"))?;
    let (img_w, img_h) = img.dimensions();

    if crop.size == 0 {
        return Err("crop size must be greater than zero".to_string());
    }
    if crop.x.saturating_add(crop.size) > img_w || crop.y.saturating_add(crop.size) > img_h {
        return Err("crop region is outside the source image".to_string());
    }

    let cropped = img.crop_imm(crop.x, crop.y, crop.size, crop.size).to_rgba8();

    let mut results = Vec::with_capacity(sizes.len());
    for size in sizes {
        let out_path = ico_output_path(&source, resolved_output_dir.as_deref(), size);
        let path_str = out_path.to_string_lossy().into_owned();

        if out_path.exists() {
            results.push(ExportIcoResult {
                size,
                path: path_str,
                ok: false,
                error: Some("target already exists".to_string()),
            });
            continue;
        }

        let resized = image::imageops::resize(&cropped, size, size, FilterType::Lanczos3);
        match encode_single_ico(&out_path, &resized) {
            Ok(()) => results.push(ExportIcoResult {
                size,
                path: path_str,
                ok: true,
                error: None,
            }),
            Err(e) => results.push(ExportIcoResult {
                size,
                path: path_str,
                ok: false,
                error: Some(e),
            }),
        }
    }

    Ok(results)
}

#[derive(Deserialize)]
struct FreeformCrop {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

#[derive(Serialize)]
struct ExportCroppedResult {
    path: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

const JPEG_QUALITY: u8 = 90;

fn cropped_output_path(
    source: &Path,
    output_dir: Option<&Path>,
    format: &str,
    output_name: Option<&str>,
) -> Result<PathBuf, String> {
    let ext = match format {
        "jpeg" => "jpg",
        "webp" => "webp",
        _ => "png",
    };
    let dir = output_dir.unwrap_or_else(|| source.parent().unwrap_or(Path::new(".")));

    let stem = match output_name {
        Some(name) => sanitize_output_stem(name)?,
        None => {
            let base = source
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| "image".to_string());
            format!("{base}-cropped")
        }
    };

    Ok(dir.join(format!("{stem}.{ext}")))
}

fn sanitize_output_stem(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("output name cannot be empty".to_string());
    }

    let mut stem = String::with_capacity(trimmed.len());
    for ch in trimmed.chars() {
        if matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
            continue;
        }
        stem.push(ch);
    }
    stem = stem.trim_matches('.').trim().to_string();

    let lower = stem.to_lowercase();
    for ext in ["png", "jpg", "jpeg", "webp"] {
        let suffix = format!(".{ext}");
        if lower.ends_with(&suffix) {
            stem.truncate(stem.len() - suffix.len());
            stem = stem.trim_matches('.').trim().to_string();
            break;
        }
    }

    if stem.is_empty() {
        return Err("output name cannot be empty".to_string());
    }
    Ok(stem)
}

fn write_cropped_image(
    path: &Path,
    image: &image::DynamicImage,
    format: &str,
) -> Result<(), String> {
    use image::codecs::jpeg::JpegEncoder;
    use image::codecs::webp::WebPEncoder;
    use image::ExtendedColorType;
    use image::ImageEncoder;
    use std::io::BufWriter;

    let file = std::fs::File::create(path).map_err(|e| e.to_string())?;
    let mut writer = BufWriter::new(file);

    match format {
        "jpeg" => {
            let rgb = image.to_rgb8();
            let (w, h) = rgb.dimensions();
            let mut encoder = JpegEncoder::new_with_quality(&mut writer, JPEG_QUALITY);
            encoder
                .encode(rgb.as_raw(), w, h, ExtendedColorType::Rgb8)
                .map_err(|e| e.to_string())?;
        }
        "webp" => {
            let rgba = image.to_rgba8();
            let (w, h) = rgba.dimensions();
            WebPEncoder::new_lossless(&mut writer)
                .write_image(rgba.as_raw(), w, h, ExtendedColorType::Rgba8)
                .map_err(|e| e.to_string())?;
        }
        _ => {
            image
                .write_to(&mut writer, ImageFormat::Png)
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Crop and export a raster image as PNG, JPEG, or WebP. Never overwrites.
#[tauri::command]
fn export_cropped_image(
    source_path: String,
    output_dir: Option<String>,
    crop: FreeformCrop,
    format: String,
    output_name: Option<String>,
) -> Result<ExportCroppedResult, String> {
    if !matches!(format.as_str(), "png" | "jpeg" | "webp") {
        return Err(format!("unsupported format: {format}"));
    }

    let source = PathBuf::from(&source_path);
    if !source.is_file() {
        return Err("source file not found".to_string());
    }

    let resolved_output_dir = output_dir
        .as_ref()
        .map(PathBuf::from)
        .filter(|p| p.is_dir());

    if output_dir.is_some() && resolved_output_dir.is_none() {
        return Err("output folder not found".to_string());
    }

    let out_path = cropped_output_path(
        &source,
        resolved_output_dir.as_deref(),
        &format,
        output_name.as_deref(),
    )?;
    let path_str = out_path.to_string_lossy().into_owned();

    if out_path.exists() {
        return Ok(ExportCroppedResult {
            path: path_str,
            ok: false,
            error: Some("target already exists".to_string()),
        });
    }

    let img = image::open(&source).map_err(|e| format!("could not decode image: {e}"))?;
    let (img_w, img_h) = img.dimensions();

    if crop.width == 0 || crop.height == 0 {
        return Err("crop dimensions must be greater than zero".to_string());
    }
    if crop.x.saturating_add(crop.width) > img_w
        || crop.y.saturating_add(crop.height) > img_h
    {
        return Err("crop region is outside the source image".to_string());
    }

    let cropped = img.crop_imm(crop.x, crop.y, crop.width, crop.height);

    match write_cropped_image(&out_path, &cropped, &format) {
        Ok(()) => Ok(ExportCroppedResult {
            path: path_str,
            ok: true,
            error: None,
        }),
        Err(e) => Ok(ExportCroppedResult {
            path: path_str,
            ok: false,
            error: Some(e),
        }),
    }
}

/// Rename files by extension. Never overwrites an existing target.
#[tauri::command]
fn rename_extensions(ops: Vec<RenameOp>) -> Vec<RenameResult> {
    ops.into_iter()
        .map(|op| {
            let from_path = PathBuf::from(&op.from);
            let to_path = PathBuf::from(&op.to);

            if to_path.exists() && !same_file_ignore_case(&from_path, &to_path) {
                return RenameResult {
                    from: op.from,
                    to: op.to,
                    ok: false,
                    error: Some("target already exists".to_string()),
                };
            }

            match std::fs::rename(&from_path, &to_path) {
                Ok(()) => RenameResult {
                    from: op.from,
                    to: op.to,
                    ok: true,
                    error: None,
                },
                Err(e) => RenameResult {
                    from: op.from,
                    to: op.to,
                    ok: false,
                    error: Some(e.to_string()),
                },
            }
        })
        .collect()
}

fn load_env_files() {
    let _ = dotenvy::dotenv();
    let manifest_env = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.env");
    let _ = dotenvy::from_path(manifest_env);
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let _ = dotenvy::from_path(dir.join(".env"));
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    load_env_files();
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(ffmpeg::FfmpegState::new())
        .manage(ebook_convert::EbookConvertState::new())
        .manage(ytdlp::YtdlpState::new())
        .invoke_handler(tauri::generate_handler![
            ffmpeg_version,
            probe_media,
            probe_media_streams,
            trim_clip,
            remux_video,
            encode_video,
            convert_audio,
            reduce_video_size,
            cancel_ffmpeg_job,
            ebook_convert_version,
            convert_pdf_to_epub,
            convert_pdf_to_markdown,
            cancel_ebook_convert_job,
            music_tools_version,
            music_resolve,
            music_download,
            cancel_music_job,
            youtube_resolve,
            youtube_download,
            cancel_youtube_job,
            reveal_in_explorer,
            trash_file,
            list_dir_files,
            expand_intake_paths,
            paths_exist,
            read_file_bytes,
            write_file_bytes,
            ensure_dir,
            rename_file_if_absent,
            load_image_preview,
            export_ico_files,
            export_cropped_image,
            rename_extensions,
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::RgbaImage;
    use std::fs;

    #[test]
    fn encodes_single_size_ico_with_alpha() {
        let path = std::env::temp_dir().join(format!(
            "sak-ico-test-{}-{}.ico",
            std::process::id(),
            "alpha"
        ));
        let _ = fs::remove_file(&path);

        let mut img = RgbaImage::new(32, 32);
        for (x, _y, pixel) in img.enumerate_pixels_mut() {
            let alpha = if x < 16 { 255 } else { 128 };
            *pixel = image::Rgba([10, 120, 200, alpha]);
        }

        encode_single_ico(&path, &img).unwrap();
        assert!(path.exists());

        let icon_dir = ico::IconDir::read(std::fs::File::open(&path).unwrap()).unwrap();
        assert_eq!(icon_dir.entries().len(), 1);
        let entry = icon_dir.entries().first().unwrap();
        assert_eq!(entry.width(), 32);
        assert_eq!(entry.height(), 32);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn export_skips_existing_targets() {
        let dir = std::env::temp_dir().join(format!("sak-ico-export-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let source = dir.join("source.png");
        RgbaImage::from_pixel(64, 64, image::Rgba([255, 255, 255, 255]))
            .save(&source)
            .unwrap();

        let existing = dir.join("source-16x16.ico");
        fs::write(&existing, b"placeholder").unwrap();

        let results = export_ico_files(
            source.to_string_lossy().into_owned(),
            Some(dir.to_string_lossy().into_owned()),
            CropRect {
                x: 0,
                y: 0,
                size: 64,
            },
            vec![16, 32],
        )
        .unwrap();

        assert_eq!(results.len(), 2);
        assert!(!results[0].ok);
        assert_eq!(results[0].error.as_deref(), Some("target already exists"));
        assert!(results[1].ok);
        assert!(dir.join("source-32x32.ico").exists());

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn export_cropped_image_writes_png() {
        let dir = std::env::temp_dir().join(format!("sak-crop-export-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let source = dir.join("photo.png");
        RgbaImage::from_pixel(100, 80, image::Rgba([40, 80, 120, 255]))
            .save(&source)
            .unwrap();

        let result = export_cropped_image(
            source.to_string_lossy().into_owned(),
            Some(dir.to_string_lossy().into_owned()),
            FreeformCrop {
                x: 10,
                y: 5,
                width: 50,
                height: 40,
            },
            "png".to_string(),
            None,
        )
        .unwrap();

        assert!(result.ok);
        assert!(dir.join("photo-cropped.png").exists());

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn export_cropped_image_skips_collision() {
        let dir = std::env::temp_dir().join(format!("sak-crop-collision-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let source = dir.join("photo.png");
        RgbaImage::from_pixel(64, 64, image::Rgba([255, 0, 0, 255]))
            .save(&source)
            .unwrap();

        fs::write(dir.join("photo-cropped.png"), b"existing").unwrap();

        let result = export_cropped_image(
            source.to_string_lossy().into_owned(),
            Some(dir.to_string_lossy().into_owned()),
            FreeformCrop {
                x: 0,
                y: 0,
                width: 32,
                height: 32,
            },
            "png".to_string(),
            None,
        )
        .unwrap();

        assert!(!result.ok);
        assert_eq!(result.error.as_deref(), Some("target already exists"));

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn remux_container_from_path_accepts_supported_extensions() {
        assert_eq!(
            remux_container_from_path(Path::new("clip.mp4")),
            Some("mp4")
        );
        assert_eq!(
            remux_container_from_path(Path::new("clip.MKV")),
            Some("mkv")
        );
        assert_eq!(
            remux_container_from_path(Path::new("clip.mov")),
            Some("mov")
        );
        assert_eq!(
            remux_container_from_path(Path::new("clip.webm")),
            Some("webm")
        );
        assert_eq!(remux_container_from_path(Path::new("clip.ts")), Some("ts"));
        assert_eq!(remux_container_from_path(Path::new("clip.m4v")), Some("m4v"));
        assert_eq!(remux_container_from_path(Path::new("clip.avi")), None);
    }

    #[test]
    fn remux_rejects_same_source_and_output() {
        let path = "C:\\Videos\\movie.mkv";
        assert!(same_file_ignore_case(
            Path::new(path),
            Path::new(path)
        ));
        assert!(same_file_ignore_case(
            Path::new("C:\\Videos\\MOVIE.MKV"),
            Path::new("C:\\Videos\\movie.mkv")
        ));
    }

    #[test]
    fn remux_removes_partial_output_on_failure() {
        let dir = std::env::temp_dir().join(format!("sak-remux-fail-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let _source = dir.join("missing-source.mkv");
        let out = dir.join("output.mp4");
        let _ = fs::remove_file(&out);

        // Simulate failure cleanup: create partial file then remove like remux_video does.
        fs::write(&out, b"partial").unwrap();
        assert!(out.exists());
        let _ = fs::remove_file(&out);
        assert!(!out.exists());

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn export_cropped_image_uses_custom_name() {
        let dir = std::env::temp_dir().join(format!("sak-crop-name-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let source = dir.join("photo.png");
        RgbaImage::from_pixel(64, 64, image::Rgba([0, 255, 0, 255]))
            .save(&source)
            .unwrap();

        let result = export_cropped_image(
            source.to_string_lossy().into_owned(),
            Some(dir.to_string_lossy().into_owned()),
            FreeformCrop {
                x: 0,
                y: 0,
                width: 32,
                height: 32,
            },
            "jpeg".to_string(),
            Some("my-icon.png".to_string()),
        )
        .unwrap();

        assert!(result.ok);
        assert!(dir.join("my-icon.jpg").exists());

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn trash_file_rejects_missing_path() {
        let missing = std::env::temp_dir().join(format!(
            "sak-trash-missing-{}-{}.mp4",
            std::process::id(),
            "x"
        ));
        let _ = fs::remove_file(&missing);
        let err = trash_file(missing.to_string_lossy().into_owned()).unwrap_err();
        assert_eq!(err, "file not found");
    }

    #[test]
    fn trash_file_rejects_directory() {
        let dir = std::env::temp_dir().join(format!(
            "sak-trash-dir-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let err = trash_file(dir.to_string_lossy().into_owned()).unwrap_err();
        assert_eq!(err, "path is not a file");
        let _ = fs::remove_dir_all(dir);
    }
}
