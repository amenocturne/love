use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub enum TranscodeError {
    Io(#[allow(dead_code)] std::io::Error),
    FfmpegFailed(#[allow(dead_code)] String),
}

impl From<std::io::Error> for TranscodeError {
    fn from(e: std::io::Error) -> Self {
        TranscodeError::Io(e)
    }
}

fn cache_path(source: &Path) -> PathBuf {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    source.hash(&mut hasher);
    let hash = hasher.finish();
    std::env::temp_dir().join(format!("love-{:016x}.ogg", hash))
}

pub async fn flac_to_opus(path: &Path) -> Result<PathBuf, TranscodeError> {
    let cached = cache_path(path);
    if cached.exists() {
        return Ok(cached);
    }

    let output = tokio::process::Command::new("ffmpeg")
        .args(["-y", "-i"])
        .arg(path)
        .args(["-vn", "-c:a", "libopus", "-b:a", "192k"])
        .arg(&cached)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .output()
        .await?;

    if !output.status.success() {
        let _ = std::fs::remove_file(&cached);
        return Err(TranscodeError::FfmpegFailed(
            String::from_utf8_lossy(&output.stderr).into_owned(),
        ));
    }

    Ok(cached)
}
