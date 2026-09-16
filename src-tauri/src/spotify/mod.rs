use regex::Regex;
use reqwest::Client;
use serde::Deserialize;
use std::sync::OnceLock;

mod pathfinder;

use crate::music::MusicTrackPreview;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpotifyResource {
    Track(String),
    Album(String),
    Playlist(String),
}

#[derive(Debug, Deserialize)]
struct OEmbedResponse {
    thumbnail_url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EmbedNextData {
    props: EmbedNextProps,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EmbedNextProps {
    page_props: EmbedPageProps,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EmbedPageProps {
    state: EmbedPageState,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EmbedPageState {
    data: EmbedPageData,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EmbedPageData {
    entity: EmbedEntity,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EmbedEntity {
    name: Option<String>,
    title: Option<String>,
    artists: Option<Vec<SpotifyArtist>>,
    duration: Option<u64>,
    visual_identity: Option<EmbedVisualIdentity>,
    track_list: Option<Vec<EmbedTrackListItem>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EmbedTrackListItem {
    uri: Option<String>,
    uid: Option<String>,
    title: Option<String>,
    subtitle: Option<String>,
    duration: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EmbedVisualIdentity {
    image: Option<Vec<EmbedImage>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EmbedImage {
    url: String,
    max_width: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
}

#[derive(Debug, Deserialize)]
struct SpotifyArtist {
    name: String,
}

#[derive(Debug, Deserialize)]
struct SpotifyTrackRef {
    id: String,
    name: String,
    duration_ms: Option<u64>,
    artists: Vec<SpotifyArtist>,
    album: Option<SpotifyAlbumRef>,
}

#[derive(Debug, Deserialize)]
struct SpotifyAlbumRef {
    name: String,
}

#[derive(Debug, Deserialize)]
struct SpotifyAlbumResponse {
    name: String,
    tracks: SpotifyTrackList,
}

#[derive(Debug, Deserialize)]
struct SpotifyTrackList {
    items: Vec<SpotifyTrackRef>,
}

#[derive(Debug, Deserialize)]
struct SpotifyPlaylistItem {
    item: Option<SpotifyTrackRef>,
    track: Option<SpotifyTrackRef>,
}

#[derive(Debug, Deserialize)]
struct SpotifyPlaylistItems {
    items: Vec<SpotifyPlaylistItem>,
    next: Option<String>,
}

fn spotify_id_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)open\.spotify\.com/(?:intl-[a-z]{2}/)?(track|album|playlist)/([a-zA-Z0-9]+)",
        )
        .expect("spotify id regex")
    })
}

pub fn parse_spotify_url(url: &str) -> Option<(SpotifyResource, String)> {
    let trimmed = url.trim();
    spotify_id_regex().captures(trimmed).map(|caps| {
        let kind = caps.get(1).map(|m| m.as_str().to_ascii_lowercase());
        let id = caps.get(2).map(|m| m.as_str().to_string()).unwrap_or_default();
        let resource = match kind.as_deref() {
            Some("album") => SpotifyResource::Album(id.clone()),
            Some("playlist") => SpotifyResource::Playlist(id.clone()),
            _ => SpotifyResource::Track(id.clone()),
        };
        (resource, trimmed.to_string())
    })
}

fn track_preview(
    id: &str,
    title: String,
    artist: String,
    album: Option<String>,
    duration_secs: Option<f64>,
    thumbnail_url: Option<String>,
    original_url: Option<String>,
) -> MusicTrackPreview {
    MusicTrackPreview {
        id: id.to_string(),
        title: title.clone(),
        artist: artist.clone(),
        album,
        duration_secs,
        thumbnail_url,
        source: "spotify".to_string(),
        download_query: crate::ytdlp::build_ytsearch_query(&artist, &title),
        original_url,
    }
}

async fn fetch_oembed(client: &Client, url: &str) -> Result<OEmbedResponse, String> {
    let response = client
        .get("https://open.spotify.com/oembed")
        .query(&[("url", url)])
        .send()
        .await
        .map_err(|e| format!("Spotify oEmbed request failed: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Spotify oEmbed returned {}",
            response.status().as_u16()
        ));
    }

    response
        .json::<OEmbedResponse>()
        .await
        .map_err(|e| format!("Failed to parse Spotify oEmbed response: {e}"))
}

fn spotify_user_agent() -> &'static str {
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
}

fn extract_next_data_json(html: &str) -> Result<&str, String> {
    const PREFIX: &str = r#"<script id="__NEXT_DATA__" type="application/json">"#;
    const SUFFIX: &str = "</script>";

    let start = html
        .find(PREFIX)
        .ok_or_else(|| "Spotify embed page did not include metadata".to_string())?
        + PREFIX.len();
    let rest = &html[start..];
    let end = rest
        .find(SUFFIX)
        .ok_or_else(|| "Spotify embed metadata was malformed".to_string())?;
    Ok(&rest[..end])
}

fn best_embed_thumbnail(entity: &EmbedEntity) -> Option<String> {
    entity
        .visual_identity
        .as_ref()
        .and_then(|visual| visual.image.as_ref())
        .and_then(|images| {
            images
                .iter()
                .max_by_key(|image| image.max_width.unwrap_or(0))
                .map(|image| image.url.clone())
        })
}

fn entity_title(entity: &EmbedEntity) -> Option<String> {
    entity
        .title
        .clone()
        .or_else(|| entity.name.clone())
        .filter(|value| !value.trim().is_empty())
}

fn entity_artists(entity: &EmbedEntity) -> String {
    entity
        .artists
        .as_ref()
        .and_then(|artists| artists.first())
        .map(|artist| artist.name.clone())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "Unknown Artist".to_string())
}

fn entity_duration_secs(entity: &EmbedEntity) -> Option<f64> {
    entity.duration.map(|ms| ms as f64 / 1000.0)
}

async fn fetch_embed_entity(client: &Client, kind: &str, id: &str) -> Result<EmbedEntity, String> {
    let url = format!("https://open.spotify.com/embed/{kind}/{id}");
    let response = client
        .get(url)
        .header("User-Agent", spotify_user_agent())
        .send()
        .await
        .map_err(|e| format!("Spotify embed request failed: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Spotify embed lookup returned {}",
            response.status().as_u16()
        ));
    }

