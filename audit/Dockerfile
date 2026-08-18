# Stage 1: Build the Go binary
FROM golang:1.21-alpine AS builder
WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o audit_service audit_service.go

# Stage 2: Create the lightweight production image
FROM alpine:latest
WORKDIR /app
COPY --from=builder /app/audit_service .

# Expose the API port
EXPOSE 9090

CMD ["./audit_service"]