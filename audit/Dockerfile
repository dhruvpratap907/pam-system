# Stage 1: Build the Go binary
FROM golang:alpine AS builder
# Install git and C compilers required for SQLite
RUN apk add --no-cache git gcc musl-dev
WORKDIR /app

# Download dependencies
COPY go.mod go.sum ./
RUN go mod download

# Copy the source code and compile with CGO enabled
COPY . .
RUN CGO_ENABLED=1 GOOS=linux go build -o audit_service .

# Stage 2: Create the lightweight production image
FROM alpine:latest
WORKDIR /app
COPY --from=builder /app/audit_service .

# Expose the API port
EXPOSE 9090

CMD ["./audit_service"]