    let html = response
        .text()
        .await
        .map_err(|e| format!("Failed to read Spotify embed page: {e}"))?;
    let json = extract_next_data_json(&html)?;
    let parsed: EmbedNextData = serde_json::from_str(json)
        .map_err(|e| format!("Failed to parse Spotify embed metadata: {e}"))?;
    Ok(parsed.props.page_props.state.data.entity)
}

async fn resolve_track_without_api(
    client: &Client,
    track_id: &str,
    canonical_url: &str,
) -> Result<MusicTrackPreview, String> {
    let entity = fetch_embed_entity(client, "track", track_id).await?;
    let title = entity_title(&entity)
        .ok_or_else(|| "Spotify track title unavailable".to_string())?;
    let artist = entity_artists(&entity);
    let mut thumbnail = best_embed_thumbnail(&entity);
    if thumbnail.is_none() {
        thumbnail = fetch_oembed(client, canonical_url)
            .await
            .ok()
            .and_then(|oembed| oembed.thumbnail_url);
    }

    Ok(track_preview(
        track_id,
        title,
        artist,
        None,
        entity_duration_secs(&entity),
        thumbnail,
        Some(canonical_url.to_string()),
    ))
}

fn parse_track_id_from_uri(uri: &str) -> Option<String> {
    uri.strip_prefix("spotify:track:")
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
}

fn collection_title(entity: &EmbedEntity) -> Option<String> {
    entity_title(entity)
}

fn track_preview_from_embed_item(
    item: &EmbedTrackListItem,
    index: usize,
    collection_name: Option<&str>,
    original_url: &str,
) -> Option<MusicTrackPreview> {
    let uri = item.uri.as_deref()?;
    let track_id = parse_track_id_from_uri(uri)?;
    let title = item
        .title
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())?
        .to_string();
    let artist = item
        .subtitle
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| "Unknown Artist".to_string());
    let id = item
        .uid
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("{track_id}-{index}"));

    Some(track_preview(
        &id,
        title,
        artist,
        collection_name.map(str::to_string),
        item.duration.map(|ms| ms as f64 / 1000.0),
        None,
        Some(original_url.to_string()),
    ))
}

