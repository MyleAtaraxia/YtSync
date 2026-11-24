package handlers

import (
	"backend/internal/metrics"
	"backend/internal/service"
	"errors"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

func getTicket(c *gin.Context) {
	id := strings.TrimSpace(c.Param("id"))
	name, err := service.LookupName(id)
	if err != nil {
		if errors.Is(err, service.NoTicketErr) {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"id":   id,
		"name": name,
	})
}

func claimTicket(c *gin.Context) {
	name := strings.TrimSpace(c.Param("name"))
	if name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name is required"})
		return
	}
	ticket, key := service.IssueTicket(name)
	metrics.IncTicketsClaimed()
	metrics.RecordActiveUser(c.ClientIP())
	c.JSON(http.StatusOK, gin.H{
		"status":       "ok",
		"id":           ticket.ID,
		"identity-key": key,
	})
}
