use hmac::{Hmac, Mac};
use reqwest::Client;
use serde_json::{json, Value};
use sha1::Sha1;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::music::MusicTrackPreview;

type HmacSha1 = Hmac<Sha1>;

const PATHFINDER_URL: &str = "https://api-partner.spotify.com/pathfinder/v2/query";
const GRAPHQL_PLAYLIST_HASH: &str =
    "346811f856fb0b7e4f6c59f8ebea78dd081c6e2fb01b77c954b26259d5fc6763";
const GRAPHQL_ALBUM_HASH: &str =
    "b9bfabef66ed756e5e13f68a942deb60bd4125ec1f1be8cc42769dc0259b4b10";
const PAGE_LIMIT: u32 = 100;

/// Spotify web-player TOTP secret (version 61). Rotates periodically; sourced from
/// working open-source integrations when embed-only resolution is insufficient.
const SPOTIFY_TOTP_SECRET_B32: &str =
    "GM3TMMJTGYZTQNZVGM4DINJZHA4TGOBYGMZTCMRTGEYDSMJRHE4TEOBUG4YTCMRUGQ4DQOJUGQYTAMRRGA2TCMJSHE3TCMBY";
const SPOTIFY_TOTP_VERSION: u32 = 61;

pub const EMBED_TRACK_LIST_CAP: usize = 100;

struct SpotifySession {
    access_token: String,
    client_token: String,
    client_version: String,
}

fn spotify_user_agent() -> &'static str {
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36"
}

fn decode_base32(input: &str) -> Result<Vec<u8>, String> {
    const ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut bits = 0u32;
    let mut value = 0u32;
    let mut out = Vec::new();

    for byte in input.trim_end_matches('=').bytes() {
        let ch = byte.to_ascii_uppercase();
        let index = ALPHABET
            .iter()
            .position(|&candidate| candidate == ch)
            .ok_or_else(|| format!("Invalid base32 character in Spotify TOTP secret: {ch}"))?;
        value = (value << 5) | index as u32;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push((value >> bits) as u8);
        }
    }

    Ok(out)
}

fn spotify_totp_secret() -> Result<Vec<u8>, String> {
    static SECRET: OnceLock<Result<Vec<u8>, String>> = OnceLock::new();
    SECRET
        .get_or_init(|| decode_base32(SPOTIFY_TOTP_SECRET_B32))
        .clone()
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn hotp(secret: &[u8], counter: u64) -> String {
    let mut mac =
        HmacSha1::new_from_slice(secret).expect("HMAC accepts any key length up to the block size");
    mac.update(&counter.to_be_bytes());
    let digest = mac.finalize().into_bytes();
    let offset = (digest[digest.len() - 1] & 0x0f) as usize;
    let code = ((u32::from(digest[offset] & 0x7f) << 24)
        | (u32::from(digest[offset + 1]) << 16)
        | (u32::from(digest[offset + 2]) << 8)
        | u32::from(digest[offset + 3]))
        % 1_000_000;
    format!("{code:06}")
}

fn totp(secret: &[u8], timestamp: u64) -> String {
    hotp(secret, timestamp / 30)
}

async fn fetch_web_player_bootstrap(
    client: &Client,
) -> Result<(String, Option<String>), String> {
    let response = client
        .get("https://open.spotify.com/")
        .header("User-Agent", spotify_user_agent())
        .header("Accept", "text/html")
        .send()
        .await
        .map_err(|e| format!("Spotify page request failed: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Spotify page lookup returned {}",
            response.status().as_u16()
        ));
    }

    let sp_t = response
        .cookies()
        .find(|cookie| cookie.name() == "sp_t")
        .map(|cookie| cookie.value().to_string());

    let html = response
        .text()
        .await
        .map_err(|e| format!("Failed to read Spotify page: {e}"))?;

    let config_prefix = r#"<script id="appServerConfig" type="text/plain">"#;
    let config_start = html
        .find(config_prefix)
        .ok_or_else(|| "Spotify page did not include appServerConfig".to_string())?
        + config_prefix.len();
    let config_end = html[config_start..]
        .find("</script>")
        .ok_or_else(|| "Spotify appServerConfig was malformed".to_string())?
        + config_start;
    let config_b64 = html[config_start..config_end].trim();
    let config_bytes = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        config_b64,
    )
    .map_err(|e| format!("Failed to decode Spotify appServerConfig: {e}"))?;
    let config: Value = serde_json::from_slice(&config_bytes)
        .map_err(|e| format!("Failed to parse Spotify appServerConfig: {e}"))?;
    let client_version = config
        .get("clientVersion")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Spotify appServerConfig missing clientVersion".to_string())?
        .to_string();

    Ok((client_version, sp_t))
}

