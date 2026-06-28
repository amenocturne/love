use std::path::Path;

use lofty::file::TaggedFileExt;
use lofty::picture::{MimeType, PictureType};
use lofty::probe::Probe;
use lofty::tag::Accessor;
use serde::Serialize;

pub struct CoverArt {
    pub data: Vec<u8>,
    pub mime_type: String,
}

#[derive(Debug)]
pub enum CoverError {
    Io(#[allow(dead_code)] std::io::Error),
    Lofty(#[allow(dead_code)] lofty::error::LoftyError),
}

impl From<std::io::Error> for CoverError {
    fn from(e: std::io::Error) -> Self {
        CoverError::Io(e)
    }
}

impl From<lofty::error::LoftyError> for CoverError {
    fn from(e: lofty::error::LoftyError) -> Self {
        CoverError::Lofty(e)
    }
}

fn mime_type_str(mt: Option<&MimeType>) -> &'static str {
    match mt {
        Some(MimeType::Png) => "image/png",
        Some(MimeType::Jpeg) => "image/jpeg",
        Some(MimeType::Tiff) => "image/tiff",
        Some(MimeType::Bmp) => "image/bmp",
        Some(MimeType::Gif) => "image/gif",
        _ => "application/octet-stream",
    }
}

pub fn extract_cover(path: &Path) -> Result<Option<CoverArt>, CoverError> {
    let tagged_file = Probe::open(path)?.read()?;

    let front_cover = tagged_file.tags().iter().find_map(|tag| {
        tag.pictures()
            .iter()
            .find(|p| p.pic_type() == PictureType::CoverFront)
    });

    if let Some(pic) = front_cover {
        return Ok(Some(CoverArt {
            data: pic.data().to_vec(),
            mime_type: mime_type_str(pic.mime_type()).to_owned(),
        }));
    }

    let any_picture = tagged_file
        .tags()
        .iter()
        .find_map(|tag| tag.pictures().first());

    if let Some(pic) = any_picture {
        return Ok(Some(CoverArt {
            data: pic.data().to_vec(),
            mime_type: mime_type_str(pic.mime_type()).to_owned(),
        }));
    }

    Ok(None)
}

#[derive(Serialize)]
pub struct TrackMetadata {
    pub artist: Option<String>,
    pub title: Option<String>,
    pub album: Option<String>,
}

pub fn extract_metadata(path: &Path) -> Result<TrackMetadata, CoverError> {
    let tagged_file = Probe::open(path)?.read()?;
    let mut artist = None;
    let mut title = None;
    let mut album = None;
    for tag in tagged_file.tags() {
        if artist.is_none() {
            artist = tag.artist().map(|s| s.to_string());
        }
        if title.is_none() {
            title = tag.title().map(|s| s.to_string());
        }
        if album.is_none() {
            album = tag.album().map(|s| s.to_string());
        }
    }
    Ok(TrackMetadata { artist, title, album })
}
