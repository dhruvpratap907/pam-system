use std::collections::HashMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::time::{SystemTime, UNIX_EPOCH};
use std::io::{Read, Write};
use std::sync::mpsc;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::sync::oneshot;
use hyper::service::{make_service_fn, service_fn};
use hyper::{Body, Method, Request, Response, Server, StatusCode};
use serde::{Deserialize, Serialize};
use tracing::{error, info};
use futures_util::{StreamExt, SinkExt};
use hyper_tungstenite::{is_upgrade_request, upgrade, tungstenite::Message};
use ssh2::Session;

// --- NEW: SESSION REGISTRY ---
// This keeps track of all active sessions and holds their "Kill Switch" triggers
type SessionRegistry = Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>;

#[derive(Clone)]
struct AppState {
    cfg: ProxyConfig,
    sessions: SessionRegistry,
}

#[derive(Debug, Serialize, Deserialize)]
struct Grant {
    grant_id: String,
    user_subject: String,
    target: String,
    role_scope: String,
    expires_at: String,
    requested_at: String,
    device_trust: String,
    network_cidr: String,
    ticket_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct VaultSecret {
    data: VaultOuterData,
}

#[derive(Debug, Serialize, Deserialize)]
struct VaultOuterData {
    data: VaultSecretData,
}

#[derive(Debug, Serialize, Deserialize)]
struct VaultSecretData {
    username: Option<String>,
    password: Option<String>,
    ssh_key: Option<String>,
    token: Option<String>,
    host: Option<String>,
    port: Option<String>, 
}

#[derive(Debug, Clone)]
struct ProxyConfig {
    bind_addr: SocketAddr,
    policy_engine_url: String,
    vault_url: String,
    vault_token: String,
    tls_ca_cert: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing_subscriber::fmt::init();
    
    let state = AppState {
        cfg: ProxyConfig {
            // Updated to use Render's dynamic port and accept public connections
            bind_addr: format!("0.0.0.0:{}", std::env::var("PORT").unwrap_or_else(|_| "8443".to_string()))
                .parse()
                .expect("Invalid bind address"),
            
            // Updated to securely grab your Cloud URL with a local laptop fallback
            policy_engine_url: std::env::var("POLICY_URL").unwrap_or_else(|_| "http://127.0.0.1:8080".to_string()),
            
            vault_url: "http://127.0.0.1:8200".to_string(),
            vault_token: "root".to_string(),
            tls_ca_cert: "none".to_string(),
        },
        sessions: Arc::new(Mutex::new(HashMap::new())),
    };

    info!("Starting Zero Trust gateway on {}", state.cfg.bind_addr);
    let bind_addr = state.cfg.bind_addr; 

    let make_svc = make_service_fn(move |_| {
        let state = state.clone();
        async move {
            Ok::<_, Infallible>(service_fn(move |req| {
                let state = state.clone();
                async move {
                    match handle_proxy(req, state).await {
                        Ok(response) => Ok::<_, Infallible>(response),
                        Err(e) => {
                            error!("Proxy error: {}", e);
                            let resp = Response::builder()
                                .status(StatusCode::INTERNAL_SERVER_ERROR)
                                .body(Body::from(format!("Internal Server Error: {}", e)))
                                .unwrap();
                            Ok::<_, Infallible>(resp)
                        }
                    }
                }
            }))
        }
    });

