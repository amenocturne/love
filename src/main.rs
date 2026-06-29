mod api;
mod cover;
mod search;
mod transcode;

use std::env;
use std::path::PathBuf;
use std::sync::Arc;

use axum::Router;
use axum::routing::{get, post};
use tower_http::compression::CompressionLayer;
use tower_http::services::ServeDir;

pub struct AppState {
    pub music_dir: PathBuf,
    pub frontend_dir: PathBuf,
    pub search_index: search::SearchIndex,
    pub tree_json: Vec<u8>,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let music_dir = PathBuf::from(
        env::var("MUSIC_DIR").expect("MUSIC_DIR environment variable is required"),
    );
    let listen_addr = env::var("LISTEN_ADDR").unwrap_or_else(|_| "127.0.0.1:3000".into());

    let frontend_dir = if PathBuf::from("/app/frontend").exists() {
        PathBuf::from("/app/frontend")
    } else {
        PathBuf::from("frontend")
    };

    let search_index = search::SearchIndex::build(&music_dir);
    let tree_json = api::build_tree_json(&music_dir);
    tracing::info!("tree cache: {} bytes", tree_json.len());

    let state = Arc::new(AppState {
        music_dir,
        frontend_dir: frontend_dir.clone(),
        search_index,
        tree_json,
    });

    let app = Router::new()
        .route("/api/browse", get(api::browse))
        .route("/api/tree", get(api::tree))
        .route("/api/search", get(api::search_tracks))
        .route("/api/stream/{*path}", get(api::stream))
        .route("/api/metadata/{*path}", get(api::metadata))
        .route("/api/cover/{*path}", get(api::cover))
        .route("/api/warm", post(api::warm))
        .route("/api/version", get(api::version))
        .layer(CompressionLayer::new())
        .fallback_service(ServeDir::new(frontend_dir))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&listen_addr).await.unwrap();
    tracing::info!("listening on {listen_addr}");
    axum::serve(listener, app).await.unwrap();
}
