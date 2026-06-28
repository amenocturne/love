use std::path::Path;

use serde::Serialize;

const AUDIO_EXTENSIONS: &[&str] = &["mp3", "flac", "wav", "ogg", "opus", "m4a", "aac", "wma", "ape"];

#[derive(Serialize, Clone)]
pub struct SearchEntry {
    pub name: String,
    pub path: String,
}

pub struct SearchIndex {
    entries: Vec<SearchEntry>,
}

impl SearchIndex {
    pub fn build(music_dir: &Path) -> Self {
        let canonical = music_dir.canonicalize().unwrap_or_else(|_| music_dir.to_path_buf());
        let mut entries = Vec::new();
        walk(&canonical, &canonical, &mut entries);
        entries.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
        tracing::info!("search index: {} tracks", entries.len());
        SearchIndex { entries }
    }

    pub fn search(&self, query: &str, limit: usize) -> Vec<&SearchEntry> {
        let tokens: Vec<String> = query
            .to_lowercase()
            .split_whitespace()
            .map(String::from)
            .collect();
        if tokens.is_empty() {
            return Vec::new();
        }

        let mut results: Vec<&SearchEntry> = self
            .entries
            .iter()
            .filter(|e| {
                let path_lower = e.path.to_lowercase();
                tokens.iter().all(|t| path_lower.contains(t.as_str()))
            })
            .collect();

        results.sort_by(|a, b| natural_cmp(&a.path, &b.path));
        results.truncate(limit);
        results
    }
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
                    std::cmp::Ordering::Equal => { ai.next(); bi.next(); }
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

fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| AUDIO_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

fn walk(base: &Path, current: &Path, entries: &mut Vec<SearchEntry>) {
    let Ok(read_dir) = std::fs::read_dir(current) else {
        return;
    };
    for entry in read_dir.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name == "System Volume Information" {
            continue;
        }
        let path = entry.path();
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            walk(base, &path, entries);
        } else if ft.is_file() && is_audio(&path) {
            let relative = path
                .strip_prefix(base)
                .unwrap_or(&path)
                .to_string_lossy()
                .into_owned();
            entries.push(SearchEntry {
                name,
                path: relative,
            });
        }
    }
}
