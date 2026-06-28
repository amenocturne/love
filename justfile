default:
    @just --list

setup:
    cargo build
    cd frontend && bun install

run music_dir="/Volumes/Player":
    MUSIC_DIR="{{music_dir}}" cargo run

run-release music_dir="/Volumes/Player":
    MUSIC_DIR="{{music_dir}}" cargo run --release

build:
    cd frontend && bun run build
    cargo build --release

frontend-dev:
    cd frontend && bun run dev

test *args:
    cargo test {{args}}

fmt:
    cargo fmt

lint:
    cargo clippy -- -D warnings

clean:
    cargo clean
    rm -rf frontend/dist

reset: clean setup
