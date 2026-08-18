FROM debian:bullseye-slim
WORKDIR /app

RUN apt-get update && \
    apt-get install -y libssl1.1 ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Copy the pre-compiled Windows build file and name it 'gateway' for Linux
COPY bin/gateway.exe ./gateway

EXPOSE 8443

CMD ["./gateway"]