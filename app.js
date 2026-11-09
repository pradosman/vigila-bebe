'use strict';
(() => {
  const PREFIX = 'vigila-bebe-v1-';
  const ID_RE = /^[a-f0-9]{32}$/;
  const $ = id => document.getElementById(id);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };

  function newId() {
    const b = crypto.getRandomValues(new Uint8Array(16));
    return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  }
  function show(id) {
    document.querySelectorAll('.screen').forEach(s => { s.hidden = s.id !== id; });
  }
  function setPill(el, text, cls = '') {
    el.textContent = text;
    el.className = 'pill ' + cls;
  }
  function send(conn, msg) {
    try { if (conn && conn.open) conn.send(msg); } catch {}
  }

  // La pantalla no se debe apagar en ninguno de los dos móviles.
  let wakeLock = null;
  let wantAwake = false;
  async function keepAwake() {
    wantAwake = true;
    if (!('wakeLock' in navigator)) return false;
    try {
      if (!wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
      return true;
    } catch { return false; }
  }
  function releaseAwake() {
    wantAwake = false;
    if (wakeLock) wakeLock.release().catch(() => {});
  }

  /* ---------- CÁMARA ---------- */
  const cam = {
    active: false, id: null, peer: null, stream: null, facing: 'environment',
    viewers: new Map(), retry: null, beat: null, battery: null,
  };

  async function getMedia(kinds) {
    return navigator.mediaDevices.getUserMedia({
      // Calidad baja a propósito: gasta menos batería y se ve bien para vigilar.
      video: kinds.video ? { facingMode: { ideal: cam.facing }, width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 15, max: 15 } } : false,
      // Sin filtros de voz: un filtro de ruido puede quitar el llanto.
      audio: kinds.audio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: true } : false,
    });
  }

  // La imagen solo se enciende si alguien la pide. Sin monitor, sirve para colocar el móvil.
  function wantsVideo() {
    return cam.viewers.size === 0 || [...cam.viewers.values()].some(v => v.video);
  }
  function senderFor(call, kind) {
    const pc = call && call.peerConnection;
    if (!pc) return null;
    const t = pc.getTransceivers().find(x => x.receiver.track.kind === kind);
    return t ? t.sender : null;
  }
  function pushTracks() {
    if (!cam.stream) return;
    const audio = cam.stream.getAudioTracks()[0] || null;
    const video = cam.stream.getVideoTracks()[0] || null;
    for (const v of cam.viewers.values()) {
      const a = senderFor(v.call, 'audio');
      if (a && audio && a.track !== audio) a.replaceTrack(audio).catch(() => {});
      const s = senderFor(v.call, 'video');
      const want = v.video ? video : null;
      if (s && s.track !== want) s.replaceTrack(want).catch(() => {});
    }
  }
  async function doSync(restart) {
    if (!cam.active) return;
    if (!cam.stream) cam.stream = new MediaStream();
    const stream = cam.stream;
    const remove = t => { t.stop(); stream.removeTrack(t); };
    stream.getTracks().filter(t => t.readyState !== 'live').forEach(remove);
    if (restart) stream.getVideoTracks().forEach(remove);
    const wantV = wantsVideo();
    const needA = !stream.getAudioTracks().length;
    const needV = wantV && !stream.getVideoTracks().length;
    if (needA || needV) {
      const fresh = await getMedia({ audio: needA, video: needV });
      fresh.getTracks().forEach(t => {
        stream.addTrack(t);
        t.addEventListener('ended', onTrackEnded);
      });
    }
    if (!wantV) stream.getVideoTracks().forEach(remove);
    const preview = $('preview');
    if (preview.srcObject !== stream) preview.srcObject = stream;
    if ($('dimLayer').hidden) preview.play().catch(() => {});
    pushTracks();
    camStatusUpdate();
  }
  let syncing = Promise.resolve();
  function syncMedia(restart) {
    syncing = syncing.then(() => doSync(restart)).catch(() => {
      camWarn('La cámara se ha parado. Abre esta pantalla otra vez.');
    });
    return syncing;
  }
  function limitBitrate(v) {
    if (v.limited) return;
    const s = senderFor(v.call, 'video');
    if (!s || !s.track) return;
    const p = s.getParameters();
    if (!p.encodings || !p.encodings.length) return;
    p.encodings[0].maxBitrate = 350000;
    p.encodings[0].maxFramerate = 15;
    s.setParameters(p).then(() => { v.limited = true; }).catch(() => {});
  }
  function onTrackEnded() {
    if (!cam.active || document.hidden) return;
    syncMedia();
  }
  function setDim(on) {
    $('dimLayer').hidden = !on;
    const preview = $('preview');
    if (on) preview.pause();
    else preview.play().catch(() => {});
    cam.lastTouch = Date.now();
  }
  function camWarn(text) {
    $('camWarn').textContent = text;
    $('camWarn').hidden = false;
  }
  function viewerLink() {
    return location.origin + location.pathname + '#v=' + cam.id;
  }
  function drawQr() {
    const q = qrcode(0, 'M');
    q.addData(viewerLink());
    q.make();
    $('qr').innerHTML = q.createSvgTag({ cellSize: 4, margin: 8, scalable: true });
  }
  function camStatusUpdate() {
    const n = cam.viewers.size;
    if (!cam.peer || !cam.peer.open) {
      if (n === 0) return setPill($('camStatus'), 'Conectando…');
    }
    if (n === 0) setPill($('camStatus'), 'Esperando al monitor');
    else {
      const who = n === 1 ? '1 móvil' : n + ' móviles';
      const mode = wantsVideo() ? 'imagen y sonido' : 'solo sonido';
      setPill($('camStatus'), who + ' · ' + mode, 'ok');
      $('dimText').textContent = 'Cámara activa · ' + who + ' · ' + mode;
    }
  }
  function camState() {
    return { t: 'beat', hidden: document.hidden, battery: cam.battery };
  }
  function dropViewer(peerId) {
    const v = cam.viewers.get(peerId);
    if (!v) return;
    cam.viewers.delete(peerId);
    try { v.call && v.call.close(); } catch {}
    try { v.conn.close(); } catch {}
    if (cam.viewers.size === 0 && $('dimLayer').hidden) $('pairPanel').hidden = false;
    camStatusUpdate();
  }
  function openCamPeer() {
    clearTimeout(cam.retry);
    if (cam.peer) cam.peer.destroy();
    const peer = new Peer(PREFIX + cam.id, { debug: 0 });
    cam.peer = peer;
    peer.on('open', camStatusUpdate);
    peer.on('connection', conn => {
      conn.on('open', async () => {
        dropViewer(conn.peer);
        const v = { conn, call: null, video: true, limited: false, last: Date.now() };
        cam.viewers.set(conn.peer, v);
        $('pairPanel').hidden = true;
        // La primera llamada debe llevar imagen. Así se puede encender más tarde.
        await syncMedia();
        if (cam.viewers.get(conn.peer) !== v || peer !== cam.peer) return;
        v.call = peer.call(conn.peer, cam.stream);
        cam.lastTouch = Date.now();
        send(conn, camState());
        camStatusUpdate();
      });
      conn.on('data', d => {
        const v = cam.viewers.get(conn.peer);
        if (!v) return;
        v.last = Date.now();
        if (v.call && d && typeof d.video === 'boolean' && d.video !== v.video) {
          v.video = d.video;
          v.limited = false;
          syncMedia();
        }
      });
      conn.on('close', () => { const v = cam.viewers.get(conn.peer); if (v && v.conn === conn) dropViewer(conn.peer); });
      conn.on('error', () => {});
    });
    peer.on('disconnected', () => { if (cam.active) scheduleCamRetry(peer); });
    peer.on('error', () => { if (cam.active) scheduleCamRetry(peer); });
    peer.on('close', () => { if (cam.active && cam.peer === peer) scheduleCamRetry(peer); });
  }
  function scheduleCamRetry(peer) {
    if (peer !== cam.peer) return;
    camStatusUpdate();
    clearTimeout(cam.retry);
    cam.retry = setTimeout(() => {
      if (!cam.active || peer !== cam.peer) return;
      if (peer.destroyed) return openCamPeer();
      if (peer.disconnected) {
        try { peer.reconnect(); } catch { openCamPeer(); }
      }
    }, 3000);
  }
  async function startCamera() {
    show('camera');
    cam.active = true;
    cam.lastTouch = Date.now();
    cam.id = store.get('camId');
    if (!cam.id || !ID_RE.test(cam.id)) { cam.id = newId(); store.set('camId', cam.id); }
    drawQr();
    try {
      await doSync();
    } catch (e) {
      setPill($('camStatus'), 'Sin permiso de cámara', 'bad');
      camWarn('Este móvil no da acceso a la cámara o al micro. Revisa los permisos del navegador.');
      cam.active = false;
      return;
    }
    openCamPeer();
    const awake = await keepAwake();
    if (!awake) camWarn('Pon el bloqueo automático del móvil en «Nunca». Conecta también el cargador.');
    cam.beat = setInterval(() => {
      const now = Date.now();
      for (const [id, v] of cam.viewers) {
        if (now - v.last > 15000) dropViewer(id);
        else { send(v.conn, camState()); limitBitrate(v); }
      }
      // Con un monitor conectado, la pantalla se oscurece sola para gastar menos.
      if (cam.viewers.size && $('dimLayer').hidden && now - cam.lastTouch > 20000) setDim(true);
    }, 2000);
    if (navigator.getBattery) {
      navigator.getBattery().then(b => {
        const read = () => { cam.battery = { level: Math.round(b.level * 100), charging: b.charging }; };
        read();
        b.addEventListener('levelchange', read);
        b.addEventListener('chargingchange', read);
      }).catch(() => {});
    }
  }
  function stopCamera() {
    cam.active = false;
    clearInterval(cam.beat);
    clearTimeout(cam.retry);
    if (cam.peer) cam.peer.destroy();
    cam.peer = null;
    cam.viewers.clear();
    if (cam.stream) cam.stream.getTracks().forEach(t => t.stop());
    cam.stream = null;
    $('preview').srcObject = null;
    $('dimLayer').hidden = true;
    $('camWarn').hidden = true;
    $('pairPanel').hidden = false;
    releaseAwake();
    show('home');
  }

  $('goCamera').onclick = startCamera;
  $('camBack').onclick = stopCamera;
  $('dim').onclick = () => setDim(true);
  $('dimLayer').onclick = () => setDim(false);
  $('camera').addEventListener('pointerdown', () => { cam.lastTouch = Date.now(); });
  $('togglePair').onclick = () => { $('pairPanel').hidden = !$('pairPanel').hidden; };
  $('flip').onclick = async () => {
    cam.facing = cam.facing === 'environment' ? 'user' : 'environment';
    await syncMedia(true);
  };
  $('newCode').onclick = () => {
    if (!confirm('El otro móvil dejará de ver la cámara. Después tienes que escanear el código nuevo. ¿Cambiar el código?')) return;
    cam.id = newId();
    store.set('camId', cam.id);
    for (const id of [...cam.viewers.keys()]) dropViewer(id);
    drawQr();
    openCamPeer();
  };
  $('shareLink').onclick = async () => {
    const url = viewerLink();
    const btn = $('shareLink');
    try {
      if (navigator.share) await navigator.share({ title: 'Vigila Bebé', url });
      else {
        await navigator.clipboard.writeText(url);
        btn.textContent = 'Enlace copiado';
        setTimeout(() => { btn.textContent = 'Enviar enlace'; }, 2000);
      }
    } catch {}
  };

  /* ---------- MONITOR ---------- */
  const view = {
    active: false, target: null, peer: null, conn: null, call: null, stream: null,
    lastBeat: 0, lastTry: 0, connectedOnce: false, tick: null, beat: null,
    ac: null, analyser: null, raf: null, loudSince: 0, lastNoise: 0, noiseTimer: null,
    live: true, alarmOn: false, alarmMuted: false, alarmLoop: null,
    lastPackets: 0, lastTimeAt: 0, hidden: false, videoAlways: false, videoUntil: 0,
  };
  const SENS = { 1: 80, 2: 70, 3: 60, 4: 50, 5: 40 }; // Nivel de 0 a 100 que dispara el aviso.

  function readHash() {
    const m = location.hash.match(/^#v=([a-f0-9]{32})$/);
    if (!m) return;
    store.set('viewId', m[1]);
    history.replaceState(null, '', location.pathname);
    return m[1];
  }
  function openViewerStart() {
    const saved = store.get('viewId');
    const has = !!saved && ID_RE.test(saved);
    $('noCode').hidden = has;
    $('hasCode').hidden = !has;
    $('linkError').hidden = true;
    show('viewerStart');
  }
  function targetFromInput() {
    const m = $('linkInput').value.trim().match(/#v=([a-f0-9]{32})\s*$/);
    return m ? m[1] : null;
  }

  function closeViewerPeer() {
    if (view.peer) view.peer.destroy();
    view.peer = view.conn = view.call = null;
    view.lastBeat = 0;
  }
  function openViewerPeer() {
    closeViewerPeer();
    view.lastTry = Date.now();
    const peer = new Peer({ debug: 0 });
    view.peer = peer;
    peer.on('open', () => {
      const conn = peer.connect(PREFIX + view.target, { reliable: true });
      view.conn = conn;
      conn.on('data', onCamData);
      // Al conectar, la imagen sale un minuto. Después queda solo el sonido.
      conn.on('open', () => { view.videoUntil = Date.now() + 60000; updateVideoUi(); });
      conn.on('close', () => { if (view.conn === conn) view.lastBeat = 0; });
      conn.on('error', () => {});
    });
    peer.on('call', call => {
      view.call = call;
      call.on('stream', attachRemote);
      call.on('error', () => {});
      call.answer();
    });
    peer.on('error', e => {
      if (peer !== view.peer) return;
      if (e.type === 'peer-unavailable' && !view.connectedOnce) {
        setPill($('vStatus'), 'Esperando a la cámara…');
      }
    });
  }
  function onCamData(d) {
    if (!d || d.t !== 'beat') return;
    view.lastBeat = Date.now();
    view.connectedOnce = true;
    view.hidden = !!d.hidden;
    const b = d.battery;
    const pill = $('vBattery');
    if (b && Number.isFinite(b.level)) {
      pill.hidden = false;
      setPill(pill, 'Cámara ' + b.level + '%' + (b.charging ? ' ⚡' : ''), !b.charging && b.level <= 20 ? 'bad' : '');
    } else pill.hidden = true;
  }
  function attachRemote(stream) {
    view.stream = stream;
    const video = $('remote');
    video.srcObject = stream;
    view.lastPackets = 0;
    view.lastTimeAt = Date.now();
    playRemote();
    setupMeter(stream);
  }
  function playRemote() {
    const video = $('remote');
    video.muted = !view.live;
    video.play().then(() => { $('tapAudio').hidden = true; }).catch(() => {
      $('tapAudio').hidden = false;
    });
  }
  function setupMeter(stream) {
    if (!view.ac || !stream.getAudioTracks().length) return;
    try {
      if (view.source) view.source.disconnect();
      view.source = view.ac.createMediaStreamSource(stream);
      view.analyser = view.ac.createAnalyser();
      view.analyser.fftSize = 1024;
      view.source.connect(view.analyser);
    } catch {}
  }
  function meterLoop() {
    if (!view.active) return;
    view.raf = setTimeout(meterLoop, 100);
    if (!view.analyser) return;
    const data = new Float32Array(view.analyser.fftSize);
    view.analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const db = 20 * Math.log10(Math.sqrt(sum / data.length) || 1e-6);
    const level = Math.max(0, Math.min(100, (db + 70) * (100 / 60)));
    const limit = SENS[$('sens').value];
    const fill = $('meterFill');
    fill.style.width = level + '%';
    fill.classList.toggle('loud', level >= limit);
    $('meterMark').style.left = limit + '%';
    const now = Date.now();
    if (level >= limit && view.lastBeat) {
      if (!view.loudSince) view.loudSince = now;
      if (now - view.loudSince > 800 && now - view.lastNoise > 10000) notifyNoise(now);
    } else view.loudSince = 0;
  }
  function notifyNoise(now) {
    view.lastNoise = now;
    const toast = $('noise');
    toast.hidden = false;
    clearTimeout(view.noiseTimer);
    view.noiseTimer = setTimeout(() => { toast.hidden = true; }, 6000);
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    if (!view.live) beep(660, 0.25);
  }
  function beep(freq, secs) {
    const ac = view.ac;
    if (!ac) return;
    if (ac.state === 'suspended') ac.resume().catch(() => {});
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    gain.gain.value = 0.35;
    osc.frequency.value = freq;
    osc.connect(gain).connect(ac.destination);
    osc.start();
    osc.stop(ac.currentTime + secs);
  }
  function setAlarm(on, title, text) {
    if (on) {
      $('alarmTitle').textContent = title;
      $('alarmText').textContent = text;
      $('alarm').hidden = false;
      if (!view.alarmOn) {
        view.alarmOn = true;
        view.alarmMuted = false;
        $('alarmMute').hidden = false;
        const ring = () => {
          if (view.alarmMuted) return;
          beep(880, 0.35);
          if (navigator.vibrate) navigator.vibrate(400);
        };
        ring();
        view.alarmLoop = setInterval(ring, 1600);
      }
    } else if (view.alarmOn || !$('alarm').hidden) {
      view.alarmOn = false;
      clearInterval(view.alarmLoop);
      $('alarm').hidden = true;
    }
  }
  function wantVideo() {
    return view.videoAlways || Date.now() < view.videoUntil;
  }
  function updateVideoUi() {
    const on = wantVideo();
    $('remote').classList.toggle('off', !on);
    $('audioOnly').hidden = on;
    $('videoBtn').textContent = on ? 'Apagar imagen' : 'Ver 1 minuto';
    $('videoKeep').hidden = !on || view.videoAlways;
    send(view.conn, { t: 'ping', video: on });
  }
  // El sonido siempre llega. Si sus paquetes se paran, la señal se ha perdido.
  async function checkPackets() {
    const pc = view.call && view.call.peerConnection;
    if (!pc) return;
    try {
      const stats = await pc.getStats();
      stats.forEach(r => {
        if (r.type === 'inbound-rtp' && r.kind === 'audio' && r.packetsReceived > view.lastPackets) {
          view.lastPackets = r.packetsReceived;
          view.lastTimeAt = Date.now();
        }
      });
    } catch {}
  }
  function viewerTick() {
    const now = Date.now();
    const alive = view.lastBeat && now - view.lastBeat < 9000;
    if (alive) {
      checkPackets();
      updateVideoUi();
      const frozen = view.stream && now - view.lastTimeAt > 8000;
      if (view.hidden) {
        setAlarm(true, 'La cámara se ha salido de la app', 'El otro móvil no envía imagen. Abre la app en ese móvil.');
        setPill($('vStatus'), 'Cámara parada', 'bad');
      } else if (frozen) {
        setAlarm(true, 'La cámara no envía nada', 'No puedes oír al bebé ahora. Revisa el móvil de la cámara.');
        setPill($('vStatus'), 'Sin señal', 'bad');
        if (now - view.lastTry > 15000) openViewerPeer();
      } else if (view.stream) {
        setAlarm(false);
        setPill($('vStatus'), wantVideo() ? 'En directo' : 'Solo sonido', 'ok');
      } else {
        setPill($('vStatus'), 'Conectando…');
      }
      return;
    }
    if (view.connectedOnce) {
      setAlarm(true, 'Sin conexión con la cámara', 'No puedes ver al bebé ahora. Intento conectar otra vez.');
      setPill($('vStatus'), 'Sin conexión', 'bad');
    }
    if (now - view.lastTry > 10000) {
      view.stream = null;
      openViewerPeer();
    }
  }
  function startViewer() {
    const fromInput = !$('noCode').hidden ? targetFromInput() : null;
    if (fromInput) store.set('viewId', fromInput);
    const target = store.get('viewId');
    if (!target || !ID_RE.test(target)) {
      $('linkError').hidden = false;
      return;
    }
    view.target = target;
    view.active = true;
    view.connectedOnce = false;
    view.stream = null;
    // Estos pasos necesitan el toque del usuario para que el sonido funcione en el móvil.
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC && !view.ac) view.ac = new AC();
    if (view.ac) view.ac.resume().catch(() => {});
    $('remote').play().catch(() => {});
    show('viewer');
    keepAwake();
    openViewerPeer();
    view.tick = setInterval(viewerTick, 2000);
    view.videoAlways = false;
    view.videoUntil = 0;
    view.beat = setInterval(() => send(view.conn, { t: 'ping', video: wantVideo() }), 2000);
    meterLoop();
  }
  function stopViewer() {
    view.active = false;
    clearInterval(view.tick);
    clearInterval(view.beat);
    clearTimeout(view.raf);
    setAlarm(false);
    closeViewerPeer();
    view.analyser = null;
    view.stream = null;
    $('remote').srcObject = null;
    releaseAwake();
    show('home');
  }

  $('goViewer').onclick = openViewerStart;
  $('viewerBack').onclick = () => show('home');
  $('startViewer').onclick = startViewer;
  $('viewerExit').onclick = stopViewer;
  $('tapAudio').onclick = () => {
    if (view.ac) view.ac.resume().catch(() => {});
    playRemote();
  };
  $('videoBtn').onclick = () => {
    if (wantVideo()) { view.videoAlways = false; view.videoUntil = 0; }
    else view.videoUntil = Date.now() + 60000;
    updateVideoUi();
  };
  $('videoKeep').onclick = () => {
    view.videoAlways = true;
    updateVideoUi();
  };
  $('alarmMute').onclick = () => {
    view.alarmMuted = true;
    $('alarmMute').hidden = true;
  };
  $('liveAudio').onclick = () => {
    view.live = !view.live;
    const btn = $('liveAudio');
    btn.textContent = view.live ? 'Sonido: sí' : 'Sonido: solo avisos';
    btn.setAttribute('aria-pressed', String(view.live));
    $('remote').muted = !view.live;
    if (view.ac) view.ac.resume().catch(() => {});
  };

  /* ---------- COMÚN ---------- */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (cam.active) for (const v of cam.viewers.values()) send(v.conn, camState());
      return;
    }
    if (wantAwake) keepAwake();
    if (view.ac) view.ac.resume().catch(() => {});
    if (cam.active) {
      syncMedia();
      for (const v of cam.viewers.values()) send(v.conn, camState());
    }
    if (view.active) {
      view.lastTimeAt = Date.now();
      viewerTick();
    }
  });

  if (readHash()) openViewerStart();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
