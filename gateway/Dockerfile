# Stage 1: Build the Linux binary natively inside a Linux container
FROM rust:1.72-slim-bullseye AS builder
WORKDIR /usr/src/gateway

RUN apt-get update && apt-get install -y pkg-config libssl-dev zlib1g-dev build-essential

COPY Cargo.toml Cargo.lock ./
COPY src ./src

# Compile with release optimizations
RUN cargo build --release

# Stage 2: Runtime image
FROM debian:bullseye-slim
WORKDIR /app

RUN apt-get update && \
    apt-get install -y libssl1.1 ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Copy from the Linux builder stage (No Windows .exe needed!)
COPY --from=builder /usr/src/gateway/target/release/gateway .

EXPOSE 8443

CMD ["./gateway"]