    let server = Server::bind(&bind_addr).serve(make_svc);
    if let Err(e) = server.await {
        error!("gateway server error: {}", e);
        return Err(Box::new(e) as Box<dyn std::error::Error + Send + Sync>);
    }
    Ok(())
}

async fn handle_proxy(
    req: Request<Body>,
    state: AppState,
) -> Result<Response<Body>, Box<dyn std::error::Error + Send + Sync>> {
    let method = req.method().clone();
    let uri = req.uri().clone();

    // --- NEW: TERMINATE SESSION ENDPOINT (KILL SWITCH) ---
    if method == Method::POST && uri.path() == "/terminate" {
        let query = uri.query().unwrap_or("");
        let mut grant_id_val = String::new();
        for pair in query.split('&') {
            let parts: Vec<&str> = pair.split('=').collect();
            if parts.len() == 2 && parts[0] == "grant_id" {
                grant_id_val = parts[1].to_string();
            }
        }

        let mut sessions = state.sessions.lock().await;
        // If the session exists, pull the trigger to drop the connection instantly
        if let Some(kill_tx) = sessions.remove(&grant_id_val) {
            let _ = kill_tx.send(());
            info!("⚡ KILL SWITCH ACTIVATED: Session {} forcefully terminated by Admin.", grant_id_val);
        }

        let response = Response::builder().status(StatusCode::OK).body(Body::from("Terminated"))?;
        return Ok(response);
    }

    // --- WEBSOCKET UPGRADE LOGIC ---
    if is_upgrade_request(&req) && uri.path() == "/ws" {
        let query = uri.query().unwrap_or("");
        let mut target = String::new();
        let mut grant_id_val = String::from("ws-session");

        for pair in query.split('&') {
            let parts: Vec<&str> = pair.split('=').collect();
            if parts.len() == 2 {
                if parts[0] == "target" { target = parts[1].to_string(); }
                if parts[0] == "grant_id" { grant_id_val = parts[1].to_string(); }
            }
        }

        let (response, websocket) = upgrade(req, None)?;
        
        // Register the new session and its kill switch
        let (kill_tx, kill_rx) = oneshot::channel();
        state.sessions.lock().await.insert(grant_id_val.clone(), kill_tx);

        let state_clone = state.clone();
        let grant_id_clone = grant_id_val.clone();
        
        tokio::spawn(async move {
            match websocket.await {
                Ok(ws) => {
                    if let Err(e) = handle_websocket_ssh(ws, state_clone.cfg.clone(), target, grant_id_clone.clone(), kill_rx).await {
                        error!("WebSocket SSH error: {}", e);
                    }
                }
                Err(e) => error!("WebSocket upgrade error: {}", e),
            }
            // Cleanup the registry when the session naturally ends
            state_clone.sessions.lock().await.remove(&grant_id_clone);
        });

        return Ok(response);
    }

    // --- SESSION POST LOGIC ---
    if method == Method::POST && uri.path() == "/session" {
        let body = hyper::body::to_bytes(req.into_body()).await?;
        let grant: Grant = serde_json::from_slice(&body)?;
        verify_grant(&grant).await?;
        let _secret = fetch_dynamic_secret_from_vault(&state.cfg, &grant).await?;
        
        let response = Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_string(&serde_json::json!({
                "status": "session_started",
                "grant_id": grant.grant_id,
                "target": grant.target,
                "expires_at": grant.expires_at
            }))?))?;
        return Ok(response);
    }

    let target_addr = format!("{}:{}", uri.host().unwrap_or("localhost"), uri.port_u16().unwrap_or(443));
    Ok(Response::new(Body::from("proxying to target")))
}

async fn verify_grant(grant: &Grant) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs() as i64;
    let expires = chrono::DateTime::parse_from_rfc3339(&grant.expires_at)?.timestamp();
    if expires <= now { return Err("grant expired".into()); }
    if grant.grant_id.trim().is_empty() { return Err("missing grant id".into()); }
    Ok(())
}

async fn fetch_dynamic_secret_from_vault(
    cfg: &ProxyConfig,
    grant: &Grant,
) -> Result<VaultSecret, Box<dyn std::error::Error + Send + Sync>> {
    let client = reqwest::Client::builder().danger_accept_invalid_certs(true).use_rustls_tls().build()?;
    let vault_path = format!("{}/v1/secret/data/targets/{}", cfg.vault_url.trim_end_matches('/'), grant.target);
    let req = client.get(&vault_path).header("X-Vault-Token", &cfg.vault_token).header("Content-Type", "application/json");
    let resp = req.send().await?;
    let status = resp.status();
    if !status.is_success() { return Err(format!("Vault fetch failed: {}", status).into()); }
    let secret: VaultSecret = resp.json().await?;
    Ok(secret)
}

