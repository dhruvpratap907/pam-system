# Stage 1: Build the Rust binary with a temporary swap file for low-RAM builds
FROM rust:1.72-slim-bullseye AS builder
WORKDIR /usr/src/gateway

RUN apt-get update && apt-get install -y pkg-config libssl-dev zlib1g-dev build-essential

COPY Cargo.toml Cargo.lock ./
COPY src ./src

# Create a temporary 1GB swap file so cargo build doesn't run out of memory on 512MB RAM
RUN dd if=/dev/zero of=/swapfile bs=1M count=1024 && \
    chmod 600 /swapfile && \
    mkswap /swapfile && \
    swapon /swapfile && \
    cargo build --release && \
    swapoff /swapfile && \
    rm /swapfile

# Stage 2: Runtime image
FROM debian:bullseye-slim
WORKDIR /app

RUN apt-get update && \
    apt-get install -y libssl1.1 ca-certificates && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /usr/src/gateway/target/release/gateway .

EXPOSE 8443

CMD ["./gateway"]