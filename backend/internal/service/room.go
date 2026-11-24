package service

import (
	"backend/internal/metrics"
	"backend/internal/model"
	"backend/internal/repository"
	"crypto/rand"
	"errors"
	"math/big"
)

var (
	ErrJoinCodeExhausted = errors.New("could not generate unique join code")
	joinCodeChars        = []rune("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
)

func CreateRoom(hostID string, publicPlaybackControl bool) (*model.Room, error) {
	for range 10 {
		room := model.NewRoom(randJoinCode(model.JoinCodeLength), hostID)
		room.PublicPlaybackControl = publicPlaybackControl
		if repository.StoreRoom(room) {
			metrics.IncRoomsCreated()
			return room, nil
		}
	}
	return nil, ErrJoinCodeExhausted
}

func GetRoom(code string) (*model.Room, error) {
	room, ok := repository.GetRoom(code)
	if !ok {
		return nil, repository.ErrRoomNotFound
	}
	return room, nil
}

func randJoinCode(n int) string {
	max := big.NewInt(int64(len(joinCodeChars)))
	b := make([]rune, n)
	for i := range b {
		idx, err := rand.Int(rand.Reader, max)
		if err != nil {
			panic(err)
		}
		b[i] = joinCodeChars[idx.Int64()]
	}
	return string(b)
}
