package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/glebarez/sqlite"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

// --- POLICY DATABASE MODELS ---
type User struct {
	gorm.Model
	Username string `gorm:"unique"`
	Password string
	Role     string
	Email    string
	IsFrozen bool // Tracks if the account is locked
}

type TargetServer struct {
	gorm.Model
	Name      string `gorm:"unique"`
	IPAddress string
}

type SessionRequest struct {
	gorm.Model
	GrantID   string `gorm:"unique"`
	Username  string
	Target    string
	RoleScope string
	Status    string // "pending", "approved", "denied", "completed", "terminated", "expired"
	ExpiresAt string
}

var db *gorm.DB

func main() {
	initDB()

	// Start the Background Auto-Expiry Worker
	go enforceSessionExpirations()

	// User & Login Endpoints
	http.HandleFunc("/login", loginHandler)
	http.HandleFunc("/admin/add_user", addUserHandler)
	http.HandleFunc("/admin/users", listUsersHandler)
	http.HandleFunc("/admin/delete_user", deleteUserHandler)
	http.HandleFunc("/admin/freeze_user", toggleFreezeUserHandler)

	// Server Endpoints
	http.HandleFunc("/admin/servers", listServersHandler)
	http.HandleFunc("/admin/add_server", addServerHandler)
	http.HandleFunc("/admin/delete_server", deleteServerHandler)

	// Session & Approval Endpoints
	http.HandleFunc("/request_access", requestAccessHandler)
	http.HandleFunc("/admin/pending_requests", listPendingRequestsHandler)
	http.HandleFunc("/admin/approve_request", handleApprovalHandler)
	http.HandleFunc("/check_status", checkStatusHandler)

	// NEW: Active Sessions & Kill Switch Endpoints
	http.HandleFunc("/admin/active_sessions", activeSessionsHandler)
	http.HandleFunc("/admin/terminate_session", terminateSessionHandler)

	// History & Audit Endpoints
	http.HandleFunc("/employee/history", employeeHistoryHandler)
	http.HandleFunc("/admin/audit_history", adminAuditHistoryHandler)

	http.HandleFunc("/admin/delete_audit_record", deleteAuditRecordHandler)
	http.HandleFunc("/admin/delete_audit_db", deleteAuditDbHandler)

	fmt.Println("Policy Engine listening on :8080")
	log.Fatal(http.ListenAndServe(":8080", nil))
}

func initDB() {
	var err error
	
	// Check if the cloud host provided a Postgres URL
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
    
    // ... keep the rest of your AutoMigrate and Admin creation code exactly the same ...

	// Auto-migrate tables
	err = db.AutoMigrate(&User{}, &TargetServer{}, &SessionRequest{})
	if err != nil {
		log.Fatal("Failed to migrate database:", err)
	}

	fmt.Println("Policy Database initialized successfully!")

	var count int64
	db.Model(&User{}).Count(&count)
	if count == 0 {
		db.Create(&User{Username: "admin", Password: "admin123", Role: "admin", Email: "admin@pam.local", IsFrozen: false})
		fmt.Println("Default Admin account created (admin / admin123)")
	}
}

// --- BACKGROUND WORKERS ---

// enforceSessionExpirations checks the database every 60 seconds and marks expired sessions
func enforceSessionExpirations() {
	for {
		time.Sleep(1 * time.Minute)
		now := time.Now().UTC().Format(time.RFC3339)
		
		// Find any approved session where the current time is past ExpiresAt
		db.Model(&SessionRequest{}).
			Where("status = ? AND expires_at < ?", "approved", now).
			Update("status", "expired")
	}
}

// --- HANDLERS ---

func loginHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	if r.Method == "OPTIONS" {
		return
	}

	var creds User
	json.NewDecoder(r.Body).Decode(&creds)

	var user User
	if err := db.Where("username = ? AND password = ?", creds.Username, creds.Password).First(&user).Error; err != nil {
		http.Error(w, "Invalid credentials", http.StatusUnauthorized)
		return
	}

	if user.IsFrozen {
		http.Error(w, "Account frozen", http.StatusForbidden)
		return
	}

	json.NewEncoder(w).Encode(map[string]interface{}{
		"status": "success",
		"user": map[string]string{
			"username": user.Username,
			"role":     user.Role,
		},
	})
}

func listUsersHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Content-Type", "application/json")
	var users []User
	db.Find(&users)

	var safeUsers []map[string]interface{}
	for _, u := range users {
		safeUsers = append(safeUsers, map[string]interface{}{
			"id":        u.ID,
			"username":  u.Username,
			"role":      u.Role,
			"email":     u.Email,
			"is_frozen": u.IsFrozen,
		})
	}
	json.NewEncoder(w).Encode(safeUsers)
}

func addUserHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	var newUser User
	json.NewDecoder(r.Body).Decode(&newUser)
	db.Create(&newUser)
	json.NewEncoder(w).Encode(map[string]string{"status": "user_created"})
}

func deleteUserHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	id := r.URL.Query().Get("id")
	db.Unscoped().Delete(&User{}, id)
	json.NewEncoder(w).Encode(map[string]string{"status": "deleted"})
}

func toggleFreezeUserHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	var body struct {
		ID uint `json:"id"`
	}
	json.NewDecoder(r.Body).Decode(&body)

	var user User
	if err := db.First(&user, body.ID).Error; err == nil {
		db.Model(&user).Update("is_frozen", !user.IsFrozen)
	}
	json.NewEncoder(w).Encode(map[string]string{"status": "toggled"})
}

func listServersHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	var servers []TargetServer
	db.Find(&servers)
	json.NewEncoder(w).Encode(servers)
}

func addServerHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	var newServer TargetServer
	json.NewDecoder(r.Body).Decode(&newServer)
	db.Create(&newServer)
	json.NewEncoder(w).Encode(map[string]string{"status": "server_added"})
}

func deleteServerHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	id := r.URL.Query().Get("id")
	db.Unscoped().Delete(&TargetServer{}, id)
	json.NewEncoder(w).Encode(map[string]string{"status": "deleted"})
}

func requestAccessHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	var req SessionRequest
	json.NewDecoder(r.Body).Decode(&req)
	req.Status = "pending"
	db.Create(&req)
	json.NewEncoder(w).Encode(map[string]string{"status": "pending_approval"})
}

func listPendingRequestsHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	var requests []SessionRequest
	db.Where("status = ?", "pending").Find(&requests)
	json.NewEncoder(w).Encode(requests)
}

func handleApprovalHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	var body struct {
		GrantID string `json:"grant_id"`
		Action  string `json:"action"`
	}
	json.NewDecoder(r.Body).Decode(&body)

	newStatus := "denied"
	if body.Action == "approve" {
		newStatus = "approved"
	}
	db.Model(&SessionRequest{}).Where("grant_id = ?", body.GrantID).Update("status", newStatus)
	json.NewEncoder(w).Encode(map[string]string{"status": newStatus})
}

func checkStatusHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	grantID := r.URL.Query().Get("grant_id")
	var req SessionRequest
	if err := db.Where("grant_id = ?", grantID).First(&req).Error; err != nil {
		http.Error(w, "Not found", http.StatusNotFound)
		return
	}
	json.NewEncoder(w).Encode(req)
}

// --- NEW: KILL SWITCH & ACTIVE SESSIONS HANDLERS ---

func activeSessionsHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	var activeRequests []SessionRequest
	// We consider 'approved' sessions as currently valid/active
	db.Where("status = ?", "approved").Find(&activeRequests)
	
	// Map to lower case json struct names expected by React
	var mapped []map[string]interface{}
	for _, req := range activeRequests {
		mapped = append(mapped, map[string]interface{}{
			"grant_id":   req.GrantID,
			"username":   req.Username,
			"target":     req.Target,
			"expires_at": req.ExpiresAt,
		})
	}
	json.NewEncoder(w).Encode(mapped)
}

func terminateSessionHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	if r.Method == "OPTIONS" {
		return
	}

	grantID := r.URL.Query().Get("grant_id")
	if grantID == "" {
		http.Error(w, "missing grant_id", http.StatusBadRequest)
		return
	}

	// 1. Mark as terminated in the database to prevent reconnects
	db.Model(&SessionRequest{}).Where("grant_id = ?", grantID).Update("status", "terminated")

	// 2. Alert the Rust Gateway to sever the live SSH WebSocket connection immediately
	// (Spins off in a goroutine so it doesn't block the UI response)
	go func() {
		client := &http.Client{Timeout: 5 * time.Second}
		req, _ := http.NewRequest("POST", "http://127.0.0.1:8443/terminate?grant_id="+grantID, nil)
		client.Do(req)
	}()

	json.NewEncoder(w).Encode(map[string]string{"status": "session_terminated"})
}

// --- HISTORY & AUDIT ---

func employeeHistoryHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	username := r.URL.Query().Get("username")
	var history []SessionRequest
	db.Where("username = ? AND status IN ?", username, []string{"approved", "completed", "terminated", "expired"}).Find(&history)
	json.NewEncoder(w).Encode(history)
}

func adminAuditHistoryHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	var history []SessionRequest
	db.Where("status IN ?", []string{"approved", "completed", "terminated", "expired"}).Find(&history)
	json.NewEncoder(w).Encode(history)
}
// Deletes the session record from the SQLite database
func deleteAuditRecordHandler(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Access-Control-Allow-Origin", "*")
    w.Header().Set("Access-Control-Allow-Methods", "DELETE, OPTIONS")

    if r.Method == "OPTIONS" { return }

    grantID := r.URL.Query().Get("grant_id")
    if grantID == "" {
        http.Error(w, "Missing grant ID", http.StatusBadRequest)
        return
    }

    // Delete the record from the SessionRequest table
    db.Where("grant_id = ?", grantID).Delete(&SessionRequest{})
    json.NewEncoder(w).Encode(map[string]string{"status": "deleted_from_db"})
}
// Deletes the session record permanently from SQLite
func deleteAuditDbHandler(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Access-Control-Allow-Origin", "*")
    w.Header().Set("Access-Control-Allow-Methods", "DELETE, OPTIONS")
    w.Header().Set("Content-Type", "application/json")
    
    if r.Method == "OPTIONS" { return }
    
    grantID := r.URL.Query().Get("grant_id")
    if grantID == "" {
        http.Error(w, "Missing grant ID", http.StatusBadRequest)
        return
    }
    
    // Delete the record from the SessionRequest table
    if err := db.Unscoped().Where("grant_id = ?", grantID).Delete(&SessionRequest{}).Error; err != nil {
        http.Error(w, "Failed to delete from database", http.StatusInternalServerError)
        return
    }
    
    json.NewEncoder(w).Encode(map[string]string{"status": "db_record_deleted"})
}