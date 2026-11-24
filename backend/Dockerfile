FROM golang:1.26-alpine AS builder

WORKDIR /app

COPY go.mod go.sum* ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /server ./src/server \
    && mkdir -p /data && chown 65532:65532 /data

FROM scratch

COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder /server /server
COPY --from=builder --chown=65532:65532 /data /data

EXPOSE 8080
USER 65532:65532

ENTRYPOINT ["/server"]
