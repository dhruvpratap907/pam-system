# Stage 1: Build the Rust binary
FROM rust:1.72-slim-bullseye AS builder
WORKDIR /usr/src/gateway

# Copy project files
COPY Cargo.toml Cargo.lock ./
COPY src ./src

# Compile in release mode for maximum performance
RUN cargo build --release

# Stage 2: Create the production image
FROM debian:bullseye-slim
WORKDIR /app

# Copy the compiled executable from the builder stage
COPY --from=builder /usr/src/gateway/target/release/gateway .

# Expose the WebSocket and Proxy port
EXPOSE 8443

CMD ["./gateway"]