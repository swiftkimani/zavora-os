//! WebSocket voice streaming — mic PCM in, Suzy PCM out; with the camera channel on, JSON
//! `frame` messages in (forwarded to the model, never stored or logged) and `ui_gesture` tool
//! calls out (M10-T5, `crate::voice::camera`).

use axum::{
    extract::{Query, State, WebSocketUpgrade, ws},
    response::IntoResponse,
    Json,
};
use base64::Engine as _;
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use tokio::sync::mpsc;
use tracing::{error, info, warn};

use adk_realtime::events::ServerEvent;

use crate::state::AppState;

#[derive(Serialize)]
pub struct VoiceStatus {
    pub enabled: bool,
    pub ws_path: &'static str,
    pub input_rate_hz: u32,
    pub output_rate_hz: u32,
    /// Camera channel available on this websocket (`ZAVORA_CAMERA`, needs voice).
    pub camera: bool,
}

pub async fn status(State(state): State<AppState>) -> Json<VoiceStatus> {
    Json(VoiceStatus {
        enabled: state.voice.enabled,
        ws_path: "/ws/voice",
        input_rate_hz: 16_000,
        output_rate_hz: 24_000,
        camera: state.voice.camera,
    })
}

#[derive(Deserialize)]
pub struct VoiceWsQuery {
    pub session_id: Option<String>,
}

pub async fn ws_voice(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Query(query): Query<VoiceWsQuery>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_voice_ws(socket, state, query.session_id))
}

