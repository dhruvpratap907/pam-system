# Stage 2: Use a tiny Debian image and copy your pre-compiled binary
FROM debian:bullseye-slim
WORKDIR /app

# Install runtime dependencies for SSL
RUN apt-get update && \
    apt-get install -y libssl1.1 ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Copy the binary that you just built locally
COPY target/release/gateway .

# Expose the port
EXPOSE 8443

CMD ["./gateway"]