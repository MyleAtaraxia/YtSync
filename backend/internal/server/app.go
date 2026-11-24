package server

import (
	"backend/internal/handlers"
	"backend/internal/metrics"
	"backend/internal/repository"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/gin-gonic/gin"
)

func serverPort() string {
	if port := os.Getenv("PORT"); port != "" {
		return port
	}
	return "8080"
}

func Healthcheck() error {
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://127.0.0.1:" + serverPort() + "/health")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("unexpected status: %d", resp.StatusCode)
	}
	return nil
}

func Start() {
	e := gin.Default()
	handlers.Register(e)
	e.GET("/health", func(c *gin.Context) {
		c.String(http.StatusOK, "ok")
	})

	keyFile := os.Getenv("METRICS_API_KEY_FILE")
	metricsKey, generated, err := metrics.LoadOrGenerateAPIKey(os.Getenv("METRICS_API_KEY"), keyFile)
	if err != nil {
		slog.Error("failed to initialize metrics API key; /metrics disabled", "err", err)
	} else if generated {
		slog.Info("generated metrics API key", "key", metricsKey, "file", keyFile)
	}
	e.GET("/metrics", gin.WrapH(metrics.Handler(repository.ActiveRoomCount, metricsKey)))

	if err := e.Run(":" + serverPort()); err != nil {
		panic(err)
	}
}
