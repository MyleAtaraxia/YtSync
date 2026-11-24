package model

import (
	"crypto/sha256"
	"encoding/hex"
	"time"
)

const TicketDuration = time.Minute * 20

// Ticket holds the identity and its key hash that is used for verification.
type Ticket struct {
	Name      string
	ID        string
	Key       [32]byte
	ExpiresAt time.Time
}

func NewTicket(name string, key [32]byte) Ticket {
	id := TicketId(name, key[:])
	return Ticket{
		Name:      name,
		ID:        id,
		Key:       key,
		ExpiresAt: time.Now().Add(TicketDuration),
	}
}
func TicketId(name string, key []byte) string {
	hash := sha256.Sum256(append([]byte(name), key...))
	id := hex.EncodeToString(hash[:])
	return id
}
