package service

import (
	"backend/internal/metrics"
	"backend/internal/model"
	"backend/internal/repository"
	"encoding/json"
	"errors"
	"maps"
	"math"
	"net/http"
	"slices"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	wsAuthTimeout  = 10 * time.Second
	wsReadTimeout  = 60 * time.Second
	wsWriteTimeout = 10 * time.Second
	wsMaxMsgBytes  = 64 * 1024
	wsSendBufSize  = 32
)

var wsUpgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

type wsInbound struct {
	Type                  string   `json:"type"`
	Name                  string   `json:"name"`
	IdentityKey           string   `json:"identity-key"`
	ClientTimeMs          int64    `json:"clientTimeMs"`
	Action                string   `json:"action"`
	VideoID               string   `json:"videoId"`
	Paused                *bool    `json:"paused"`
	PositionSec           *float64 `json:"positionSec"`
	PlaybackRate          *float64 `json:"playbackRate"`
	PublicPlaybackControl *bool    `json:"publicPlaybackControl"`
}

type wsClient struct {
	roomCode string
	memberID string
	conn     *websocket.Conn
	send     chan []byte
	closeMu  sync.Mutex
	closed   bool
}

func (c *wsClient) enqueue(payload []byte) bool {
	c.closeMu.Lock()
	defer c.closeMu.Unlock()
	if c.closed {
		return false
	}
	select {
	case c.send <- payload:
		return true
	default:
		return false
	}
}

func (c *wsClient) closeSend() {
	c.closeMu.Lock()
	if !c.closed {
		c.closed = true
		close(c.send)
	}
	c.closeMu.Unlock()
}

var (
	hubMu       sync.RWMutex
	roomClients = make(map[string]map[*wsClient]struct{})
)

func registerClient(c *wsClient) {
	hubMu.Lock()
	defer hubMu.Unlock()
	if roomClients[c.roomCode] == nil {
		roomClients[c.roomCode] = make(map[*wsClient]struct{})
	}
	roomClients[c.roomCode][c] = struct{}{}
}

func unregisterClient(c *wsClient) bool {
	hubMu.Lock()
	defer hubMu.Unlock()
	clients := roomClients[c.roomCode]
	delete(clients, c)
	stillPresent := false
	for other := range clients {
		if other.memberID == c.memberID {
			stillPresent = true
			break
		}
	}
	if len(clients) == 0 {
		delete(roomClients, c.roomCode)
	}
	return !stillPresent
}

func broadcastRoom(roomCode string, payload []byte, exclude *wsClient) {
	hubMu.RLock()
	clients := roomClients[roomCode]
	targets := make([]*wsClient, 0, len(clients))
	for c := range clients {
		if c != exclude {
			targets = append(targets, c)
		}
	}
	hubMu.RUnlock()

	for _, c := range targets {
		if !c.enqueue(payload) {
			c.closeSend()
		}
	}
}

func roomMemberIDs(room *model.Room) []string {
	room.Mu.RLock()
	ids := slices.Collect(maps.Keys(room.Members))
	room.Mu.RUnlock()
	if ids == nil {
		return []string{}
	}
	return ids
}

func broadcastMembers(room *model.Room, joinCode string, exclude *wsClient) {
	if payload, err := json.Marshal(map[string]any{
		"type":    "members",
		"members": roomMemberIDs(room),
	}); err == nil {
		broadcastRoom(joinCode, payload, exclude)
	}
}

func writeJSONDirect(conn *websocket.Conn, v any) {
	_ = conn.SetWriteDeadline(time.Now().Add(wsWriteTimeout))
	_ = conn.WriteJSON(v)
}

func sendErrorAndClose(conn *websocket.Conn, code, message string) {
	writeJSONDirect(conn, map[string]any{
		"type":    "error",
		"code":    code,
		"message": message,
	})
	_ = conn.WriteControl(
		websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.ClosePolicyViolation, code),
		time.Now().Add(wsWriteTimeout),
	)
}