fn tracks_from_embed_entity(
    entity: &EmbedEntity,
    original_url: &str,
) -> Result<Vec<MusicTrackPreview>, String> {
    let collection_name = collection_title(entity);
    let items = entity
        .track_list
        .as_ref()
        .filter(|list| !list.is_empty())
        .ok_or_else(|| "Spotify embed did not include a track list".to_string())?;

    let tracks = items
        .iter()
        .enumerate()
        .filter_map(|(index, item)| {
            track_preview_from_embed_item(item, index, collection_name.as_deref(), original_url)
        })
        .collect::<Vec<_>>();

    if tracks.is_empty() {
        return Err(
            "Spotify embed track list had no playable tracks".to_string(),
        );
    }

    Ok(tracks)
}

async fn resolve_playlist_without_api(
    client: &Client,
    playlist_id: &str,
) -> Result<(Option<String>, Vec<MusicTrackPreview>), String> {
    let entity = fetch_embed_entity(client, "playlist", playlist_id).await?;
    let original_url = format!("https://open.spotify.com/playlist/{playlist_id}");
    let title = collection_title(&entity).unwrap_or_else(|| "Spotify playlist".to_string());
    let tracks = tracks_from_embed_entity(&entity, &original_url)?;
    Ok((Some(title), tracks))
}

async fn resolve_album_without_api(
    client: &Client,
    album_id: &str,
) -> Result<(Option<String>, Vec<MusicTrackPreview>), String> {
    let entity = fetch_embed_entity(client, "album", album_id).await?;
    let original_url = format!("https://open.spotify.com/album/{album_id}");
    let title = collection_title(&entity).unwrap_or_else(|| "Spotify album".to_string());
    let tracks = tracks_from_embed_entity(&entity, &original_url)?;
    Ok((Some(title), tracks))
}