// 3. THE MAGIC TERMINAL BRIDGE
async fn handle_websocket_ssh(
    ws: tokio_tungstenite::WebSocketStream<hyper::upgrade::Upgraded>,
    cfg: ProxyConfig,
    target: String,
    grant_id_str: String,
    mut kill_rx: oneshot::Receiver<()>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    info!("Establishing Zero Trust SSH proxy for target: {}", target);

    let grant = Grant {
        grant_id: grant_id_str.clone(), user_subject: "browser".into(), target: target.clone(), role_scope: "employee".into(),
        expires_at: "2027-01-01T00:00:00Z".into(), requested_at: "now".into(), device_trust: "trusted".into(),
        network_cidr: "127.0.0.1/32".into(), ticket_id: "TICKET".into(),
    };
    let secret = fetch_dynamic_secret_from_vault(&cfg, &grant).await?;
    let host = secret.data.data.host.unwrap_or_else(|| "127.0.0.1".to_string());
    let port = secret.data.data.port.unwrap_or_else(|| "22".to_string());
    let username = secret.data.data.username.unwrap_or_else(|| "root".to_string());
    let password = secret.data.data.password.unwrap_or_default();

    let (mut ws_tx, mut ws_rx) = ws.split();
    let (key_tx, key_rx) = mpsc::channel::<Vec<u8>>();
    let (screen_tx, mut screen_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(1024);

    // Thread 1: Listen for browser keystrokes AND Admin Kill Switch Signal
    tokio::spawn(async move {
        loop {
            tokio::select! {
                // If the Admin fires the Kill Switch, this channel drops instantly
                _ = &mut kill_rx => {
                    info!("Kill signal received. Dropping WebSocket.");
                    break;
                }
                msg = ws_rx.next() => {
                    match msg {
                        Some(Ok(Message::Text(t))) => { let _ = key_tx.send(t.into_bytes()); }
                        Some(Ok(Message::Binary(b))) => { let _ = key_tx.send(b); }
                        Some(Err(_)) | None => break, // Browser closed normally
                        _ => {}
                    }
                }
            }
        }
    });

    // Thread 2: Screen output to browser
    tokio::spawn(async move {
        while let Some(data) = screen_rx.recv().await {
            if let Ok(text) = String::from_utf8(data) {
                let _ = ws_tx.send(Message::Text(text)).await;
            }
        }
    });

    // Thread 3: Blocking SSH session
    tokio::task::spawn_blocking(move || {
        let result = (|| -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
            let tcp = std::net::TcpStream::connect(format!("{}:{}", host, port))?;
            let mut sess = Session::new()?;
            sess.set_tcp_stream(tcp);
            sess.handshake()?;
            sess.userauth_password(&username, &password)?;

            let mut channel = sess.channel_session()?;
            channel.request_pty("xterm", None, None)?;
            channel.shell()?;
            sess.set_blocking(false);

            let mut buffer = [0; 4096];
            loop {
                if let Ok(n) = channel.read(&mut buffer) {
                    if n > 0 { let _ = screen_tx.blocking_send(buffer[0..n].to_vec()); }
                }
                
                // If the Kill Switch drops the channels in Thread 1, this try_recv will return an Error, instantly snapping the SSH tunnel
                match key_rx.try_recv() {
                    Ok(keys) => { let _ = channel.write_all(&keys); }
                    Err(mpsc::TryRecvError::Disconnected) => break,
                    Err(mpsc::TryRecvError::Empty) => {} 
                }

                if channel.eof() { break; }
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            Ok(())
        })();
        if let Err(e) = result {
            error!("SSH Tunnel execution failed: {}", e);
        }
    });

    Ok(())
}