async fn request_access_token(client: &Client, secret: &[u8]) -> Result<Value, String> {
    let offsets = [0i64, -30, 30];
    let mut last_error = String::from("Spotify anonymous token request failed");

    for offset in offsets {
        let client_time = unix_now() as i64 + offset;
        if client_time < 0 {
            continue;
        }
        let totp_code = totp(secret, client_time as u64);

        let mut token_url = reqwest::Url::parse("https://open.spotify.com/api/token")
            .map_err(|e| format!("Invalid Spotify token URL: {e}"))?;
        token_url
            .query_pairs_mut()
            .append_pair("reason", "init")
            .append_pair("productType", "web-player")
            .append_pair("totp", &totp_code)
            .append_pair("totpServer", &totp_code)
            .append_pair("totpVer", &SPOTIFY_TOTP_VERSION.to_string());

        let token_response = client
            .get(token_url)
            .header("User-Agent", spotify_user_agent())
            .header("Content-Type", "application/json;charset=UTF-8")
            .send()
            .await
            .map_err(|e| format!("Spotify token request failed: {e}"))?;
        let status = token_response.status();
        if status.is_success() {
            return token_response
                .json::<Value>()
                .await
                .map_err(|e| format!("Failed to parse Spotify token response: {e}"));
        }
        last_error = format!(
            "Spotify anonymous token request failed ({}): {}",
            status.as_u16(),
            token_response.text().await.unwrap_or_default().chars().take(200).collect::<String>()
        );
    }

    Err(last_error)
}

fn pathfinder_client() -> Result<Client, String> {
    Client::builder()
        .cookie_store(true)
        .user_agent(spotify_user_agent())
        .build()
        .map_err(|e| format!("Failed to create Spotify HTTP client: {e}"))
}

async fn establish_session() -> Result<(Client, SpotifySession), String> {
    let client = pathfinder_client()?;
    let secret = spotify_totp_secret()?;
    let (client_version, sp_t) = fetch_web_player_bootstrap(&client).await?;
    let token_body = request_access_token(&client, &secret).await?;
    let access_token = token_body
        .get("accessToken")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Spotify token response missing accessToken".to_string())?;
    let client_id = token_body
        .get("clientId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Spotify token response missing clientId".to_string())?;

    let device_id = sp_t.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    let client_token_response = client
        .post("https://clienttoken.spotify.com/v1/clienttoken")
        .header("User-Agent", spotify_user_agent())
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header("Origin", "https://open.spotify.com")
        .header("Referer", "https://open.spotify.com/")
        .json(&json!({
            "client_data": {
                "client_version": client_version,
                "client_id": client_id,
                "js_sdk_data": {
                    "device_brand": "unknown",
                    "device_model": "unknown",
                    "os": "windows",
                    "os_version": "NT 10.0",
                    "device_id": device_id,
                    "device_type": "computer"
                }
            }
        }))
        .send()
        .await
        .map_err(|e| format!("Spotify client-token request failed: {e}"))?;
    let client_token_status = client_token_response.status();
    if !client_token_status.is_success() {
        let body = client_token_response.text().await.unwrap_or_default();
        return Err(format!(
            "Spotify client-token request failed ({}): {}",
            client_token_status.as_u16(),
            body.chars().take(200).collect::<String>()
        ));
    }
    let client_token_body: Value = client_token_response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Spotify client-token response: {e}"))?;
    let client_token = client_token_body
        .pointer("/granted_token/token")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Spotify client-token response missing token".to_string())?;

    Ok((
        client,
        SpotifySession {
            access_token: access_token.to_string(),
            client_token: client_token.to_string(),
            client_version,
        },
    ))
}

async fn pathfinder_query(client: &Client, session: &SpotifySession, payload: Value) -> Result<Value, String> {
    let response = client
        .post(PATHFINDER_URL)
        .header("User-Agent", spotify_user_agent())
        .header("Authorization", format!("Bearer {}", session.access_token))
        .header("Client-Token", &session.client_token)
        .header("Spotify-App-Version", &session.client_version)
        .header("App-Platform", "WebPlayer")
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Spotify pathfinder request failed: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "Spotify pathfinder returned {}: {}",
            status.as_u16(),
            body.chars().take(200).collect::<String>()
        ));
    }

    response
        .json::<Value>()
        .await
        .map_err(|e| format!("Failed to parse Spotify pathfinder response: {e}"))
}

