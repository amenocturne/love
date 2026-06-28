use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::extract::{Path as AxumPath, Query, Request, State};
use axum::http::{self, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use tower::ServiceExt;
use tower_http::services::ServeFile;

use crate::AppState;
use crate::cover;
use crate::search;
use crate::transcode;

#[derive(Debug)]
pub enum ApiError {
    PathTraversal,
    NotFound,
    Io(std::io::Error),
    Transcode(transcode::TranscodeError),
    Cover(cover::CoverError),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, msg) = match &self {
            Self::PathTraversal => (StatusCode::FORBIDDEN, "path traversal denied"),
            Self::NotFound => (StatusCode::NOT_FOUND, "not found"),
            Self::Io(e) => {
                tracing::error!("io error: {e}");
                (StatusCode::INTERNAL_SERVER_ERROR, "io error")
            }
            Self::Transcode(e) => {
                tracing::error!("transcode error: {e:?}");
                (StatusCode::INTERNAL_SERVER_ERROR, "transcode failed")
            }
            Self::Cover(e) => {
                tracing::error!("cover error: {e:?}");
                (StatusCode::INTERNAL_SERVER_ERROR, "cover extraction failed")
            }
        };
        (status, msg).into_response()
    }
}

impl From<std::io::Error> for ApiError {
    fn from(e: std::io::Error) -> Self {
        if e.kind() == std::io::ErrorKind::NotFound {
            Self::NotFound
        } else {
            Self::Io(e)
        }
    }
}

impl From<transcode::TranscodeError> for ApiError {
    fn from(e: transcode::TranscodeError) -> Self {
        Self::Transcode(e)
    }
}

impl From<cover::CoverError> for ApiError {
    fn from(e: cover::CoverError) -> Self {
        Self::Cover(e)
    }
}

const AUDIO_EXTENSIONS: &[&str] = &[
    "mp3", "flac", "wav", "ogg", "opus", "m4a", "aac", "wma", "ape",
];

fn is_audio_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| AUDIO_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

fn resolve_safe_path(music_dir: &Path, relative: &str) -> Result<PathBuf, ApiError> {
    let decoded = percent_encoding::percent_decode_str(relative).decode_utf8_lossy();
    let joined = music_dir.join(decoded.as_ref());
    let canonical = joined.canonicalize().map_err(|_| ApiError::NotFound)?;
    let music_canonical = music_dir.canonicalize().map_err(|_| ApiError::NotFound)?;
    if !canonical.starts_with(&music_canonical) {
        return Err(ApiError::PathTraversal);
    }
    Ok(canonical)
}

fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let mut ai = a.chars().peekable();
    let mut bi = b.chars().peekable();

    loop {
        match (ai.peek(), bi.peek()) {
            (None, None) => return std::cmp::Ordering::Equal,
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (Some(_), None) => return std::cmp::Ordering::Greater,
            (Some(ac), Some(bc)) => {
                if ac.is_ascii_digit() && bc.is_ascii_digit() {
                    let na = take_number(&mut ai);
                    let nb = take_number(&mut bi);
                    match na.cmp(&nb) {
                        std::cmp::Ordering::Equal => continue,
                        ord => return ord,
                    }
                }
                let al = ac.to_lowercase().next().unwrap_or(*ac);
                let bl = bc.to_lowercase().next().unwrap_or(*bc);
                match al.cmp(&bl) {
                    std::cmp::Ordering::Equal => {
                        ai.next();
                        bi.next();
                    }
                    ord => return ord,
                }
            }
        }
    }
}

fn take_number(chars: &mut std::iter::Peekable<std::str::Chars>) -> u64 {
    let mut n: u64 = 0;
    while let Some(c) = chars.peek() {
        if c.is_ascii_digit() {
            n = n.saturating_mul(10).saturating_add((*c as u64) - ('0' as u64));
            chars.next();
        } else {
            break;
        }
    }
    n
}

#[derive(Deserialize)]
pub struct BrowseParams {
    path: Option<String>,
}

