/**
 * Camera window (M10-T5): shows what the camera sends and what comes back — the live feed,
 * frames sent, the last gesture Suzy recognised and what it did, and her spoken reply.
 * Listens to the events live-voice.js and gestures.js emit; never touches the frames.
 */
(function () {
  'use strict';

  const EFFECT = {
    swipe_left: '👉 swipe → Home world',
    swipe_right: '👈 swipe → Work world',
    open_palm: '✋ open palm → agents paused',
    wave: "👋 wave → today's briefing",
    pinch: '🤏 pinch → window closed',
  };

  let box = null, video = null, status = null, last = null;
  let reply = '', replyDone = false;

  function ensure() {
    if (box) return box;
    box = document.createElement('aside');
    box.className = 'cam-preview';
    box.setAttribute('aria-label', 'Camera — what Suzy sees');
    box.innerHTML =
      '<video autoplay muted playsinline></video>' +
      '<div class="cam-cap"><span class="cam-dot"></span><span class="cam-status">Suzy is watching</span></div>' +
      '<div class="cam-last">Try a wave, an open palm, or a swipe</div>';
    document.body.appendChild(box);
    video = box.querySelector('video');
    status = box.querySelector('.cam-status');
    last = box.querySelector('.cam-last');
    return box;
  }

  window.addEventListener('zavora:camera', (e) => {
    if (e.detail?.active) {
      ensure();
      video.srcObject = e.detail.stream;
      status.textContent = 'Suzy is watching';
      box.classList.add('on');
    } else if (box) {
      box.classList.remove('on');
      video.srcObject = null;
    }
  });

  window.addEventListener('zavora:camera-frame', (e) => {
    if (!status) return;
    const n = e.detail?.count || 0;
    status.textContent = `Suzy is watching · ${n} frame${n === 1 ? '' : 's'} sent`;
  });

  window.addEventListener('zavora:gesture', (e) => {
    if (!last) return;
    const g = e.detail?.gesture;
    last.textContent = EFFECT[g] || `gesture: ${g}`;
    last.classList.add('hit');
    setTimeout(() => last.classList.remove('hit'), 1800);
  });

  window.addEventListener('zavora:voice-transcript', (e) => {
    if (!last) return;
    if (e.detail?.done) { replyDone = true; return; }
    if (replyDone) { reply = ''; replyDone = false; }
    reply += e.detail?.content || '';
    const shown = reply.trim();
    if (shown) last.textContent = 'Suzy: ' + (shown.length > 110 ? '…' + shown.slice(-110) : shown);
  });
})();