fn track_id_from_uri(uri: &str) -> Option<String> {
    uri.strip_prefix("spotify:track:")
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
}

fn artist_names_from_track_data(data: &Value) -> String {
    data.pointer("/artists/items")
        .and_then(Value::as_array)
        .map(|artists| {
            artists
                .iter()
                .filter_map(|artist| artist.pointer("/profile/name").and_then(Value::as_str))
                .filter(|name| !name.trim().is_empty())
                .collect::<Vec<_>>()
                .join(", ")
        })
        .filter(|names| !names.is_empty())
        .unwrap_or_else(|| "Unknown Artist".to_string())
}

fn track_preview_from_pathfinder_item(
    item: &Value,
    index: usize,
    collection_name: Option<&str>,
    original_url: &str,
) -> Option<MusicTrackPreview> {
    let data = item.pointer("/itemV2/data")?;
    if data.get("__typename").and_then(Value::as_str) == Some("NotFound") {
        return None;
    }
    let uri = data.get("uri").and_then(Value::as_str)?;
    let track_id = track_id_from_uri(uri)?;
    let title = data.get("name").and_then(Value::as_str)?.trim();
    if title.is_empty() {
        return None;
    }
    let artist = artist_names_from_track_data(data);
    let download_query = crate::ytdlp::build_ytsearch_query(&artist, title);
    let duration_ms = data
        .pointer("/trackDuration/totalMilliseconds")
        .or_else(|| data.pointer("/duration/totalMilliseconds"))
        .and_then(Value::as_u64);
    let uid = item
        .get("uid")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("{track_id}-{index}"));

    Some(MusicTrackPreview {
        id: uid,
        title: title.to_string(),
        artist,
        album: collection_name.map(str::to_string),
        duration_secs: duration_ms.map(|ms| ms as f64 / 1000.0),
        thumbnail_url: None,
        source: "spotify".to_string(),
        download_query,
        original_url: Some(original_url.to_string()),
    })
}

fn track_preview_from_album_item(
    item: &Value,
    index: usize,
    collection_name: Option<&str>,
    original_url: &str,
) -> Option<MusicTrackPreview> {
    let track = item.get("track")?;
    let uri = track.get("uri").and_then(Value::as_str)?;
    let track_id = track_id_from_uri(uri)?;
    let title = track.get("name").and_then(Value::as_str)?.trim();
    if title.is_empty() {
        return None;
    }
    let artist = track
        .pointer("/artists/items")
        .and_then(Value::as_array)
        .map(|artists| {
            artists
                .iter()
                .filter_map(|artist| artist.pointer("/profile/name").and_then(Value::as_str))
                .filter(|name| !name.trim().is_empty())
                .collect::<Vec<_>>()
                .join(", ")
        })
        .filter(|names| !names.is_empty())
        .unwrap_or_else(|| "Unknown Artist".to_string());
    let duration_ms = track
        .pointer("/duration/totalMilliseconds")
        .and_then(Value::as_u64);
    let uid = item
        .get("uid")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("{track_id}-{index}"));

    Some(MusicTrackPreview {
        id: uid,
        title: title.to_string(),
        artist: artist.clone(),
        album: collection_name.map(str::to_string),
        duration_secs: duration_ms.map(|ms| ms as f64 / 1000.0),
        thumbnail_url: None,
        source: "spotify".to_string(),
        download_query: crate::ytdlp::build_ytsearch_query(&artist, title),
        original_url: Some(original_url.to_string()),
    })
}

