# Stage 1: Build the Rust binary
FROM rust:1.72-slim-bullseye AS builder
WORKDIR /usr/src/gateway

# Install C compilers and OpenSSL dependencies required by the ssh2 crate
RUN apt-get update && apt-get install -y pkg-config libssl-dev zlib1g-dev build-essential

# Copy project files
COPY Cargo.toml Cargo.lock ./
COPY src ./src

# Compile in release mode for maximum performance
RUN cargo build --release

# Stage 2: Create the production image
FROM debian:bullseye-slim
WORKDIR /app

# Install runtime OpenSSL libraries needed by the compiled gateway
RUN apt-get update && \
    apt-get install -y libssl1.1 ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Copy the compiled executable from the builder stage
COPY --from=builder /usr/src/gateway/target/release/gateway .

# Expose the WebSocket and Proxy port
EXPOSE 8443

CMD ["./gateway"]