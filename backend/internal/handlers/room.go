package handlers

import (
	"backend/internal/model"
	"backend/internal/repository"
	"backend/internal/service"
	"errors"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

type createRoomRequest struct {
	Name                  string `json:"name" binding:"required"`
	IdentityKey           string `json:"identity-key" binding:"required"`
	PublicPlaybackControl bool   `json:"publicPlaybackControl"`
}

func get(c *gin.Context) {
	joinCode := strings.TrimSpace(c.Param("joinCode"))
	room, err := service.GetRoom(joinCode)
	if err != nil {
		if errors.Is(err, repository.ErrRoomNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	room.Mu.RLock()
	code := room.JoinCode
	memberCount := len(room.Members)
	publicControl := room.PublicPlaybackControl
	playback := room.Playback
	room.Mu.RUnlock()

	c.JSON(http.StatusOK, gin.H{
		"join-code":             code,
		"memberCount":           memberCount,
		"maxMembers":            model.MaxRoomSize,
		"publicPlaybackControl": publicControl,
		"playback":              playback,
	})
}

func create(c *gin.Context) {
	var req createRoomRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
		return
	}

	ticket, err := service.VerifyTicket(req.Name, req.IdentityKey)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid ticket"})
		return
	}

	room, err := service.CreateRoom(ticket.ID, req.PublicPlaybackControl)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusCreated, gin.H{
		"join-code":             room.JoinCode,
		"publicPlaybackControl": room.PublicPlaybackControl,
	})
}

func join(c *gin.Context) {
	joinCode := strings.TrimSpace(c.Param("joinCode"))
	if joinCode == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "joinCode is required"})
		return
	}
	service.HandleRoomWS(c.Writer, c.Request, joinCode, c.ClientIP())
}