func HandleRoomWS(w http.ResponseWriter, r *http.Request, joinCode, clientIP string) {
	conn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	conn.SetReadLimit(wsMaxMsgBytes)
	_ = conn.SetReadDeadline(time.Now().Add(wsAuthTimeout))

	var authMsg wsInbound
	if err := conn.ReadJSON(&authMsg); err != nil || authMsg.Type != "auth" {
		sendErrorAndClose(conn, "invalid_auth", "first message must be auth")
		return
	}

	ticket, err := VerifyTicket(authMsg.Name, authMsg.IdentityKey)
	if err != nil {
		sendErrorAndClose(conn, "invalid_ticket", "invalid or expired ticket")
		return
	}

	room, err := GetRoom(joinCode)
	if err != nil {
		sendErrorAndClose(conn, "room_not_found", "room not found")
		return
	}

	room.Mu.RLock()
	hostID := room.HostID
	room.Mu.RUnlock()

	room, err = repository.JoinRoom(joinCode, ticket.ID)
	if err != nil {
		if errors.Is(err, repository.ErrRoomFull) {
			sendErrorAndClose(conn, "room_full", "room is full")
			return
		}
		sendErrorAndClose(conn, "room_not_found", "room not found")
		return
	}

	client := &wsClient{
		roomCode: joinCode,
		memberID: ticket.ID,
		conn:     conn,
		send:     make(chan []byte, wsSendBufSize),
	}
	registerClient(client)
	metrics.IncConnections()
	metrics.RecordActiveUser(clientIP)

	defer func() {
		metrics.DecConnections()
		client.closeSend()
		if unregisterClient(client) {
			repository.LeaveRoom(joinCode, ticket.ID)
			broadcastMembers(room, joinCode, nil)
		}
	}()

	go func() {
		for payload := range client.send {
			_ = conn.SetWriteDeadline(time.Now().Add(wsWriteTimeout))
			if err := conn.WriteMessage(websocket.TextMessage, payload); err != nil {
				_ = conn.Close()
				return
			}
		}
		_ = conn.Close()
	}()

	role := "follower"
	if hostID == ticket.ID {
		role = "host"
	}

	room.Mu.RLock()
	initialSnap := room.Playback
	publicControl := room.PublicPlaybackControl
	room.Mu.RUnlock()

	if payload, err := json.Marshal(map[string]any{
		"type":                  "welcome",
		"role":                  role,
		"roomId":                joinCode,
		"hostId":                hostID,
		"publicPlaybackControl": publicControl,
		"snapshot":              initialSnap,
		"members":               roomMemberIDs(room),
	}); err == nil {
		client.enqueue(payload)
	}
	broadcastMembers(room, joinCode, client)

	for {
		_ = conn.SetReadDeadline(time.Now().Add(wsReadTimeout))
		var msg wsInbound
		if err := conn.ReadJSON(&msg); err != nil {
			return
		}

		switch msg.Type {
		case "ping":
			_ = RefreshTicket(ticket.Name, authMsg.IdentityKey)
			if payload, err := json.Marshal(map[string]any{
				"type":         "pong",
				"serverTimeMs": time.Now().UnixMilli(),
				"clientTimeMs": msg.ClientTimeMs,
			}); err == nil {
				client.enqueue(payload)
			}

		case "command":
			snap, changed, errCode, errMsg := applyCommand(room, role == "host", msg)
			if errCode != "" {
				if payload, err := json.Marshal(map[string]any{
					"type":    "error",
					"code":    errCode,
					"message": errMsg,
				}); err == nil {
					client.enqueue(payload)
				}
				continue
			}
			if !changed {
				continue
			}

			if msg.Action == "video" {
				if ack, err := json.Marshal(map[string]any{
					"type":     "ack",
					"videoId":  snap.VideoID,
					"revision": snap.Revision,
				}); err == nil {
					client.enqueue(ack)
				}
			}

			if payload, err := json.Marshal(map[string]any{
				"type":     "snapshot",
				"snapshot": snap,
			}); err == nil {
				broadcastRoom(joinCode, payload, client)
			}

		case "set_public_control":
			if role != "host" {
				if payload, err := json.Marshal(map[string]any{
					"type":    "error",
					"code":    "forbidden",
					"message": "only host can change room settings",
				}); err == nil {
					client.enqueue(payload)
				}
				continue
			}
			if msg.PublicPlaybackControl == nil {
				if payload, err := json.Marshal(map[string]any{
					"type":    "error",
					"code":    "invalid_command",
					"message": "publicPlaybackControl is required",
				}); err == nil {
					client.enqueue(payload)
				}
				continue
			}

			enabled := *msg.PublicPlaybackControl
			room.Mu.Lock()
			room.PublicPlaybackControl = enabled
			snap := room.Playback
			room.Mu.Unlock()

			if payload, err := json.Marshal(map[string]any{
				"type":                  "room_settings",
				"publicPlaybackControl": enabled,
				"snapshot":              snap,
			}); err == nil {
				broadcastRoom(joinCode, payload, nil)
			}

		default:
			if payload, err := json.Marshal(map[string]any{
				"type":    "error",
				"code":    "unknown_message",
				"message": "unsupported message type",
			}); err == nil {
				client.enqueue(payload)
			}
		}
	}
}

func applyCommand(room *model.Room, isHost bool, msg wsInbound) (model.PlaybackState, bool, string, string) {
	switch msg.Action {
	case "play", "pause", "seek", "rate", "video":
	default:
		return model.PlaybackState{}, false, "invalid_command", "unsupported playback action"
	}

	room.Mu.Lock()
	defer room.Mu.Unlock()

	if !isHost && !room.PublicPlaybackControl {
		return model.PlaybackState{}, false, "forbidden", "only host can send playback commands"
	}

	if msg.Action == "video" {
		if msg.VideoID == "" {
			return model.PlaybackState{}, false, "invalid_command", "videoId is required"
		}
		room.Playback.VideoID = msg.VideoID
	} else if msg.VideoID != "" {
		if room.Playback.VideoID == "" {
			room.Playback.VideoID = msg.VideoID
		} else if msg.VideoID != room.Playback.VideoID {
			return model.PlaybackState{}, false, "", ""
		}
	}
	if msg.Paused != nil {
		room.Playback.Paused = *msg.Paused
	} else if msg.Action == "play" {
		room.Playback.Paused = false
	} else if msg.Action == "pause" {
		room.Playback.Paused = true
	}
	if msg.PositionSec != nil && !math.IsNaN(*msg.PositionSec) && !math.IsInf(*msg.PositionSec, 0) && *msg.PositionSec >= 0 {
		room.Playback.PositionSec = *msg.PositionSec
	}
	if msg.PlaybackRate != nil && !math.IsNaN(*msg.PlaybackRate) && !math.IsInf(*msg.PlaybackRate, 0) && *msg.PlaybackRate > 0 && *msg.PlaybackRate <= 16 {
		room.Playback.PlaybackRate = *msg.PlaybackRate
	}

	room.Playback.Revision++
	room.Playback.ServerTimeMs = time.Now().UnixMilli()
	return room.Playback, true, "", ""
}