async fn expand_truncated_collection(
    client: &Client,
    kind: &str,
    collection_id: &str,
    embed_title: Option<String>,
    embed_tracks: Vec<MusicTrackPreview>,
    client_id: Option<&str>,
    client_secret: Option<&str>,
) -> (Option<String>, Vec<MusicTrackPreview>, Option<String>) {
    if embed_tracks.len() < pathfinder::EMBED_TRACK_LIST_CAP {
        return (embed_title, embed_tracks, None);
    }

    let pathfinder_result = match kind {
        "playlist" => pathfinder::fetch_playlist_tracks(client, collection_id).await,
        "album" => pathfinder::fetch_album_tracks(client, collection_id).await,
        _ => return (embed_title, embed_tracks, None),
    };

    if let Ok((title, tracks, total_count)) = pathfinder_result {
        if tracks.len() > embed_tracks.len() {
            return (title.or(embed_title), tracks, None);
        }
        if total_count.is_some_and(|total| total as usize == tracks.len()) {
            return (title.or(embed_title), tracks, None);
        }
    }

    if has_spotify_credentials(client_id, client_secret) {
        if let Ok((app_id, app_secret)) = require_credentials(client_id, client_secret) {
            if let Ok(token) = fetch_access_token(client, app_id, app_secret).await {
                match kind {
                    "playlist" => {
                        if let Ok(tracks) =
                            fetch_playlist_tracks(client, &token, collection_id).await
                        {
                            if tracks.len() > embed_tracks.len() {
                                return (embed_title, tracks, None);
                            }
                        }
                    }
                    "album" => {
                        if let Ok((album_name, tracks)) =
                            fetch_album_tracks(client, &token, collection_id).await
                        {
                            if tracks.len() > embed_tracks.len() {
                                return (Some(album_name), tracks, None);
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    let notice = format!(
        "Loaded the first {} tracks from Spotify's embed page. SAK could not fetch the full playlist via Spotify's web-player lookup. {} track(s) shown.",
        pathfinder::EMBED_TRACK_LIST_CAP,
        embed_tracks.len()
    );
    (embed_title, embed_tracks, Some(notice))
}

fn has_spotify_credentials(client_id: Option<&str>, client_secret: Option<&str>) -> bool {
    matches!(
        (client_id, client_secret),
        (Some(id), Some(secret)) if !id.trim().is_empty() && !secret.trim().is_empty()
    )
}

fn non_empty_option(value: Option<String>) -> Option<String> {
    value
        .map(|raw| raw.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn non_empty_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|raw| raw.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub fn resolve_spotify_credentials(
    client_id: Option<String>,
    client_secret: Option<String>,
) -> (Option<String>, Option<String>) {
    let id = non_empty_option(client_id).or_else(|| non_empty_env("SPOTIFY_CLIENT_ID"));
    let secret =
        non_empty_option(client_secret).or_else(|| non_empty_env("SPOTIFY_CLIENT_SECRET"));
    (id, secret)
}

async fn fetch_access_token(
    client: &Client,
    client_id: &str,
    client_secret: &str,
) -> Result<String, String> {
    let response = client
        .post("https://accounts.spotify.com/api/token")
        .basic_auth(client_id, Some(client_secret))
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body("grant_type=client_credentials")
        .send()
        .await
        .map_err(|e| format!("Spotify token request failed: {e}"))?;

    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "Spotify authentication failed (check Client ID / Secret): {body}"
        ));
    }

    response
        .json::<TokenResponse>()
        .await
        .map(|token| token.access_token)
        .map_err(|e| format!("Failed to parse Spotify token response: {e}"))
}

async fn fetch_track_api(
    client: &Client,
    token: &str,
    track_id: &str,
) -> Result<SpotifyTrackRef, String> {
    let url = format!("https://api.spotify.com/v1/tracks/{track_id}");
    let response = client
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("Spotify track request failed: {e}"))?;

    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Spotify track lookup failed: {body}"));
    }

    response
        .json::<SpotifyTrackRef>()
        .await
        .map_err(|e| format!("Failed to parse Spotify track response: {e}"))
}

fn track_from_api(track: SpotifyTrackRef, original_url: Option<String>) -> MusicTrackPreview {
    let artist = track
        .artists
        .first()
        .map(|a| a.name.clone())
        .unwrap_or_else(|| "Unknown Artist".to_string());
    track_preview(
        &track.id,
        track.name,
        artist,
        track.album.map(|a| a.name),
        track.duration_ms.map(|ms| ms as f64 / 1000.0),
        None,
        original_url,
    )
}

async fn fetch_album_tracks(
    client: &Client,
    token: &str,
    album_id: &str,
) -> Result<(String, Vec<MusicTrackPreview>), String> {
    let url = format!("https://api.spotify.com/v1/albums/{album_id}");
    let response = client
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("Spotify album request failed: {e}"))?;

    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Spotify album lookup failed: {body}"));
    }

    let album = response
        .json::<SpotifyAlbumResponse>()
        .await
        .map_err(|e| format!("Failed to parse Spotify album response: {e}"))?;

    let tracks: Vec<MusicTrackPreview> = album
        .tracks
        .items
        .into_iter()
        .map(|track| {
            track_from_api(
                track,
                Some(format!("https://open.spotify.com/album/{album_id}")),
            )
        })
        .collect();

    Ok((album.name, tracks))
}

async fn fetch_playlist_page(
    client: &Client,
    token: &str,
    playlist_id: &str,
    offset: u32,
) -> Result<SpotifyPlaylistItems, String> {
    let url = format!("https://api.spotify.com/v1/playlists/{playlist_id}/items");
    let response = client
        .get(url)
        .bearer_auth(token)
        .query(&[("limit", "100"), ("offset", &offset.to_string())])
        .send()
        .await
        .map_err(|e| format!("Spotify playlist request failed: {e}"))?;

    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "Spotify playlist lookup failed. Public playlists may require your own Spotify app credentials, and some playlists are no longer accessible via the API: {body}"
        ));
    }

    response
        .json::<SpotifyPlaylistItems>()
        .await
        .map_err(|e| format!("Failed to parse Spotify playlist response: {e}"))
}

