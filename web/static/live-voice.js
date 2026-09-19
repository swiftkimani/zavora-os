/**
 * Gemini Live bridge — WS /ws/voice (mia pattern).
 * One Live session carries two independent inputs: the microphone (PCM up, Suzy's speech back)
 * and the camera (JPEG frames up about once a second, gestures back as `zavora:gesture`).
 * Either runs alone; the session opens with the first input and closes with the last.
 * Falls back to prerecorded clips + SpeechRecognition when Live is unavailable.
 */
(function () {
  'use strict';

  const INPUT_RATE = 16000;
  const OUTPUT_RATE = 24000;
  const FRAME_MS = 1000;
  const FRAME_W = 320;

  let enabled = false;
  let cameraEnabled = false;
  let ws = null;
  let connecting = null; // Promise<boolean> while the socket opens
  let sessionId = null;
  let onTranscript = null;
  let playbackCtx = null;

  // Microphone
  let micActive = false;
  let micStream = null;
  let captureCtx = null;
  let processor = null;

  // Camera — frames are drawn to a small canvas and sent as JPEG; nothing is kept.
  let cameraActive = false;
  let camStream = null;
  let videoEl = null;
  let canvasEl = null;
  let frameTimer = null;
  let framesSent = 0;

  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const q = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : '';
    return `${proto}//${location.host}/ws/voice${q}`;
  }

  function sessionOpen() {
    return !!ws && ws.readyState === WebSocket.OPEN;
  }

  function emit(name, detail) {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }

  function playPcm(buffer) {
    playbackCtx = playbackCtx || new AudioContext({ sampleRate: OUTPUT_RATE });
    if (playbackCtx.state === 'suspended') playbackCtx.resume();
    const pcm16 = new Int16Array(buffer);
    const f32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) f32[i] = pcm16[i] / 0x8000;
    const audioBuffer = playbackCtx.createBuffer(1, f32.length, OUTPUT_RATE);
    audioBuffer.copyToChannel(f32, 0);
    const src = playbackCtx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(playbackCtx.destination);
    src.start();
  }

  // ---- messages from the server ----------------------------------------------------------

  function handleMessage(ev) {
    if (typeof ev.data === 'string') {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (_) {
        return;
      }
      if (msg.type === 'connected' && msg.session_id) {
        sessionId = msg.session_id;
        try {
          sessionStorage.setItem('zavora_session_id', sessionId);
        } catch (_) {}
      }
      if (msg.type === 'connected' && typeof msg.camera === 'boolean') {
        cameraEnabled = enabled && msg.camera;
      }
      if (msg.type === 'transcript' && msg.content) {
        if (onTranscript) onTranscript(msg.content);
        emit('zavora:voice-transcript', { content: msg.content });
      }
      if (msg.type === 'response_done') {
        emit('zavora:voice-transcript', { done: true });
        // A session opened only to speak (greeting) has nothing left to do.
        if (!micActive && !cameraActive) closeSession();
      }
      if (msg.type === 'tool_call') {
        // adk-realtime forwards tool arguments as the raw JSON string the model produced.
        if (typeof msg.arguments === 'string') {
          try {
            msg.arguments = JSON.parse(msg.arguments);
          } catch (_) {
            msg.arguments = {};
          }
        }
      }
      if (msg.type === 'tool_call' && msg.name === 'submit_intent') {
        const sid = msg.arguments?.session_id || sessionId;
        if (sid) {
          sessionStorage.setItem('zavora_session_id', sid);
          sessionId = sid;
        }
        emit('zavora:voice-intent', { sessionId: sid, args: msg.arguments });
      }
      if (msg.type === 'tool_call' && msg.name === 'ui_gesture' && msg.arguments?.gesture) {
        emit('zavora:gesture', { gesture: msg.arguments.gesture });
      }
      if (msg.type === 'frame_rejected') {
        console.warn('live camera: frame rejected —', msg.reason);
        if (msg.reason === 'camera_off') stopCamera();
      }
      if (msg.type === 'error') {
        console.warn('live voice:', msg.message);
      }
      return;
    }
    if (ev.data instanceof ArrayBuffer) {
      playPcm(ev.data);
    } else if (ev.data instanceof Blob) {
      ev.data.arrayBuffer().then(playPcm);
    }
  }

  // ---- session -----------------------------------------------------------------------------

  function ensureSession(opts) {
    if (opts?.sessionId) sessionId = opts.sessionId;
    if (opts?.onTranscript) onTranscript = opts.onTranscript;
    if (!enabled) return Promise.resolve(false);
    if (sessionOpen()) return Promise.resolve(true);
    if (connecting) return connecting;
    connecting = new Promise((resolve) => {
      const sock = new WebSocket(wsUrl());
      sock.binaryType = 'arraybuffer';
      ws = sock;
      let settled = false;
      const settle = (ok) => {
        if (settled) return;
        settled = true;
        connecting = null;
        resolve(ok);
      };
      sock.onerror = () => {
        if (ws === sock) closeSession();
        settle(false);
      };
      sock.onclose = () => {
        if (ws === sock) {
          ws = null;
          stopMicCapture();
          stopCameraCapture();
        }
        settle(false);
      };
      sock.onmessage = handleMessage;
      sock.onopen = () => settle(true);
      setTimeout(() => {
        if (!settled) {
          try {
            sock.close();
          } catch (_) {}
          settle(false);
        }
      }, 8000);
    });
    return connecting;
  }

  function closeSession() {
    const sock = ws;
    ws = null;
    if (sock) {
      try {
        sock.close();
      } catch (_) {}
    }
    stopMicCapture();
    stopCameraCapture();
  }

  function maybeCloseSession() {
    if (!micActive && !cameraActive) closeSession();
  }

  // ---- microphone --------------------------------------------------------------------------

  async function startMicCapture() {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: INPUT_RATE, channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    captureCtx = new AudioContext({ sampleRate: INPUT_RATE });
    const source = captureCtx.createMediaStreamSource(micStream);
    processor = captureCtx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (e) => {
      if (!micActive || !sessionOpen()) return;
      const input = e.inputBuffer.getChannelData(0);
      const pcm16 = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      ws.send(pcm16.buffer);
    };
    source.connect(processor);
    processor.connect(captureCtx.destination);
  }

  function stopMicCapture() {
    const was = micActive;
    micActive = false;
    if (processor) {
      processor.disconnect();
      processor = null;
    }
    if (captureCtx) {
      captureCtx.close().catch(() => {});
      captureCtx = null;
    }
    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop());
      micStream = null;
    }
    if (was) emit('zavora:mic', { active: false });
  }

  /** Microphone on: the browser's permission prompt comes first (no deadline), then the session. */
  async function startMic(opts) {
    if (!enabled) return false;
    if (micActive) return true;
    try {
      await startMicCapture();
    } catch (e) {
      console.warn('live voice capture failed:', e);
      stopMicCapture();
      return false;
    }
    const ok = await ensureSession(opts);
    if (!ok) {
      stopMicCapture();
      return false;
    }
    micActive = true;
    emit('zavora:mic', { active: true });
    return true;
  }

  function stopMic() {
    stopMicCapture();
    maybeCloseSession();
  }

  // ---- camera ------------------------------------------------------------------------------

  async function startCameraCapture() {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 5, max: 10 }, facingMode: 'user' },
      audio: false,
    });
    videoEl = document.createElement('video');
    videoEl.muted = true;
    videoEl.playsInline = true;
    videoEl.srcObject = camStream;
    await videoEl.play();
    canvasEl = document.createElement('canvas');
  }

  function sendFrame() {
    if (!cameraActive || !sessionOpen() || !videoEl) return;
    const vw = videoEl.videoWidth;
    const vh = videoEl.videoHeight;
    if (!vw || !vh) return;
    canvasEl.width = FRAME_W;
    canvasEl.height = Math.max(1, Math.round((FRAME_W * vh) / vw));
    canvasEl.getContext('2d').drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);
    const url = canvasEl.toDataURL('image/jpeg', 0.6);
    const data = url.slice(url.indexOf(',') + 1);
    if (data) {
      ws.send(JSON.stringify({ type: 'frame', mime: 'image/jpeg', data }));
      framesSent++;
      emit('zavora:camera-frame', { count: framesSent });
    }
  }

  function stopCameraCapture() {
    const was = cameraActive;
    cameraActive = false;
    if (frameTimer) {
      clearInterval(frameTimer);
      frameTimer = null;
    }
    if (videoEl) {
      try {
        videoEl.pause();
        videoEl.srcObject = null;
      } catch (_) {}
      videoEl = null;
    }
    canvasEl = null;
    if (camStream) {
      camStream.getTracks().forEach((t) => t.stop());
      camStream = null;
    }
    if (was) emit('zavora:camera', { active: false });
  }

  /** Camera on, with or without the microphone: permission prompt first, then the session. */
  async function startCamera(opts) {
    if (!cameraEnabled) return false;
    if (cameraActive) return true;
    try {
      await startCameraCapture();
    } catch (e) {
      console.warn('live camera capture failed:', e);
      stopCameraCapture();
      return false;
    }
    const ok = await ensureSession(opts);
    if (!ok) {
      stopCameraCapture();
      return false;
    }
    cameraActive = true;
    framesSent = 0;
    frameTimer = setInterval(sendFrame, FRAME_MS);
    emit('zavora:camera', { active: true, stream: camStream });
    return true;
  }

  function stopCamera() {
    stopCameraCapture();
    maybeCloseSession();
  }

  // ---- speech only (greeting) --------------------------------------------------------------

  async function speakText(text) {
    if (!enabled) return false;
    const ok = await ensureSession({});
    if (!ok || !ws) return false;
    ws.send(JSON.stringify({ type: 'text', content: text }));
    return true;
  }

  async function probe() {
    try {
      const res = await fetch('/api/voice/status');
      if (!res.ok) return false;
      const data = await res.json();
      enabled = !!data.enabled;
      cameraEnabled = enabled && !!data.camera;
      return enabled;
    } catch (_) {
      enabled = false;
      cameraEnabled = false;
      return false;
    }
  }

  window.ZavoraLiveVoice = {
    probe,
    // microphone
    startMic,
    stopMic,
    isMicActive: () => micActive,
    // camera
    startCamera,
    stopCamera,
    isCameraEnabled: () => cameraEnabled,
    isCameraActive: () => cameraActive,
    // session
    speakText,
    isEnabled: () => enabled,
    isActive: () => sessionOpen(),
    // legacy names (mic)
    start: startMic,
    stop: stopMic,
  };

  probe();
})();
