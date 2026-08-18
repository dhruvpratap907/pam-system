# Stage 1: Build the Go binary
FROM golang:1.21-alpine AS builder
WORKDIR /app

# Download dependencies
COPY go.mod go.sum ./
RUN go mod download

# Copy the source code and compile
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o policy_service policy_service.go

# Stage 2: Create the lightweight production image
FROM alpine:latest
WORKDIR /app
COPY --from=builder /app/policy_service .

# Expose the API port
EXPOSE 8080

# Run the server
CMD ["./policy_service"]