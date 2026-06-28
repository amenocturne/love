FROM rust:1.89-bookworm AS builder

WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src/ src/
RUN cargo build --release

FROM oven/bun:1 AS frontend
WORKDIR /app
COPY frontend/ frontend/
RUN cd frontend && bun install && bun run build

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/love /usr/local/bin/love
COPY --from=frontend /app/frontend/dist/ /app/frontend/dist/
COPY frontend/index.html /app/frontend/
COPY frontend/style.css /app/frontend/
COPY frontend/icon.png /app/frontend/

ENV MUSIC_DIR=/music
ENV LISTEN_ADDR=0.0.0.0:3000
EXPOSE 3000

CMD ["love"]
