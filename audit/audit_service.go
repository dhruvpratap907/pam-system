package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/glebarez/sqlite"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)
type SessionLog struct {
	ID        uint      `gorm:"primaryKey"`
	Username  string    `json:"username"`
	ServerIP  string    `json:"server_ip"`
	StartTime time.Time `json:"start_time"`
	EndTime   time.Time `json:"end_time"`
	LogFile   string    `json:"log_file"`
}

type AuditEvent struct {
	SessionID    string `json:"session_id"`
	GrantID      string `json:"grant_id"`
	Actor        string `json:"actor"`
	Action       string `json:"action"`
	Data         string `json:"data"`
	Timestamp    string `json:"timestamp"`
	PreviousHash string `json:"previous_hash"`
	CurrentHash  string `json:"current_hash"`
}

var (
	storeDir  = "./audit_logs"
	lastHash  string
	mu        sync.Mutex
	eventIter int64
)

func main() {
	// 1. Initialize Database with Cloud Fallback
	var err error
	var db *gorm.DB
	dsn := os.Getenv("DATABASE_URL")
	if dsn != "" {
		fmt.Println("Connecting to Cloud PostgreSQL...")
		db, err = gorm.Open(postgres.Open(dsn), &gorm.Config{})
	} else {
		fmt.Println("Connecting to Local SQLite...")
		db, err = gorm.Open(sqlite.Open("../pam_system.db"), &gorm.Config{})
	}

	if err != nil {
		log.Fatal("Failed to connect to database:", err)
	}

	err = db.AutoMigrate(&SessionLog{})
    
    // ... keep the rest of your main() function exactly the same ...

	// 1. Endpoint to RECEIVE logs from the Rust Gateway
	http.HandleFunc("/audit", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == "OPTIONS" { return }

		var evt AuditEvent
		if err := json.NewDecoder(r.Body).Decode(&evt); err != nil {
			http.Error(w, "Invalid payload", http.StatusBadRequest)
			return
		}

		if evt.Timestamp == "" {
			evt.Timestamp = time.Now().UTC().Format(time.RFC3339Nano)
		}

		mu.Lock()
		defer mu.Unlock()

		evt.PreviousHash = lastHash
		evt.CurrentHash = computeHash(lastHash, &evt)
		lastHash = evt.CurrentHash

		counter := atomic.AddInt64(&eventIter, 1)
		filename := filepath.Join(storeDir, fmt.Sprintf("audit_%d_%d.json", time.Now().UnixNano(), counter))
		
		data, _ := json.MarshalIndent(evt, "", "  ")
		if err := os.WriteFile(filename, data, 0644); err != nil {
			log.Println("Error writing audit log:", err)
			http.Error(w, "Failed to write log", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusCreated)
	})

	// 2. Endpoint to SEND logs to the React Web Dashboard
	http.HandleFunc("/audit/logs", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == "OPTIONS" { return }

		grantID := r.URL.Query().Get("grant_id")
		if grantID == "" {
			http.Error(w, "missing grant_id", http.StatusBadRequest)
			return
		}

		entries, err := os.ReadDir(storeDir)
		if err != nil {
			http.Error(w, "failed to read audit directory", http.StatusInternalServerError)
			return
		}

		sessionLogs := []AuditEvent{} 
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") { continue }
			data, err := os.ReadFile(filepath.Join(storeDir, entry.Name()))
			if err != nil { continue }
			
			var evt AuditEvent
			if err := json.Unmarshal(data, &evt); err == nil && evt.GrantID == grantID {
				sessionLogs = append(sessionLogs, evt)
			}
		}
		
		sort.Slice(sessionLogs, func(i, j int) bool {
			return sessionLogs[i].Timestamp < sessionLogs[j].Timestamp
		})
		json.NewEncoder(w).Encode(sessionLogs)
	})

	// 3. Endpoint to DELETE logs for a specific grant_id
	// FIX: Route updated to /audit/delete to avoid Vite proxy collisions
	http.HandleFunc("/audit/delete", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == "OPTIONS" { return }

		grantID := r.URL.Query().Get("grant_id")
		if grantID == "" {
			http.Error(w, "missing grant_id", http.StatusBadRequest)
			return
		}

		entries, err := os.ReadDir(storeDir)
		if err != nil {
			http.Error(w, "failed to read audit directory", http.StatusInternalServerError)
			return
		}

		mu.Lock()
		defer mu.Unlock()

		deletedCount := 0
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") { continue }
			filePath := filepath.Join(storeDir, entry.Name())
			data, err := os.ReadFile(filePath)
			if err != nil { continue }
			
			var evt AuditEvent
			if err := json.Unmarshal(data, &evt); err == nil && evt.GrantID == grantID {
				if err := os.Remove(filePath); err == nil {
					deletedCount++
				}
			}
		}

		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]interface{}{"deleted": deletedCount})
	})

	log.Println("Audit Service listening on :9090")
	log.Fatal(http.ListenAndServe(":9090", nil))
}

func computeHash(previous string, evt *AuditEvent) string {
	h := sha256.New()
	h.Write([]byte(previous))
	h.Write([]byte(evt.SessionID))
	h.Write([]byte(evt.GrantID))
	h.Write([]byte(evt.Actor))
	h.Write([]byte(evt.Action))
	h.Write([]byte(evt.Data))
	h.Write([]byte(evt.Timestamp))
	return hex.EncodeToString(h.Sum(nil))
}