async fn fetch_playlist_tracks(
    client: &Client,
    token: &str,
    playlist_id: &str,
) -> Result<Vec<MusicTrackPreview>, String> {
    let mut tracks = Vec::new();
    let mut offset = 0u32;
    let original_url = format!("https://open.spotify.com/playlist/{playlist_id}");

    loop {
        let page = fetch_playlist_page(client, token, playlist_id, offset).await?;
        if page.items.is_empty() {
            break;
        }

        for entry in page.items {
            let track = entry.item.or(entry.track);
            let Some(track) = track else {
                continue;
            };
            if track.id.is_empty() {
                continue;
            }
            tracks.push(track_from_api(track, Some(original_url.clone())));
        }

        if page.next.is_none() {
            break;
        }
        offset += 100;
    }

    if tracks.is_empty() {
        return Err(
            "Playlist resolved to zero downloadable tracks. It may be empty, region-locked, or unavailable via the Spotify API.".to_string(),
        );
    }

    Ok(tracks)
}

pub async fn resolve_spotify_url(
    url: &str,
    client_id: Option<&str>,
    client_secret: Option<&str>,
) -> Result<(Option<String>, Vec<MusicTrackPreview>, Option<String>), String> {
    let (resource, canonical_url) =
        parse_spotify_url(url).ok_or_else(|| "Not a supported Spotify URL".to_string())?;

    let client = Client::builder()
        .user_agent("SAK/0.1 (personal music downloader)")
        .build()
        .map_err(|e| e.to_string())?;

    match resource {
        SpotifyResource::Track(track_id) => {
            if let (Some(id), Some(secret)) = (client_id, client_secret) {
                if !id.trim().is_empty() && !secret.trim().is_empty() {
                    let token = fetch_access_token(&client, id.trim(), secret.trim()).await?;
                    let track = fetch_track_api(&client, &token, &track_id).await?;
                    let preview = track_from_api(track, Some(canonical_url));
                    return Ok((Some(preview.title.clone()), vec![preview], None));
                }
            }

            let preview = resolve_track_without_api(&client, &track_id, &canonical_url).await?;
            Ok((Some(preview.title.clone()), vec![preview], None))
        }
        SpotifyResource::Album(album_id) => {
            match resolve_album_without_api(&client, &album_id).await {
                Ok((title, tracks)) => {
                    let (title, tracks, notice) = expand_truncated_collection(
                        &client,
                        "album",
                        &album_id,
                        title,
                        tracks,
                        client_id,
                        client_secret,
                    )
                    .await;
                    return Ok((title, tracks, notice));
                }
                Err(embed_err) => {
                    if let Ok((title, tracks, _)) =
                        pathfinder::fetch_album_tracks(&client, &album_id).await
                    {
                        return Ok((title, tracks, None));
                    }
                    if !has_spotify_credentials(client_id, client_secret) {
                        return Err(embed_err);
                    }
                    let (id, secret) = require_credentials(client_id, client_secret)?;
                    let token = fetch_access_token(&client, id, secret).await?;
                    let (album_name, tracks) =
                        fetch_album_tracks(&client, &token, &album_id).await?;
                    return Ok((Some(album_name), tracks, None));
                }
            }
        }
        SpotifyResource::Playlist(playlist_id) => {
            match resolve_playlist_without_api(&client, &playlist_id).await {
                Ok((title, tracks)) => {
                    let (title, tracks, notice) = expand_truncated_collection(
                        &client,
                        "playlist",
                        &playlist_id,
                        title,
                        tracks,
                        client_id,
                        client_secret,
                    )
                    .await;
                    return Ok((title, tracks, notice));
                }
                Err(embed_err) => {
                    if let Ok((title, tracks, _)) =
                        pathfinder::fetch_playlist_tracks(&client, &playlist_id).await
                    {
                        return Ok((title, tracks, None));
                    }
                    if !has_spotify_credentials(client_id, client_secret) {
                        return Err(embed_err);
                    }
                    let (id, secret) = require_credentials(client_id, client_secret)?;
                    let token = fetch_access_token(&client, id, secret).await?;
                    let tracks = fetch_playlist_tracks(&client, &token, &playlist_id).await?;
                    return Ok((
                        Some(format!("Spotify playlist ({})", tracks.len())),
                        tracks,
                        None,
                    ));
                }
            }
        }
    }
}

