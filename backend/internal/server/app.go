package server

import (
	"backend/internal/handlers"
	"backend/internal/metrics"
	"backend/internal/repository"
	"log/slog"
	"os"

	"github.com/gin-gonic/gin"
)

func Start() {
	e := gin.Default()
	handlers.Register(e)

	keyFile := os.Getenv("METRICS_API_KEY_FILE")
	metricsKey, generated, err := metrics.LoadOrGenerateAPIKey(os.Getenv("METRICS_API_KEY"), keyFile)
	if err != nil {
		slog.Error("failed to initialize metrics API key; /metrics disabled", "err", err)
	} else if generated {
		slog.Info("generated metrics API key", "key", metricsKey, "file", keyFile)
	}
	e.GET("/metrics", gin.WrapH(metrics.Handler(repository.ActiveRoomCount, metricsKey)))

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	err = e.Run(":" + port)
	if err != nil {
		panic(err)
	}
}
