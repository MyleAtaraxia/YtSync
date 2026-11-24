package server

import (
	"backend/internal/handlers"
	"os"

	"github.com/gin-gonic/gin"
)

func Start() {
	e := gin.Default()
	handlers.Register(e)
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	err := e.Run(":" + port)
	if err != nil {
		panic(err)
	}
}
