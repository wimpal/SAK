use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::spotify;
use crate::ytdlp::{self, YtdlpState};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicTrackPreview {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub duration_secs: Option<f64>,
    pub thumbnail_url: Option<String>,
    pub source: String,
    pub download_query: String,
    pub original_url: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicResolveResult {
    pub platform: String,
    pub title: Option<String>,
    pub tracks: Vec<MusicTrackPreview>,
    pub notice: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicDownloadItem {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub download_query: String,
    pub output_stem: Option<String>,
    pub duration_secs: Option<f64>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicDownloadResult {
    pub id: String,
    pub path: String,
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicDownloadJobResult {
    pub ok: bool,
    pub error: Option<String>,
    pub results: Vec<MusicDownloadResult>,
}

pub async fn resolve_music_url(
    app: &AppHandle,
    url: String,
    spotify_client_id: Option<String>,
    spotify_client_secret: Option<String>,
) -> Result<MusicResolveResult, String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("paste a YouTube or Spotify URL".to_string());
    }

    if ytdlp::is_youtube_url(trimmed) {
        return ytdlp::resolve_youtube_url(app, trimmed).await;
    }

    if spotify::parse_spotify_url(trimmed).is_some() {
        let (client_id, client_secret) =
            spotify::resolve_spotify_credentials(spotify_client_id, spotify_client_secret);
        let (title, tracks, notice) = spotify::resolve_spotify_url(
            trimmed,
            client_id.as_deref(),
            client_secret.as_deref(),
        )
        .await?;
        return Ok(MusicResolveResult {
            platform: "spotify".to_string(),
            title,
            tracks,
            notice,
        });
    }

    Err("Unsupported URL. Paste a YouTube / YouTube Music or Spotify track, album, or playlist link.".to_string())
}

pub async fn run_music_download(
    app: &AppHandle,
    state: &YtdlpState,
    job_id: String,
    output_dir: String,
    items: Vec<MusicDownloadItem>,
    audio_quality_kbps: u32,
) -> Result<MusicDownloadJobResult, String> {
    let (ok, error, results) = ytdlp::run_music_download_job(
        app,
        state,
        job_id.clone(),
        output_dir,
        items,
        audio_quality_kbps,
    )
    .await?;

    ytdlp::emit_music_done(app, job_id, ok, error.clone(), results.clone());

    Ok(MusicDownloadJobResult {
        ok,
        error,
        results,
    })
}
