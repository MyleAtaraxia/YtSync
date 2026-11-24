package repository

import (
	"backend/internal/model"
	"errors"
	"log/slog"
	"sync"
	"time"
)

var (
	ErrRoomNotFound = errors.New("room not found")
	ErrRoomFull     = errors.New("room is full")

	ticketData = make(map[string]any)
	roomData   = make(map[string]*model.Room)
	ticketMu   sync.RWMutex
	roomMu     sync.RWMutex
)

func StoreTicket(ticket model.Ticket) {
	ticketMu.Lock()
	defer ticketMu.Unlock()
	ticketData[ticket.ID] = ticket
}

func GetTicket(id string) (model.Ticket, bool) {
	ticketMu.RLock()
	defer ticketMu.RUnlock()
	dat, ok := ticketData[id]
	if !ok {
		return model.Ticket{}, false
	}
	ret, ok := dat.(model.Ticket)
	if !ok || ret.ExpiresAt.Before(time.Now()) {
		return model.Ticket{}, false
	}
	return ret, true
}

func CleanupTickets() {
	now := time.Now()

	ticketMu.Lock()
	defer ticketMu.Unlock()

	for key, value := range ticketData {
		ticket, ok := value.(model.Ticket)
		if !ok {
			slog.Error("object stored under ticketsBase is not a ticket")
			continue
		}
		if !now.Before(ticket.ExpiresAt) {
			delete(ticketData, key)
		}
	}
}

func StoreRoom(room *model.Room) bool {
	roomMu.Lock()
	defer roomMu.Unlock()
	if existing, exists := roomData[room.JoinCode]; exists {
		existing.Mu.RLock()
		expired := isRoomExpired(existing, time.Now())
		existing.Mu.RUnlock()
		if !expired {
			return false
		}
	}
	roomData[room.JoinCode] = room
	return true
}

func isRoomExpired(room *model.Room, now time.Time) bool {
	return len(room.Members) == 0 && !room.EmptySince.IsZero() && now.Sub(room.EmptySince) >= model.EmptyRoomTTL
}

func GetRoom(code string) (*model.Room, bool) {
	roomMu.RLock()
	defer roomMu.RUnlock()

	room, ok := roomData[code]
	if !ok {
		return nil, false
	}
	room.Mu.RLock()
	expired := isRoomExpired(room, time.Now())
	room.Mu.RUnlock()
	if expired {
		return nil, false
	}
	return room, true
}

func DeleteRoom(code string) {
	roomMu.Lock()
	defer roomMu.Unlock()
	delete(roomData, code)
}

func JoinRoom(code, memberID string) (*model.Room, error) {
	roomMu.RLock()
	defer roomMu.RUnlock()

	room, ok := roomData[code]
	if !ok {
		return nil, ErrRoomNotFound
	}

	room.Mu.Lock()
	defer room.Mu.Unlock()

	if isRoomExpired(room, time.Now()) {
		return nil, ErrRoomNotFound
	}

	if _, exists := room.Members[memberID]; !exists {
		if len(room.Members) >= model.MaxRoomSize {
			return nil, ErrRoomFull
		}
		if room.Members == nil {
			room.Members = make(map[string]struct{})
		}
		room.Members[memberID] = struct{}{}
	}
	room.EmptySince = time.Time{}
	return room, nil
}

func LeaveRoom(code, memberID string) bool {
	roomMu.RLock()
	defer roomMu.RUnlock()

	room, ok := roomData[code]
	if !ok {
		return true
	}

	room.Mu.Lock()
	defer room.Mu.Unlock()

	delete(room.Members, memberID)
	empty := len(room.Members) == 0
	if empty {
		room.EmptySince = time.Now()
	}
	return empty
}

func CleanupRooms() {
	now := time.Now()

	roomMu.Lock()
	defer roomMu.Unlock()

	for code, room := range roomData {
		room.Mu.RLock()
		expired := isRoomExpired(room, now)
		room.Mu.RUnlock()
		if expired {
			delete(roomData, code)
		}
	}
}

func ActiveRoomCount() int {
	now := time.Now()

	roomMu.RLock()
	defer roomMu.RUnlock()

	count := 0
	for _, room := range roomData {
		room.Mu.RLock()
		expired := isRoomExpired(room, now)
		room.Mu.RUnlock()
		if !expired {
			count++
		}
	}
	return count
}
