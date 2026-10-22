use std::collections::BTreeMap;
use std::hash::{Hash, Hasher};
use std::io;
use std::path::Path;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use crate::api::BrowseEntry;
use crate::search::{SearchEntry, SearchIndex};

pub struct Snapshot {
    pub tree_json: Vec<u8>,
    pub search_index: SearchIndex,
    pub etag: String,
}

pub struct Library {
    snapshot: RwLock<Arc<Snapshot>>,
}

impl Library {
    pub fn new(root: &Path) -> io::Result<Self> {
        let (tree_json, search_index) = scan(root)?;
        Ok(Self {
            snapshot: RwLock::new(Arc::new(Snapshot {
                etag: etag(&tree_json),
                tree_json,
                search_index,
            })),
        })
    }

    pub fn snapshot(&self) -> Arc<Snapshot> {
        self.snapshot.read().expect("library lock poisoned").clone()
    }

    fn refresh(&self, root: &Path) -> io::Result<bool> {
        let (tree_json, search_index) = scan(root)?;
        if tree_json == self.snapshot().tree_json {
            return Ok(false);
        }
        let snapshot = Arc::new(Snapshot {
            etag: etag(&tree_json),
            tree_json,
            search_index,
        });
        *self.snapshot.write().expect("library lock poisoned") = snapshot;
        Ok(true)
    }
}

fn etag(tree_json: &[u8]) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    tree_json.hash(&mut hasher);
    format!("\"library-{:016x}\"", hasher.finish())
}

pub fn start_refresh(library: Arc<Library>, root: std::path::PathBuf, period: Duration) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(period).await;
            let library = library.clone();
            let root = root.clone();
            match tokio::task::spawn_blocking(move || library.refresh(&root)).await {
                Ok(Ok(true)) => tracing::info!("library refreshed"),
                Ok(Ok(false)) => {}
                Ok(Err(error)) => {
                    tracing::warn!("library scan failed; retaining previous index: {error}")
                }
                Err(error) => tracing::error!("library scan task failed: {error}"),
            }
        }
    });
}

fn scan(root: &Path) -> io::Result<(Vec<u8>, SearchIndex)> {
    let root = root.canonicalize()?;
    let mut tree = BTreeMap::new();
    walk(&root, &root, &mut tree)?;
    let entries = tree
        .values()
        .flatten()
        .filter(|entry| entry.kind == "file")
        .map(|entry| SearchEntry {
            name: entry.name.clone(),
            path: entry.path.clone(),
        })
        .collect();
    Ok((serde_json::to_vec(&tree)?, SearchIndex::new(entries)))
}

