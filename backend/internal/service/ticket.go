package service

import (
	"backend/internal/model"
	"backend/internal/repository"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"math/big"
	"time"
)

var (
	NoTicketErr = errors.New("ticket does not exist")
)

func RefreshTicket(name, key string) error {
	ticket, err := VerifyTicket(name, key)
	if err != nil {
		return err
	}
	ticket.ExpiresAt = time.Now().Add(model.TicketDuration)
	repository.StoreTicket(ticket)
	return nil
}

func LookupName(id string) (string, error) {
	ticket, exists := repository.GetTicket(id)
	if !exists {
		return "", NoTicketErr
	}
	return ticket.Name, nil
}

func IssueTicket(name string) (model.Ticket, string) {
	key := randSeq(24)
	ticket := model.NewTicket(name, sha256.Sum256([]byte(key)))

	repository.StoreTicket(ticket)

	return ticket, key
}

func VerifyTicket(name, key string) (model.Ticket, error) {
	keySha := sha256.Sum256([]byte(key))
	id := model.TicketId(name, keySha[:])
	ticket, exists := repository.GetTicket(id)
	if !exists || ticket.Name != name || subtle.ConstantTimeCompare(ticket.Key[:], keySha[:]) != 1 {
		return model.Ticket{}, NoTicketErr
	}
	return ticket, nil
}

func init() {
	go func() {
		ticker := time.NewTicker(2 * time.Minute)
		for _ = range ticker.C {
			repository.CleanupTickets()
			repository.CleanupRooms()
		}
	}()
}

var characters = []rune("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890@_-")

func randSeq(n int) string {
	max := big.NewInt(int64(len(characters)))
	b := make([]rune, n)
	for i := range b {
		idx, err := rand.Int(rand.Reader, max)
		if err != nil {
			panic(err)
		}
		b[i] = characters[idx.Int64()]
	}
	return string(b)
}
