package model

import (
	"sync"
	"time"
)

const (
	MaxRoomSize    = 64
	JoinCodeLength = 6
	EmptyRoomTTL   = 5 * time.Minute
)

type PlaybackState struct {
	Revision     uint64  `json:"revision"`
	VideoID      string  `json:"videoId"`
	Paused       bool    `json:"paused"`
	PositionSec  float64 `json:"positionSec"`
	PlaybackRate float64 `json:"playbackRate"`
	ServerTimeMs int64   `json:"serverTimeMs"`
}

type Room struct {
	Mu                    sync.RWMutex        `json:"-"`
	JoinCode              string              `json:"join-code"`
	HostID                string              `json:"-"`
	PublicPlaybackControl bool                `json:"publicPlaybackControl"`
	Members               map[string]struct{} `json:"-"`
	EmptySince            time.Time           `json:"-"`
	Playback              PlaybackState       `json:"playback"`
}

func NewRoom(joinCode, hostID string) *Room {
	return &Room{
		JoinCode:   joinCode,
		HostID:     hostID,
		Members:    make(map[string]struct{}),
		EmptySince: time.Now(),
		Playback: PlaybackState{
			Paused:       true,
			PlaybackRate: 1,
		},
	}
}