fn walk(
    base: &Path,
    current: &Path,
    tree: &mut BTreeMap<String, Vec<BrowseEntry>>,
) -> io::Result<()> {
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(current)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name == "System Volume Information" {
            continue;
        }
        let file_type = entry.file_type()?;
        let entry_path = entry.path();
        let kind = if file_type.is_dir() {
            walk(base, &entry_path, tree)?;
            "dir"
        } else if file_type.is_file() && crate::api::is_audio_file(&entry_path) {
            "file"
        } else {
            continue;
        };
        entries.push(BrowseEntry {
            name,
            kind,
            path: entry_path
                .strip_prefix(base)
                .expect("path under library root")
                .to_string_lossy()
                .into_owned(),
        });
    }
    entries.sort_by(|a, b| match (a.kind, b.kind) {
        ("dir", "file") => std::cmp::Ordering::Less,
        ("file", "dir") => std::cmp::Ordering::Greater,
        _ => crate::api::natural_cmp(&a.name, &b.name),
    });
    tree.insert(
        current
            .strip_prefix(base)
            .expect("path under library root")
            .to_string_lossy()
            .into_owned(),
        entries,
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refresh_keeps_browsing_and_search_consistent_across_library_changes() {
        let root = std::env::temp_dir().join(format!("love-library-{}", std::process::id()));
        std::fs::create_dir_all(root.join("Disk 1")).unwrap();
        std::fs::write(root.join("Disk 1/1. V.mp3"), []).unwrap();
        let library = Library::new(&root).unwrap();
        let old = library.snapshot();
        assert!(!library.refresh(&root).unwrap());
        assert_eq!(library.snapshot().etag, old.etag);

        std::fs::rename(root.join("Disk 1"), root.join("Original Soundtrack")).unwrap();
        std::fs::write(root.join("Original Soundtrack/2. New.flac"), []).unwrap();
        std::fs::write(root.join("ignored.txt"), []).unwrap();
        assert!(library.refresh(&root).unwrap());
        let next = library.snapshot();
        let tree: serde_json::Value = serde_json::from_slice(&next.tree_json).unwrap();
        assert!(tree.get("Disk 1").is_none());
        assert_eq!(tree["Original Soundtrack"].as_array().unwrap().len(), 2);
        assert!(next.search_index.search("Disk 1", 50).is_empty());
        assert_eq!(next.search_index.search("Original Soundtrack", 50).len(), 2);
        assert_ne!(old.etag, next.etag);
        assert_eq!(old.search_index.search("Disk 1", 50).len(), 1);

        std::fs::remove_file(root.join("Original Soundtrack/1. V.mp3")).unwrap();
        assert!(library.refresh(&root).unwrap());
        assert!(
            library
                .snapshot()
                .search_index
                .search("V.mp3", 50)
                .is_empty()
        );
        std::fs::remove_dir_all(&root).unwrap();
        let before_failure = library.snapshot();
        assert!(library.refresh(&root).is_err());
        assert_eq!(library.snapshot().etag, before_failure.etag);
        assert_eq!(
            library.snapshot().search_index.search("New.flac", 50).len(),
            1
        );
    }
    #[tokio::test]
    async fn background_refresh_invalidates_http_cache_and_updates_search() {
        use axum::{
            Router,
            body::Body,
            http::{Request, StatusCode},
            routing::get,
        };
        use tower::ServiceExt;
        let root = std::env::temp_dir().join(format!("love-http-{}", std::process::id()));
        std::fs::create_dir_all(root.join("Old")).unwrap();
        std::fs::write(root.join("Old/Track.mp3"), []).unwrap();
        let library = Arc::new(Library::new(&root).unwrap());
        let app = Router::new()
            .route("/api/tree", get(crate::api::tree))
            .route("/api/search", get(crate::api::search_tracks))
            .with_state(Arc::new(crate::AppState {
                music_dir: root.clone(),
                frontend_dir: root.clone(),
                library: library.clone(),
            }));
        let request = || {
            Request::builder()
                .uri("/api/tree")
                .body(Body::empty())
                .unwrap()
        };
        let initial = app.clone().oneshot(request()).await.unwrap();
        let etag = initial.headers()["etag"].clone();
        assert_eq!(initial.headers()["cache-control"], "no-cache");
        let conditional = || {
            Request::builder()
                .uri("/api/tree")
                .header("if-none-match", &etag)
                .body(Body::empty())
                .unwrap()
        };
        assert_eq!(
            app.clone().oneshot(conditional()).await.unwrap().status(),
            StatusCode::NOT_MODIFIED
        );
        std::fs::rename(root.join("Old"), root.join("New")).unwrap();
        start_refresh(library.clone(), root.clone(), Duration::from_millis(10));
        tokio::time::timeout(Duration::from_secs(5), async {
            while library.snapshot().etag == etag.to_str().unwrap() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let response = app.clone().oneshot(conditional()).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let tree: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(tree.get("Old").is_none());
        assert!(tree.get("New").is_some());
        assert_eq!(
            Library::new(&root).unwrap().snapshot().etag,
            library.snapshot().etag
        );
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/search?q=New")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let search: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(search["results"][0]["path"], "New/Track.mp3");
        std::fs::remove_dir_all(root).unwrap();
    }
}