fn require_credentials<'a>(
    client_id: Option<&'a str>,
    client_secret: Option<&'a str>,
) -> Result<(&'a str, &'a str), String> {
    match (client_id, client_secret) {
        (Some(id), Some(secret)) if !id.trim().is_empty() && !secret.trim().is_empty() => {
            Ok((id.trim(), secret.trim()))
        }
        _ => Err(
            "Optional Spotify API credentials were not provided. Albums and playlists usually resolve from Spotify's embed page; add Client ID / Secret only if embed lookup fails.".to_string(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_spotify_track_url() {
        let parsed = parse_spotify_url("https://open.spotify.com/track/abc123?utm_source=copy");
        assert!(matches!(
            parsed,
            Some((SpotifyResource::Track(id), _)) if id == "abc123"
        ));
    }

    #[test]
    fn parses_spotify_intl_track_url() {
        let parsed = parse_spotify_url("https://open.spotify.com/intl-de/track/abc123");
        assert!(matches!(
            parsed,
            Some((SpotifyResource::Track(id), _)) if id == "abc123"
        ));
    }

    #[test]
    fn resolve_spotify_credentials_prefers_ui_over_env() {
        let previous_id = std::env::var("SPOTIFY_CLIENT_ID").ok();
        let previous_secret = std::env::var("SPOTIFY_CLIENT_SECRET").ok();
        std::env::set_var("SPOTIFY_CLIENT_ID", "from-env-id");
        std::env::set_var("SPOTIFY_CLIENT_SECRET", "from-env-secret");

        let (id, secret) = resolve_spotify_credentials(
            Some("from-ui-id".to_string()),
            Some("from-ui-secret".to_string()),
        );
        assert_eq!(id.as_deref(), Some("from-ui-id"));
        assert_eq!(secret.as_deref(), Some("from-ui-secret"));

        let (id, secret) = resolve_spotify_credentials(None, None);
        assert_eq!(id.as_deref(), Some("from-env-id"));
        assert_eq!(secret.as_deref(), Some("from-env-secret"));

        match previous_id {
            Some(value) => std::env::set_var("SPOTIFY_CLIENT_ID", value),
            None => std::env::remove_var("SPOTIFY_CLIENT_ID"),
        }
        match previous_secret {
            Some(value) => std::env::set_var("SPOTIFY_CLIENT_SECRET", value),
            None => std::env::remove_var("SPOTIFY_CLIENT_SECRET"),
        }
    }

    #[test]
    fn parses_embed_entity_artists() {
        let json = r#"{"props":{"pageProps":{"state":{"data":{"entity":{"type":"track","title":"Joost Klein","id":"abc","artists":[{"name":"Joost"}],"duration":116951}}}}}}"#;
        let parsed: EmbedNextData = serde_json::from_str(json).expect("embed json");
        let entity = parsed.props.page_props.state.data.entity;
        assert_eq!(entity_title(&entity).as_deref(), Some("Joost Klein"));
        assert_eq!(entity_artists(&entity), "Joost");
        assert_eq!(entity_duration_secs(&entity), Some(116.951));
    }

    #[test]
    fn parses_embed_playlist_track_list() {
        let json = r#"{"props":{"pageProps":{"state":{"data":{"entity":{"type":"playlist","name":"Test List","trackList":[{"uri":"spotify:track:abc123","uid":"uid1","title":"Song One","subtitle":"Artist A","duration":191703},{"uri":"spotify:track:def456","uid":"uid2","title":"Song Two","subtitle":"Artist B, Artist C","duration":120000}]}}}}}}"#;
        let parsed: EmbedNextData = serde_json::from_str(json).expect("embed json");
        let entity = parsed.props.page_props.state.data.entity;
        let tracks = tracks_from_embed_entity(&entity, "https://open.spotify.com/playlist/test")
            .expect("tracks");
        assert_eq!(tracks.len(), 2);
        assert_eq!(tracks[0].title, "Song One");
        assert_eq!(tracks[0].artist, "Artist A");
        assert_eq!(tracks[0].duration_secs, Some(191.703));
        assert_eq!(tracks[0].download_query, "ytsearch15:Artist A Song One topic");
    }
}
