package main

import (
	"backend/internal/server"
	"os"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "-healthcheck" {
		if err := server.Healthcheck(); err != nil {
			os.Exit(1)
		}
		return
	}
	server.Start()
}
