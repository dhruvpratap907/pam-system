# Stage 1: Build the Rust binary with release profile optimizations to save RAM
FROM rust:1.72-slim-bullseye AS builder
WORKDIR /usr/src/gateway

RUN apt-get update && apt-get install -y pkg-config libssl-dev zlib1g-dev build-essential

COPY Cargo.toml Cargo.lock ./
COPY src ./src

# Build with profile release and single-threaded to stay under 512MB RAM
RUN cargo build --release -j 1

# Stage 2: Runtime image
FROM debian:bullseye-slim
WORKDIR /app

RUN apt-get update && \
    apt-get install -y libssl1.1 ca-certificates && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /usr/src/gateway/target/release/gateway .

EXPOSE 8443

CMD ["./gateway"]