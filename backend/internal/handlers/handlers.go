package handlers

import "github.com/gin-gonic/gin"

func Register(e *gin.Engine) {
	e.POST("/ticket/:name", claimTicket)
	e.GET("/ticket/:id", getTicket)

	g := e.Group("/room")
	g.GET("/:joinCode", get)
	g.GET("/:joinCode/join", join)
	g.POST("/new", create)
}
