use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

pub struct FfmpegState {
    active: Mutex<Option<ActiveJob>>,
}

struct ActiveJob {
    job_id: String,
    child: tauri_plugin_shell::process::CommandChild,
    output_path: Option<PathBuf>,
}

impl FfmpegState {
    pub fn new() -> Self {
        Self {
            active: Mutex::new(None),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegProgressPayload {
    pub job_id: String,
    pub ratio: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegDonePayload {
    pub job_id: String,
    pub ok: bool,
    pub error: Option<String>,
}

const PROGRESS_EVENT: &str = "ffmpeg-progress";
const DONE_EVENT: &str = "ffmpeg-done";

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

fn parse_progress_ratio(line: &str, duration_us: f64) -> Option<f64> {
    if duration_us <= 0.0 {
        return None;
    }
    let value = line
        .strip_prefix("out_time_ms=")
        .or_else(|| line.strip_prefix("out_time_us="))
        .and_then(|v| v.parse::<f64>().ok());
    if let Some(ms) = value {
        let us = if line.starts_with("out_time_ms=") {
            ms * 1000.0
        } else {
            ms
        };
        return Some((us / duration_us).clamp(0.0, 1.0));
    }
    if let Some(time) = line.strip_prefix("time=") {
        return parse_time_ratio(time, duration_us);
    }
    None
}

fn parse_time_ratio(time: &str, duration_us: f64) -> Option<f64> {
    let parts: Vec<&str> = time.split(':').collect();
    if parts.len() != 3 {
        return None;
    }
    let hours = parts[0].parse::<f64>().ok()?;
    let minutes = parts[1].parse::<f64>().ok()?;
    let seconds = parts[2].parse::<f64>().ok()?;
    let elapsed_us = (hours * 3600.0 + minutes * 60.0 + seconds) * 1_000_000.0;
    Some((elapsed_us / duration_us).clamp(0.0, 1.0))
}

fn parse_stderr_time(stderr_chunk: &str, duration_us: f64) -> Option<f64> {
    for line in stderr_chunk.lines() {
        if let Some(idx) = line.find("time=") {
            let rest = &line[idx + 5..];
            let time = rest.split_whitespace().next().unwrap_or("");
            if let Some(ratio) = parse_time_ratio(time, duration_us) {
                return Some(ratio);
            }
        }
    }
    None
}

pub async fn run_ffmpeg_job(
    app: &AppHandle,
    state: &FfmpegState,
    job_id: String,
    args: Vec<String>,
    duration_secs: f64,
    output_path: Option<PathBuf>,
) -> Result<(bool, Option<String>), String> {
    if state
        .active
        .lock()
        .map_err(|e| e.to_string())?
        .is_some()
    {
        return Err("another ffmpeg job is already running".to_string());
    }

    let mut command_args = vec![
        "-hide_banner".to_string(),
        "-nostats".to_string(),
        "-progress".to_string(),
        "pipe:1".to_string(),
    ];
    command_args.extend(args);

    let (mut rx, child) = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| e.to_string())?
        .args(command_args)
        .spawn()
        .map_err(|e| e.to_string())?;

    state
        .active
        .lock()
        .map_err(|e| e.to_string())?
        .replace(ActiveJob {
            job_id: job_id.clone(),
            child,
            output_path: output_path.clone(),
        });

    let duration_us = duration_secs.max(0.001) * 1_000_000.0;
    let mut stderr = String::new();
    let mut exit_code: Option<i32> = None;
    let mut last_ratio = 0.0;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                let chunk = String::from_utf8_lossy(&bytes);
                for line in chunk.lines() {
                    if let Some(ratio) = parse_progress_ratio(line, duration_us) {
                        if ratio > last_ratio {
                            last_ratio = ratio;
                            let _ = app.emit(
                                PROGRESS_EVENT,
                                FfmpegProgressPayload {
                                    job_id: job_id.clone(),
                                    ratio,
                                },
                            );
                        }
                    }
                }
            }
            CommandEvent::Stderr(bytes) => {
                let chunk = String::from_utf8_lossy(&bytes);
                stderr.push_str(&chunk);
                if let Some(ratio) = parse_stderr_time(&chunk, duration_us) {
                    if ratio > last_ratio {
                        last_ratio = ratio;
                        let _ = app.emit(
                            PROGRESS_EVENT,
                            FfmpegProgressPayload {
                                job_id: job_id.clone(),
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

    let was_cancelled = state.active.lock().map_err(|e| e.to_string())?.is_none();
    if !was_cancelled {
        state.active.lock().map_err(|e| e.to_string())?.take();
    }

    let ok = exit_code == Some(0);
    let error = if ok {
        None
    } else if was_cancelled {
        Some("cancelled".to_string())
    } else {
        Some(trim_stderr_tail(&stderr, 2000))
    };

    let _ = app.emit(
        DONE_EVENT,
        FfmpegDonePayload {
            job_id,
            ok,
            error: error.clone(),
        },
    );

    Ok((ok, error))
}

pub fn cancel_job(state: &FfmpegState, job_id: &str) -> Result<(), String> {
    let mut guard = state.active.lock().map_err(|e| e.to_string())?;
    let job = guard.take();
    if job.is_none() {
        return Err("no active ffmpeg job".to_string());
    }
    let job = job.unwrap();
    if job.job_id != job_id {
        *guard = Some(job);
        return Err("job id does not match active ffmpeg job".to_string());
    }

    if let Some(path) = job.output_path {
        let _ = std::fs::remove_file(path);
    }

    job.child.kill().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn build_remux_args(
    source_path: &str,
    output_path: &str,
    stream_indices: &[u32],
    movflags: Option<&str>,
) -> Vec<String> {
    let mut args = vec!["-i".to_string(), source_path.to_string()];

    if stream_indices.is_empty() {
        args.push("-map".to_string());
        args.push("0".to_string());
    } else {
        for index in stream_indices {
            args.push("-map".to_string());
            args.push(format!("0:{index}"));
        }
    }

    args.push("-c".to_string());
    args.push("copy".to_string());

    if let Some(flags) = movflags {
        args.push("-movflags".to_string());
        args.push(flags.to_string());
    }

    args.push(output_path.to_string());
    args
}

/// Map a shared UI preset name to encoder-specific speed knobs.
fn encode_speed_args(video_codec: &str, preset: &str) -> Result<Vec<String>, String> {
    let normalized = preset.to_ascii_lowercase();
    match video_codec {
        "h264" | "h265" => {
            let allowed = [
                "ultrafast",
                "superfast",
                "veryfast",
                "faster",
                "fast",
                "medium",
                "slow",
                "slower",
                "veryslow",
            ];
            if !allowed.contains(&normalized.as_str()) {
                return Err(format!("unsupported preset: {preset}"));
            }
            Ok(vec!["-preset".to_string(), normalized])
        }
        "vp9" => {
            let cpu_used = match normalized.as_str() {
                "ultrafast" | "superfast" => 8,
                "veryfast" | "faster" => 6,
                "fast" => 5,
                "medium" => 4,
                "slow" => 2,
                "slower" | "veryslow" => 0,
                _ => return Err(format!("unsupported preset: {preset}")),
            };
            Ok(vec!["-cpu-used".to_string(), cpu_used.to_string()])
        }
        "av1" => {
            // libsvtav1 preset: 0 (slow/quality) … 12 (fast)
            let svt_preset = match normalized.as_str() {
                "ultrafast" | "superfast" => 12,
                "veryfast" | "faster" => 10,
                "fast" => 8,
                "medium" => 6,
                "slow" => 4,
                "slower" => 2,
                "veryslow" => 1,
                _ => return Err(format!("unsupported preset: {preset}")),
            };
            Ok(vec!["-preset".to_string(), svt_preset.to_string()])
        }
        _ => Err(format!("unsupported video codec: {video_codec}")),
    }
}

fn encoder_name(video_codec: &str) -> Result<&'static str, String> {
    match video_codec {
        "h264" => Ok("libx264"),
        "h265" => Ok("libx265"),
        "vp9" => Ok("libvpx-vp9"),
        "av1" => Ok("libsvtav1"),
        _ => Err(format!("unsupported video codec: {video_codec}")),
    }
}

/// Build FFmpeg args for a software re-encode.
///
/// `scale_height`: when set, scale to that height keeping aspect ratio (even dims).
/// `audio_mode`: `"copy"`, `"aac"`, or `"opus"`.
pub fn build_encode_args(
    source_path: &str,
    output_path: &str,
    video_codec: &str,
    crf: u8,
    preset: &str,
    scale_height: Option<u32>,
    audio_mode: &str,
    movflags: Option<&str>,
) -> Result<Vec<String>, String> {
    let encoder = encoder_name(video_codec)?;
    if !(0..=63).contains(&crf) {
        return Err("crf must be between 0 and 63".to_string());
    }

    let mut args = vec![
        "-i".to_string(),
        source_path.to_string(),
        "-map".to_string(),
        "0:v:0".to_string(),
        "-map".to_string(),
        "0:a?".to_string(),
        "-c:v".to_string(),
        encoder.to_string(),
        "-crf".to_string(),
        crf.to_string(),
    ];

    // VP9 CRF mode requires explicit unconstrained bitrate.
    if video_codec == "vp9" {
        args.push("-b:v".to_string());
        args.push("0".to_string());
    }

    args.extend(encode_speed_args(video_codec, preset)?);

    if let Some(height) = scale_height {
        if height == 0 || height > 8192 {
            return Err("scale height out of range".to_string());
        }
        // -2 keeps aspect ratio and forces even width for yuv420p encoders.
        args.push("-vf".to_string());
        args.push(format!("scale=-2:{height}"));
    }

    match audio_mode {
        "copy" => {
            args.push("-c:a".to_string());
            args.push("copy".to_string());
        }
        "aac" => {
            args.push("-c:a".to_string());
            args.push("aac".to_string());
            args.push("-b:a".to_string());
            args.push("192k".to_string());
        }
        "opus" => {
            args.push("-c:a".to_string());
            args.push("libopus".to_string());
            args.push("-b:a".to_string());
            args.push("128k".to_string());
        }
        _ => return Err(format!("unsupported audio mode: {audio_mode}")),
    }

    // Drop data/subtitle streams implicitly by not mapping them.
    args.push("-sn".to_string());
    args.push("-dn".to_string());

    if let Some(flags) = movflags {
        args.push("-movflags".to_string());
        args.push(flags.to_string());
    }

    args.push(output_path.to_string());
    Ok(args)
}

/// Build FFmpeg args to re-encode audio while stream-copying video.
///
/// `audio_codec`: `"aac"` or `"opus"`.
/// `bitrate_kbps`: target audio bitrate in kilobits per second.
pub fn build_audio_convert_args(
    source_path: &str,
    output_path: &str,
    audio_codec: &str,
    bitrate_kbps: u32,
    movflags: Option<&str>,
) -> Result<Vec<String>, String> {
    if bitrate_kbps == 0 {
        return Err("audio bitrate must be greater than zero".to_string());
    }

    let encoder = match audio_codec {
        "aac" => "aac",
        "opus" => "libopus",
        _ => return Err(format!("unsupported audio codec: {audio_codec}")),
    };

    let mut args = vec![
        "-i".to_string(),
        source_path.to_string(),
        "-map".to_string(),
        "0:v:0".to_string(),
        "-map".to_string(),
        "0:a?".to_string(),
        "-c:v".to_string(),
        "copy".to_string(),
        "-c:a".to_string(),
        encoder.to_string(),
        "-b:a".to_string(),
        format!("{bitrate_kbps}k"),
        "-sn".to_string(),
        "-dn".to_string(),
    ];

    if let Some(flags) = movflags {
        args.push("-movflags".to_string());
        args.push(flags.to_string());
    }

    args.push(output_path.to_string());
    Ok(args)
}

/// Rate control for size-reduce encodes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SizeReduceRateControl {
    /// CRF quality mode.
    Crf(u8),
    /// One-pass ABR aiming at a target size (`video_bitrate_kbps`).
    Bitrate { video_bitrate_kbps: u32 },
}

/// Build FFmpeg args for size reduction (H.264 / H.265 only).
///
/// Audio is always AAC at 128k so target-size bitrate math stays predictable.
/// Preset is fixed to `medium` by the caller for quality consistency.
pub fn build_size_reduce_args(
    source_path: &str,
    output_path: &str,
    video_codec: &str,
    rate_control: SizeReduceRateControl,
    preset: &str,
    scale_height: Option<u32>,
    movflags: Option<&str>,
) -> Result<Vec<String>, String> {
    if video_codec != "h264" && video_codec != "h265" {
        return Err(format!(
            "size reducer only supports h264 and h265, got {video_codec}"
        ));
    }

    let encoder = encoder_name(video_codec)?;

    let mut args = vec![
        "-i".to_string(),
        source_path.to_string(),
        "-map".to_string(),
        "0:v:0".to_string(),
        "-map".to_string(),
        "0:a?".to_string(),
        "-c:v".to_string(),
        encoder.to_string(),
    ];

    match rate_control {
        SizeReduceRateControl::Crf(crf) => {
            if !(0..=51).contains(&crf) {
                return Err("crf must be between 0 and 51".to_string());
            }
            args.push("-crf".to_string());
            args.push(crf.to_string());
        }
        SizeReduceRateControl::Bitrate {
            video_bitrate_kbps,
        } => {
            if video_bitrate_kbps < 100 {
                return Err("video bitrate must be at least 100 kbps".to_string());
            }
            let bv = format!("{video_bitrate_kbps}k");
            let buf = format!("{}k", video_bitrate_kbps.saturating_mul(2));
            args.push("-b:v".to_string());
            args.push(bv.clone());
            args.push("-maxrate".to_string());
            args.push(bv);
            args.push("-bufsize".to_string());
            args.push(buf);
        }
    }

    args.extend(encode_speed_args(video_codec, preset)?);

    if let Some(height) = scale_height {
        if height == 0 || height > 8192 {
            return Err("scale height out of range".to_string());
        }
        args.push("-vf".to_string());
        args.push(format!("scale=-2:{height}"));
    }

    args.push("-c:a".to_string());
    args.push("aac".to_string());
    args.push("-b:a".to_string());
    args.push("128k".to_string());

    args.push("-sn".to_string());
    args.push("-dn".to_string());

    if let Some(flags) = movflags {
        args.push("-movflags".to_string());
        args.push(flags.to_string());
    }

    args.push(output_path.to_string());
    Ok(args)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_remux_args_maps_selected_streams() {
        let args = build_remux_args("in.mkv", "out.mp4", &[0, 2], Some("+faststart"));
        assert!(args.contains(&"-map".to_string()));
        assert!(args.contains(&"0:0".to_string()));
        assert!(args.contains(&"0:2".to_string()));
        assert!(args.contains(&"+faststart".to_string()));
        assert!(args.last().unwrap() == "out.mp4");
    }

    #[test]
    fn build_encode_args_h264_with_scale_and_aac() {
        let args = build_encode_args(
            "in.mkv",
            "out.mp4",
            "h264",
            23,
            "medium",
            Some(720),
            "aac",
            Some("+faststart"),
        )
        .unwrap();
        assert!(args.contains(&"libx264".to_string()));
        assert!(args.contains(&"23".to_string()));
        assert!(args.contains(&"medium".to_string()));
        assert!(args.contains(&"scale=-2:720".to_string()));
        assert!(args.contains(&"aac".to_string()));
        assert!(args.contains(&"+faststart".to_string()));
        assert_eq!(args.last().unwrap(), "out.mp4");
    }

    #[test]
    fn build_encode_args_vp9_uses_cpu_used_and_bv0() {
        let args =
            build_encode_args("in.mp4", "out.webm", "vp9", 30, "medium", None, "opus", None)
                .unwrap();
        assert!(args.contains(&"libvpx-vp9".to_string()));
        assert!(args.contains(&"-cpu-used".to_string()));
        assert!(args.contains(&"4".to_string()));
        assert!(args.contains(&"-b:v".to_string()));
        assert!(args.contains(&"0".to_string()));
        assert!(args.contains(&"libopus".to_string()));
    }

    #[test]
    fn build_encode_args_av1_maps_preset_to_svt() {
        let args =
            build_encode_args("in.mp4", "out.mkv", "av1", 28, "fast", None, "copy", None)
                .unwrap();
        assert!(args.contains(&"libsvtav1".to_string()));
        assert!(args.contains(&"-preset".to_string()));
        assert!(args.contains(&"8".to_string()));
        assert!(args.contains(&"copy".to_string()));
    }

    #[test]
    fn build_audio_convert_args_aac_copies_video() {
        let args =
            build_audio_convert_args("in.mkv", "out.mkv", "aac", 192, Some("+faststart"))
                .unwrap();
        assert!(args.contains(&"-c:v".to_string()));
        assert!(args.contains(&"copy".to_string()));
        assert!(args.contains(&"aac".to_string()));
        assert!(args.contains(&"192k".to_string()));
        assert!(args.contains(&"+faststart".to_string()));
        assert!(!args.contains(&"libopus".to_string()));
        assert_eq!(args.last().unwrap(), "out.mkv");
    }

    #[test]
    fn build_audio_convert_args_opus() {
        let args = build_audio_convert_args("in.webm", "out.webm", "opus", 128, None).unwrap();
        assert!(args.contains(&"libopus".to_string()));
        assert!(args.contains(&"128k".to_string()));
        assert!(args.contains(&"-sn".to_string()));
        assert!(args.contains(&"-dn".to_string()));
    }

    #[test]
    fn build_audio_convert_args_rejects_bad_codec_and_bitrate() {
        let codec_err =
            build_audio_convert_args("in.mp4", "out.mp4", "mp3", 192, None).unwrap_err();
        assert!(codec_err.contains("unsupported audio codec"));
        let bitrate_err =
            build_audio_convert_args("in.mp4", "out.mp4", "aac", 0, None).unwrap_err();
        assert!(bitrate_err.contains("bitrate"));
    }

    #[test]
    fn parse_progress_ratio_from_out_time_ms() {
        let ratio = parse_progress_ratio("out_time_ms=500", 1_000_000.0).unwrap();
        assert!((ratio - 0.5).abs() < 0.01);
    }

    #[test]
    fn cancel_job_rejects_when_no_active_job() {
        let state = FfmpegState::new();
        assert!(cancel_job(&state, "job-1").is_err());
    }

    #[test]
    fn build_size_reduce_args_quality_uses_crf() {
        let args = build_size_reduce_args(
            "in.mkv",
            "out.mp4",
            "h264",
            SizeReduceRateControl::Crf(23),
            "medium",
            Some(720),
            Some("+faststart"),
        )
        .unwrap();
        assert!(args.contains(&"libx264".to_string()));
        assert!(args.contains(&"-crf".to_string()));
        assert!(args.contains(&"23".to_string()));
        assert!(!args.contains(&"-b:v".to_string()));
        assert!(args.contains(&"scale=-2:720".to_string()));
        assert!(args.contains(&"aac".to_string()));
        assert!(args.contains(&"128k".to_string()));
        assert_eq!(args.last().unwrap(), "out.mp4");
    }

    #[test]
    fn build_size_reduce_args_target_uses_abr() {
        let args = build_size_reduce_args(
            "in.mp4",
            "out.mkv",
            "h265",
            SizeReduceRateControl::Bitrate {
                video_bitrate_kbps: 800,
            },
            "medium",
            None,
            None,
        )
        .unwrap();
        assert!(args.contains(&"libx265".to_string()));
        assert!(args.contains(&"-b:v".to_string()));
        assert!(args.contains(&"800k".to_string()));
        assert!(args.contains(&"-maxrate".to_string()));
        assert!(args.contains(&"-bufsize".to_string()));
        assert!(args.contains(&"1600k".to_string()));
        assert!(!args.contains(&"-crf".to_string()));
    }

    #[test]
    fn build_size_reduce_args_rejects_unsupported_codec() {
        let err = build_size_reduce_args(
            "in.mp4",
            "out.webm",
            "vp9",
            SizeReduceRateControl::Crf(30),
            "medium",
            None,
            None,
        )
        .unwrap_err();
        assert!(err.contains("h264"));
    }

    #[test]
    fn build_size_reduce_args_rejects_low_bitrate() {
        let err = build_size_reduce_args(
            "in.mp4",
            "out.mp4",
            "h264",
            SizeReduceRateControl::Bitrate {
                video_bitrate_kbps: 50,
            },
            "medium",
            None,
            None,
        )
        .unwrap_err();
        assert!(err.contains("100"));
    }
}
