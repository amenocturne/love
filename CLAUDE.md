# Love

Self-hosted web music player with folder-tree browsing. Miller column navigation + audio player.

## Commands

Run `just` to see all commands. Key ones:

```
just run                    # Run with /Volumes/Player
just run ~/Music            # Run with custom music dir
just frontend-dev           # Watch-rebuild frontend
just build                  # Production build
```

## Architecture

```
src/
├── main.rs          # axum server, routes, static file serving
├── api.rs           # GET /api/browse, /api/stream, /api/cover
├── transcode.rs     # FLAC→opus via ffmpeg subprocess
└── cover.rs         # embedded cover art extraction via lofty

frontend/
├── index.html
├── style.css
├── app.ts           # entry point, state, keyboard handling
├── columns.ts       # Miller column rendering + navigation
├── player.ts        # audio player UI + controls
└── package.json     # bun build config
```

## API

- `GET /api/browse?path=<relative>` — directory listing as JSON
- `GET /api/stream/<path>` — audio stream (mp3 direct, flac→opus)
- `GET /api/cover/<path>` — embedded cover art image

## Key Patterns

- Frontend is vanilla TS, bundled by bun, served as static files by axum
- FLAC transcoding shells out to ffmpeg (must be in PATH)
- Cover art extracted via lofty (pure Rust), cached in memory
- No database, no indexing — filesystem is the source of truth