#[derive(Serialize)]
pub struct BrowseResponse {
    entries: Vec<BrowseEntry>,
}

#[derive(Serialize)]
pub struct BrowseEntry {
    name: String,
    kind: &'static str,
    path: String,
}

pub async fn browse(
    Query(params): Query<BrowseParams>,
    State(state): State<Arc<AppState>>,
) -> Result<axum::Json<BrowseResponse>, ApiError> {
    let music_canonical = state.music_dir.canonicalize()?;
    let dir = match &params.path {
        Some(p) if !p.is_empty() => resolve_safe_path(&state.music_dir, p)?,
        _ => music_canonical.clone(),
    };

    let mut entries = Vec::new();
    let mut read_dir = tokio::fs::read_dir(&dir).await?;

    while let Some(entry) = read_dir.next_entry().await? {
        let file_type = entry.file_type().await?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name == "System Volume Information" {
            continue;
        }
        let entry_path = entry.path();

        let relative = entry_path
            .strip_prefix(&music_canonical)
            .unwrap_or(&entry_path)
            .to_string_lossy()
            .into_owned();

        if file_type.is_dir() {
            entries.push(BrowseEntry {
                name,
                kind: "dir",
                path: relative,
            });
        } else if file_type.is_file() && is_audio_file(&entry_path) {
            entries.push(BrowseEntry {
                name,
                kind: "file",
                path: relative,
            });
        }
    }

    entries.sort_by(|a, b| match (a.kind, b.kind) {
        ("dir", "file") => std::cmp::Ordering::Less,
        ("file", "dir") => std::cmp::Ordering::Greater,
        _ => natural_cmp(&a.name, &b.name),
    });

    Ok(axum::Json(BrowseResponse { entries }))
}

pub async fn stream(
    AxumPath(path): AxumPath<String>,
    State(state): State<Arc<AppState>>,
    request: Request,
) -> Result<Response, ApiError> {
    let file_path = resolve_safe_path(&state.music_dir, &path)?;

    let is_flac = file_path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("flac"));

    if is_flac {
        let opus_path = transcode::flac_to_opus(&file_path).await?;
        let response = ServeFile::new(&opus_path)
            .oneshot(request)
            .await
            .expect("ServeFile is infallible");
        return Ok(response.into_response());
    } else {
        // ServeFile handles Range requests, Content-Length, ETag
        let response = ServeFile::new(&file_path)
            .oneshot(request)
            .await
            .expect("ServeFile is infallible");
        Ok(response.into_response())
    }
}

#[derive(Deserialize)]
pub struct SearchParams {
    q: String,
}

#[derive(Serialize)]
pub struct SearchResponse {
    results: Vec<search::SearchEntry>,
}

pub async fn search_tracks(
    Query(params): Query<SearchParams>,
    State(state): State<Arc<AppState>>,
) -> axum::Json<SearchResponse> {
    let results = state
        .search_index
        .search(&params.q, 50)
        .into_iter()
        .cloned()
        .collect();
    axum::Json(SearchResponse { results })
}

pub async fn metadata(
    AxumPath(path): AxumPath<String>,
    State(state): State<Arc<AppState>>,
) -> Result<axum::Json<cover::TrackMetadata>, ApiError> {
    let file_path = resolve_safe_path(&state.music_dir, &path)?;
    let meta = cover::extract_metadata(&file_path)?;
    Ok(axum::Json(meta))
}

pub async fn cover(
    AxumPath(path): AxumPath<String>,
    State(state): State<Arc<AppState>>,
) -> Result<Response, ApiError> {
    let file_path = resolve_safe_path(&state.music_dir, &path)?;

    match cover::extract_cover(&file_path)? {
        Some(art) => {
            let response = http::Response::builder()
                .header(http::header::CONTENT_TYPE, &art.mime_type)
                .body(axum::body::Body::from(art.data))
                .unwrap();
            Ok(response)
        }
        None => Err(ApiError::NotFound),
    }
}
