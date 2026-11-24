package metrics

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

var (
	activeConnections atomic.Int64
	roomsCreatedTotal atomic.Int64
	ticketsClaimed    atomic.Int64

	dauMu   sync.Mutex
	dauDay  string
	dauSalt [32]byte
	dauSeen map[[32]byte]struct{}
	nowFunc = time.Now
)

func rotateLocked(now time.Time) {
	day := now.UTC().Format("2006-01-02")
	if dauDay == day && dauSeen != nil {
		return
	}
	if _, err := rand.Read(dauSalt[:]); err != nil {
		panic(err)
	}
	dauDay = day
	dauSeen = make(map[[32]byte]struct{})
}

// RecordActiveUser counts a unique user for the current UTC day using an
// in-memory salted hash of clientIP. The salt and set reset every UTC day.
func RecordActiveUser(clientIP string) {
	ip := strings.TrimSpace(clientIP)
	if ip == "" {
		return
	}
	dauMu.Lock()
	defer dauMu.Unlock()

	rotateLocked(nowFunc())

	h := sha256.New()
	h.Write(dauSalt[:])
	h.Write([]byte(ip))
	var digest [32]byte
	h.Sum(digest[:0])
	dauSeen[digest] = struct{}{}
}

func DAU() int {
	dauMu.Lock()
	defer dauMu.Unlock()
	rotateLocked(nowFunc())
	return len(dauSeen)
}

func IncConnections()    { activeConnections.Add(1) }
func DecConnections()    { activeConnections.Add(-1) }
func IncRoomsCreated()   { roomsCreatedTotal.Add(1) }
func IncTicketsClaimed() { ticketsClaimed.Add(1) }

func LoadOrGenerateAPIKey(envKey, filePath string) (string, bool, error) {
	if k := strings.TrimSpace(envKey); k != "" {
		return k, false, nil
	}
	path := strings.TrimSpace(filePath)
	if path == "" {
		return "", false, nil
	}
	if b, err := os.ReadFile(path); err == nil {
		if k := strings.TrimSpace(string(b)); k != "" {
			return k, false, nil
		}
	} else if !os.IsNotExist(err) {
		return "", false, err
	}

	var buf [32]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", false, err
	}
	key := hex.EncodeToString(buf[:])
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", false, err
	}
	if err := os.WriteFile(path, []byte(key+"\n"), 0o600); err != nil {
		return "", false, err
	}
	return key, true, nil
}

func bearerToken(r *http.Request) string {
	scheme, token, ok := strings.Cut(r.Header.Get("Authorization"), " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") {
		return ""
	}
	return strings.TrimSpace(token)
}

func Handler(activeRooms func() int, apiKey string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if apiKey == "" || subtle.ConstantTimeCompare([]byte(bearerToken(r)), []byte(apiKey)) != 1 {
			w.Header().Set("WWW-Authenticate", "Bearer")
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		rooms := 0
		if activeRooms != nil {
			rooms = activeRooms()
		}
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		_, _ = fmt.Fprintf(w,
			"# HELP ytsync_dau Daily active unique users (UTC day, salted in-memory hash).\n"+
				"# TYPE ytsync_dau gauge\n"+
				"ytsync_dau %d\n"+
				"# HELP ytsync_active_rooms Current number of active non-expired rooms.\n"+
				"# TYPE ytsync_active_rooms gauge\n"+
				"ytsync_active_rooms %d\n"+
				"# HELP ytsync_active_connections Current number of authenticated WebSocket connections.\n"+
				"# TYPE ytsync_active_connections gauge\n"+
				"ytsync_active_connections %d\n"+
				"# HELP ytsync_rooms_created_total Total number of rooms created since server start.\n"+
				"# TYPE ytsync_rooms_created_total counter\n"+
				"ytsync_rooms_created_total %d\n"+
				"# HELP ytsync_tickets_claimed_total Total number of session tickets claimed since server start.\n"+
				"# TYPE ytsync_tickets_claimed_total counter\n"+
				"ytsync_tickets_claimed_total %d\n",
			DAU(),
			rooms,
			activeConnections.Load(),
			roomsCreatedTotal.Load(),
			ticketsClaimed.Load(),
		)
	})
}