pub async fn fetch_playlist_tracks(
    _client: &Client,
    playlist_id: &str,
) -> Result<(Option<String>, Vec<MusicTrackPreview>, Option<u32>), String> {
    let (client, session) = establish_session().await?;
    let original_url = format!("https://open.spotify.com/playlist/{playlist_id}");
    let mut tracks = Vec::new();
    let mut offset = 0u32;
    let mut playlist_name: Option<String> = None;
    let mut total_count: Option<u32> = None;

    loop {
        let payload = json!({
            "extensions": {
                "persistedQuery": {
                    "sha256Hash": GRAPHQL_PLAYLIST_HASH,
                    "version": 1
                }
            },
            "operationName": "fetchPlaylist",
            "variables": {
                "uri": format!("spotify:playlist:{playlist_id}"),
                "offset": offset,
                "limit": PAGE_LIMIT,
                "enableWatchFeedEntrypoint": true
            }
        });
        let response = pathfinder_query(&client, &session, payload).await?;
        let playlist = response
            .pointer("/data/playlistV2")
            .ok_or_else(|| "Spotify pathfinder playlist response was missing data".to_string())?;
        if playlist_name.is_none() {
            playlist_name = playlist
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        let content = playlist
            .get("content")
            .ok_or_else(|| "Spotify pathfinder playlist response was missing content".to_string())?;
        if total_count.is_none() {
            total_count = content.get("totalCount").and_then(Value::as_u64).map(|n| n as u32);
        }
        let items = content
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if items.is_empty() {
            break;
        }

        let start_index = tracks.len();
        for (index, item) in items.iter().enumerate() {
            if item.pointer("/itemV2/__typename").and_then(Value::as_str) != Some("TrackResponseWrapper") {
                continue;
            }
            if let Some(track) = track_preview_from_pathfinder_item(
                item,
                start_index + index,
                playlist_name.as_deref(),
                &original_url,
            ) {
                tracks.push(track);
            }
        }

        offset += PAGE_LIMIT;
        if (items.len() as u32) < PAGE_LIMIT {
            break;
        }
        if let Some(total) = total_count {
            if offset >= total {
                break;
            }
        }
    }

    if tracks.is_empty() {
        return Err("Spotify pathfinder playlist resolved to zero tracks".to_string());
    }

    Ok((playlist_name, tracks, total_count))
}

pub async fn fetch_album_tracks(
    _client: &Client,
    album_id: &str,
) -> Result<(Option<String>, Vec<MusicTrackPreview>, Option<u32>), String> {
    let (client, session) = establish_session().await?;
    let original_url = format!("https://open.spotify.com/album/{album_id}");
    let mut tracks = Vec::new();
    let mut offset = 0u32;
    let mut album_name: Option<String> = None;
    let mut total_count: Option<u32> = None;

    loop {
        let payload = json!({
            "extensions": {
                "persistedQuery": {
                    "sha256Hash": GRAPHQL_ALBUM_HASH,
                    "version": 1
                }
            },
            "operationName": "getAlbum",
            "variables": {
                "uri": format!("spotify:album:{album_id}"),
                "offset": offset,
                "limit": PAGE_LIMIT
            }
        });
        let response = pathfinder_query(&client, &session, payload).await?;
        let album = response
            .pointer("/data/albumUnion")
            .ok_or_else(|| "Spotify pathfinder album response was missing data".to_string())?;
        if album_name.is_none() {
            album_name = album
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        let tracks_v2 = album
            .get("tracksV2")
            .ok_or_else(|| "Spotify pathfinder album response was missing tracks".to_string())?;
        if total_count.is_none() {
            total_count = tracks_v2.get("totalCount").and_then(Value::as_u64).map(|n| n as u32);
        }
        let items = tracks_v2
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if items.is_empty() {
            break;
        }

        let start_index = tracks.len();
        for (index, item) in items.iter().enumerate() {
            if let Some(track) = track_preview_from_album_item(
                item,
                start_index + index,
                album_name.as_deref(),
                &original_url,
            ) {
                tracks.push(track);
            }
        }

        offset += PAGE_LIMIT;
        if (items.len() as u32) < PAGE_LIMIT {
            break;
        }
        if let Some(total) = total_count {
            if offset >= total {
                break;
            }
        }
    }

    if tracks.is_empty() {
        return Err("Spotify pathfinder album resolved to zero tracks".to_string());
    }

    Ok((album_name, tracks, total_count))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_spotify_totp_secret() {
        let secret = spotify_totp_secret().expect("secret");
        assert!(!secret.is_empty());
        assert!(secret.iter().all(|byte| byte.is_ascii_digit()));
    }

    #[test]
    fn generates_six_digit_totp_codes() {
        let secret = spotify_totp_secret().expect("secret");
        let code = totp(&secret, unix_now());
        assert_eq!(code.len(), 6);
        assert!(code.chars().all(|ch| ch.is_ascii_digit()));
    }
}