async fn handle_voice_ws(socket: ws::WebSocket, state: AppState, session_id: Option<String>) {
    if !state.voice.enabled {
        let mut socket = socket;
        let _ = socket
            .send(ws::Message::Text(
                serde_json::json!({
                    "type": "error",
                    "message": "Voice unavailable — set GOOGLE_API_KEY"
                })
                .to_string()
                .into(),
            ))
            .await;
        return;
    }

    let (mut ws_sender, mut ws_receiver) = socket.split();

    let runner = match crate::voice::realtime::build_suzy_runner(&state, session_id.clone()).await {
        Ok(r) => std::sync::Arc::new(r),
        Err(e) => {
            error!("voice runner init failed: {e:#}");
            let _ = ws_sender
                .send(ws::Message::Text(
                    serde_json::json!({"type": "error", "message": format!("Init failed: {e}")})
                        .to_string()
                        .into(),
                ))
                .await;
            return;
        }
    };

    if let Err(e) = runner.connect().await {
        error!("Gemini Live connect failed: {e}");
        let _ = ws_sender
            .send(ws::Message::Text(
                serde_json::json!({"type": "error", "message": format!("Connect failed: {e}")})
                    .to_string()
                    .into(),
            ))
            .await;
        return;
    }

    info!("Gemini Live voice session connected");
    // The UI session this voice session belongs to — the id the client keeps and submits intents
    // with. The realtime runner has an id of its own that is not a UI session; sending that as
    // `session_id` made every intent raised from voice (submit_intent, camera gestures) a 404.
    let ui_session_id = match session_id.as_deref() {
        Some(sid) if state.sessions.get(sid).await.is_some() => sid.to_string(),
        _ => state.sessions.create().await.session_id,
    };
    let _ = ws_sender
        .send(ws::Message::Text(
            serde_json::json!({
                "type": "connected",
                "session_id": ui_session_id,
                "runner_session_id": runner.session_id().await,
                "camera": state.voice.camera
            })
            .to_string()
            .into(),
        ))
        .await;

    let (tx, mut rx) = mpsc::channel::<ws::Message>(64);

    // Look tick bookkeeping (M10-T5): frames since the last look, when audio last arrived,
    // whether the model is mid-response, and whether the session is over.
    let frames_pending = Arc::new(AtomicU32::new(0));
    let last_audio: Arc<Mutex<Option<Instant>>> = Arc::new(Mutex::new(None));
    let responding = Arc::new(AtomicBool::new(false));
    let closed = Arc::new(AtomicBool::new(false));

    let runner_send = runner.clone();
    let mut frame_gate = crate::voice::camera::FrameGate::new(state.voice.camera);
    let tx_frames = tx.clone();
    let (frames_pending_s, last_audio_s, closed_s) = (frames_pending.clone(), last_audio.clone(), closed.clone());
    let send_handle = tokio::spawn(async move {
        while let Some(Ok(msg)) = ws_receiver.next().await {
            match msg {
                ws::Message::Binary(data) => {
                    *last_audio_s.lock().unwrap() = Some(Instant::now());
                    let audio_b64 =
                        base64::engine::general_purpose::STANDARD.encode(&data);
                    if runner_send.send_audio(&audio_b64).await.is_err() {
                        break;
                    }
                }
                ws::Message::Text(text) => {
                    if let Ok(msg) = serde_json::from_str::<serde_json::Value>(&text) {
                        match msg.get("type").and_then(|t| t.as_str()) {
                            Some("text") => {
                                if let Some(content) = msg.get("content").and_then(|c| c.as_str())
                                {
                                    let _ = runner_send.send_text(content).await;
                                    let _ = runner_send.create_response().await;
                                }
                            }
                            Some("commit_audio") => {
                                let _ = runner_send.commit_audio().await;
                            }
                            Some("create_response") => {
                                let _ = runner_send.create_response().await;
                            }
                            Some("interrupt") => {
                                let _ = runner_send.interrupt().await;
                            }
                            Some("frame") => {
                                // Camera frame: admit, forward, forget. The payload is never logged.
                                let mime = msg.get("mime").and_then(|m| m.as_str()).unwrap_or("");
                                let data = msg.get("data").and_then(|d| d.as_str()).unwrap_or("");
                                match frame_gate.check(mime, data, std::time::Instant::now()) {
                                    Ok(()) => {
                                        if runner_send.send_video_frame(mime, data).await.is_err() {
                                            break;
                                        }
                                        frames_pending_s.fetch_add(1, Ordering::Relaxed);
                                    }
                                    Err(crate::voice::camera::FrameReject::TooFast) => {}
                                    Err(reason) => {
                                        let _ = tx_frames
                                            .send(ws::Message::Text(
                                                serde_json::json!({"type": "frame_rejected", "reason": reason.as_str()})
                                                    .to_string()
                                                    .into(),
                                            ))
                                            .await;
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                }
                ws::Message::Close(_) => break,
                _ => {}
            }
        }
        if frame_gate.accepted + frame_gate.rejected > 0 {
            tracing::debug!(accepted = frame_gate.accepted, rejected = frame_gate.rejected, "camera frames relayed");
        }
        closed_s.store(true, Ordering::Relaxed);
    });

    let runner_recv = runner.clone();
    let (responding_r, closed_r) = (responding.clone(), closed.clone());
    let recv_handle = tokio::spawn(async move {
        loop {
            match runner_recv.next_event().await {
                Some(Ok(event)) => {
                    match &event {
                        ServerEvent::AudioDelta { .. } | ServerEvent::TextDelta { .. } => responding_r.store(true, Ordering::Relaxed),
                        ServerEvent::ResponseDone { .. } | ServerEvent::Error { .. } => responding_r.store(false, Ordering::Relaxed),
                        _ => {}
                    }
                    let ws_msg = match &event {
                        ServerEvent::AudioDelta { delta, .. } => {
                            Some(ws::Message::Binary(delta.clone().into()))
                        }
                        ServerEvent::TextDelta { delta, .. } => Some(ws::Message::Text(
                            serde_json::json!({"type": "text_delta", "content": delta})
                                .to_string()
                                .into(),
                        )),
                        ServerEvent::TranscriptDelta { delta, .. } => Some(ws::Message::Text(
                            serde_json::json!({"type": "transcript", "content": delta})
                                .to_string()
                                .into(),
                        )),
                        ServerEvent::SpeechStarted { .. } => Some(ws::Message::Text(
                            serde_json::json!({"type": "speech_started"})
                                .to_string()
                                .into(),
                        )),
                        ServerEvent::SpeechStopped { .. } => Some(ws::Message::Text(
                            serde_json::json!({"type": "speech_stopped"})
                                .to_string()
                                .into(),
                        )),
                        ServerEvent::ResponseDone { .. } => Some(ws::Message::Text(
                            serde_json::json!({"type": "response_done"})
                                .to_string()
                                .into(),
                        )),
                        ServerEvent::FunctionCallDone { name, arguments, .. } => Some(
                            ws::Message::Text(
                                serde_json::json!({
                                    "type": "tool_call",
                                    "name": name,
                                    "arguments": arguments
                                })
                                .to_string()
                                .into(),
                            ),
                        ),
                        ServerEvent::Error { error, .. } => Some(ws::Message::Text(
                            serde_json::json!({"type": "error", "message": error.message})
                                .to_string()
                                .into(),
                        )),
                        _ => None,
                    };

                    if let Some(msg) = ws_msg {
                        if tx.send(msg).await.is_err() {
                            break;
                        }
                    }
                }
                Some(Err(e)) => {
                    warn!("Gemini voice stream error: {e}");
                    break;
                }
                None => break,
            }
        }
        closed_r.store(true, Ordering::Relaxed);
    });

    // Look tick: Gemini Live evaluates its input only when a turn ends, so while frames arrive
    // and nobody is speaking, ask it to check the latest frames (`camera::LOOK_PROMPT`).
    let look_handle = {
        let runner = runner.clone();
        let camera_on = state.voice.camera;
        tokio::spawn(async move {
            if !camera_on {
                return;
            }
            let mut tick = tokio::time::interval(crate::voice::camera::LOOK_INTERVAL);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tick.tick().await;
                if closed.load(Ordering::Relaxed) {
                    break;
                }
                if frames_pending.load(Ordering::Relaxed) == 0 || responding.load(Ordering::Relaxed) {
                    continue;
                }
                let talking = last_audio.lock().unwrap().is_some_and(|t| t.elapsed() < crate::voice::camera::SPEECH_GRACE);
                if talking {
                    continue;
                }
                frames_pending.store(0, Ordering::Relaxed);
                if runner.send_text(crate::voice::camera::LOOK_PROMPT).await.is_err() {
                    break;
                }
                let _ = runner.create_response().await;
            }
        })
    };

    let forward_handle = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if ws_sender.send(msg).await.is_err() {
                break;
            }
        }
    });

    tokio::select! {
        _ = send_handle => {}
        _ = recv_handle => {}
        _ = forward_handle => {}
    }
    look_handle.abort();

    let _ = runner.close().await;
    info!("voice websocket session closed");
}