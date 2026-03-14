// ═══════════════════════════════════════════════════════
//  SEKKITO — Plant Intelligence Dashboard  v3.1
//  app.js  — circle gauges + force light
// ═══════════════════════════════════════════════════════

// ── FIREBASE CONFIG ────────────────────────────────────
const firebaseConfig = {
  apiKey:        "AIzaSyDAvkgNiwmXgChHsQsjlF_f8y-GCUfu8rQ",
  authDomain:    "plant-monitoring-2954a.firebaseapp.com",
  databaseURL:   "https://plant-monitoring-2954a-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId:     "plant-monitoring-2954a",
  storageBucket: "plant-monitoring-2954a.firebasestorage.app",
  appId:         "1:418029361475:web:8e080d2af7d7ac96b7f7f6",
};
firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// ════════════════════════════════════════════════════════
//  PROFILE SYSTEM
//  Each profile stores its own MQTT broker + topic prefix.
//  Switching profile reconnects MQTT and reloads charts.
// ════════════════════════════════════════════════════════

const DEFAULT_PROFILE = {
  id:           'plant123',
  name:         'Plant #1',
  emoji:        '🌱',
  mqttBroker:   'broker.hivemq.com',
  mqttPort:     8884,          // WebSocket SSL port
  topicPrefix:  'esp32/sekkito/plant123',
  camPrefix:    'esp32cam/sekkito/plant123',
  firebasePath: 'history',     // Firebase RTDB path for this plant's history
};

let profiles       = [];   // array of profile objects
let activeProfile  = null; // currently selected profile

function loadProfiles() {
  try {
    const raw = localStorage.getItem('sekkito_profiles');
    if (raw) {
      profiles = JSON.parse(raw);
    }
  } catch(e) {}
  // Always ensure at least the default profile exists
  if (profiles.length === 0) profiles = [{ ...DEFAULT_PROFILE }];

  // Load active profile id
  let activeId = null;
  try { activeId = localStorage.getItem('sekkito_active_profile'); } catch(e) {}
  activeProfile = profiles.find(p => p.id === activeId) || profiles[0];
}

function saveProfiles() {
  localStorage.setItem('sekkito_profiles', JSON.stringify(profiles));
  localStorage.setItem('sekkito_active_profile', activeProfile.id);
}

function switchProfile(id) {
  const p = profiles.find(p => p.id === id);
  if (!p || p.id === activeProfile.id) return;
  activeProfile = p;
  saveProfiles();
  // Reconnect MQTT with new topics
  if (mqttClient) { mqttClient.end(true); mqttClient = null; }
  connectMQTT();
  // Reload charts for the new Firebase path
  loadCharts();
  renderProfileSwitcher();
  updateActiveProfileUI();
}

// Derive topics from the active profile
function topics() {
  const p = activeProfile;
  return {
    SENSORS:   `${p.topicPrefix}/sensors`,
    RELAY:     `${p.topicPrefix}/relay_status`,
    FORCE:     `${p.topicPrefix}/force_light`,
    CAPTURE:   `${p.camPrefix}/capture`,
    IMAGE:     `${p.camPrefix}/imagePlant`,
    STATUS:    `${p.camPrefix}/status`,
    AI_RESULT: `${p.camPrefix}/aiResult`,
  };
}

function mqttWsUrl() {
  return `wss://${activeProfile.mqttBroker}:${activeProfile.mqttPort}/mqtt`;
}

// ── GAUGE CONFIG ───────────────────────────────────────
const GAUGE_CFG = {
  air_temp:    { min: 0, max: 50,   color: '#ff7f50', unit: '°C' },
  air_hum:     { min: 0, max: 100,  color: '#4fc3f7', unit: '%'  },
  water_level: { min: 0, max: 100,  color: '#00e5ff', unit: '%'  },
  light:       { min: 0, max: 100,  color: '#ffe57f', unit: '%'  },
  water_temp:  { min: 0, max: 50,   color: '#69f0ae', unit: '°C' },
};
const KEY_MAP = {
  air_temp:    ['air_temp', 'air_temperature'],
  air_hum:     ['air_hum', 'humidity'],
  water_level: ['water_level'],
  light:       ['light', 'light_level'],
  water_temp:  ['water_temp', 'water_temperature'],
};

// ── STATE ──────────────────────────────────────────────
let mqttClient       = null;
let sensorData       = {};
let relayData        = { relay: 'UNKNOWN', reason: '', window: '' };
let base64Buffer     = "";
let isReceivingImage = false;
let imageDataUrl     = null;
let imageTimeout     = null;
let imageHistory     = [];
let historyIndex     = -1;

// Force-light state
let forceActive    = false;
let forceEndTime   = null;
let forceTimer     = null;

let THRESHOLDS = {
  air_temp:    { min: 18, max: 35  },
  air_hum:     { min: 40, max: 90  },
  water_level: { min: 20, max: 100 },
  light:       { min: 10, max: 100 },
  water_temp:  { min: 15, max: 30  },
};
let appSettings    = { isDarkTheme: true, showGuides: true };
let plantLog       = [];
let chartInstances = {};
let selectedRange  = 3600000;

// ══════════════════════════════════════════════════════════
//  BOOT
// ══════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  loadProfiles();
  loadPersistedData();
  applyTheme();
  applyGuideVisibility();
  renderLog();
  wireNavigation();
  wireSettings();
  wireCamera();
  wireCopyPrompt();
  wireLogPage();
  wireForceLight();
  wireProfileSettings();
  populateForcePickers();
  renderProfileSwitcher();
  updateActiveProfileUI();
  connectMQTT();
});

// ── PERSISTENCE ────────────────────────────────────────
function loadPersistedData() {
  try { const s = localStorage.getItem('sekkito_settings');   if (s) appSettings = { ...appSettings, ...JSON.parse(s) }; } catch(e) {}
  try { const t = localStorage.getItem('sekkito_thresholds'); if (t) THRESHOLDS  = { ...THRESHOLDS,  ...JSON.parse(t) }; } catch(e) {}
  try { const l = localStorage.getItem('sekkito_plant_log');  if (l) plantLog     = JSON.parse(l); } catch(e) {}
  const keys = ['air_temp','air_hum','water_level','light','water_temp'];
  keys.forEach(k => {
    const minEl = document.getElementById(`thr-${k}-min`);
    const maxEl = document.getElementById(`thr-${k}-max`);
    if (minEl) minEl.value = THRESHOLDS[k].min;
    if (maxEl) maxEl.value = THRESHOLDS[k].max;
  });
}
function saveSettings()  { localStorage.setItem('sekkito_settings',   JSON.stringify(appSettings)); }
function saveThresholds(){ localStorage.setItem('sekkito_thresholds',  JSON.stringify(THRESHOLDS)); }
function savePlantLog()  { localStorage.setItem('sekkito_plant_log',   JSON.stringify(plantLog)); }

// ── THEME ──────────────────────────────────────────────
function applyTheme() {
  document.documentElement.classList.toggle('light-theme', !appSettings.isDarkTheme);
  const lbl = document.getElementById('themeLabel');
  if (lbl) lbl.textContent = appSettings.isDarkTheme ? 'Dark' : 'Light';
  const tog = document.getElementById('themeToggle');
  if (tog) tog.checked = appSettings.isDarkTheme;
}
function applyGuideVisibility() {
  document.querySelectorAll('.guide-card').forEach(el => {
    el.style.display = appSettings.showGuides ? '' : 'none';
  });
  const tog = document.getElementById('guidesToggle');
  if (tog) tog.checked = appSettings.showGuides;
}

// ── GUIDE TOGGLE ───────────────────────────────────────
function toggleGuide(id) {
  const body    = document.getElementById(`guidebody-${id}`);
  const chevron = document.getElementById(`chevron-${id}`);
  if (!body) return;
  const open = body.classList.toggle('open');
  chevron?.classList.toggle('open', open);
}

// ── NAVIGATION ─────────────────────────────────────────
function wireNavigation() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const page = btn.dataset.page;
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`page-${page}`)?.classList.add('active');
      if (page === 'analytics') loadCharts();
      document.getElementById('sidebar')?.classList.remove('open');
    });
  });
  document.getElementById('hamburger')?.addEventListener('click', () => {
    document.getElementById('sidebar')?.classList.toggle('open');
  });
}

// ── SETTINGS WIRING ────────────────────────────────────
function wireSettings() {
  document.getElementById('themeToggle')?.addEventListener('change', e => {
    appSettings.isDarkTheme = e.target.checked;
    saveSettings(); applyTheme();
  });
  document.getElementById('guidesToggle')?.addEventListener('change', e => {
    appSettings.showGuides = e.target.checked;
    saveSettings(); applyGuideVisibility();
  });
  document.getElementById('saveThrBtn')?.addEventListener('click', () => {
    const keys = ['air_temp','air_hum','water_level','light','water_temp'];
    keys.forEach(k => {
      const minVal = parseFloat(document.getElementById(`thr-${k}-min`)?.value);
      const maxVal = parseFloat(document.getElementById(`thr-${k}-max`)?.value);
      if (!isNaN(minVal)) THRESHOLDS[k].min = minVal;
      if (!isNaN(maxVal)) THRESHOLDS[k].max = maxVal;
    });
    saveThresholds();
    const msg = document.getElementById('thrSaveMsg');
    if (msg) { msg.style.display = 'block'; setTimeout(() => msg.style.display = 'none', 2500); }
  });
}

// ══════════════════════════════════════════════════════════
//  MQTT
// ══════════════════════════════════════════════════════════
function connectMQTT() {
  const T = topics();
  const clientId = `sekkito_web_${Date.now()}`;
  mqttClient = mqtt.connect(mqttWsUrl(), {
    clientId, keepalive: 20, reconnectPeriod: 3000, connectTimeout: 10000,
  });
  mqttClient.on('connect', () => {
    setStatus(true, `${activeProfile.emoji} ${activeProfile.name} — receiving data`);
    mqttClient.subscribe([T.SENSORS, T.RELAY, T.IMAGE, T.STATUS, T.AI_RESULT, T.FORCE]);
  });
  mqttClient.on('disconnect', () => setStatus(false, 'Disconnected — retrying'));
  mqttClient.on('error',      () => setStatus(false, 'Connection error'));
  mqttClient.on('offline',    () => setStatus(false, 'Broker offline — retrying'));
  mqttClient.on('reconnect',  () => setStatus(false, 'Reconnecting...'));
  mqttClient.on('message',    (topic, payload) => handleMessage(topic, payload.toString('utf8')));
}

function setStatus(online, hint = '') {
  const dot  = document.getElementById('statusDot');
  const text = document.getElementById('statusText');
  const h    = document.getElementById('statusHint');
  if (dot)  dot.className    = 'status-dot' + (online ? ' online' : '');
  if (text) text.textContent = online ? 'ONLINE' : 'OFFLINE';
  if (h && hint) h.textContent = hint;
}

function handleMessage(topic, str) {
  const T = topics();
  if (topic === T.SENSORS) {
    try {
      const data = JSON.parse(str);
      sensorData = data;
      updateGauges(data);
      updateSnapshots(data);
      updateHealthScore(data);
      updateAlertBanners(data);
      updateLogSnapshot(data);
      // Re-evaluate grow light icon since light level may have changed
      updateRelayCard(relayData);
      document.getElementById('lastUpdated').textContent = `— last update: ${new Date().toLocaleTimeString()}`;
    } catch(e) { console.warn('Sensor parse:', e); }
    return;
  }
  if (topic === T.RELAY) {
    try { relayData = JSON.parse(str); updateRelayCard(relayData); updateSnapshots(sensorData); } catch(e) {}
    return;
  }
  if (topic === T.STATUS) { setCamStatus(str.replace(/_/g, ' ')); return; }
  if (topic === T.AI_RESULT) {
    try {
      const d    = JSON.parse(str);
      const label = d.top_label || 'Unknown';
      const all   = d.all_results || [];
      const conf  = all.length ? all[0].confidence : 0;
      const badge = document.getElementById('aiResultBadge');
      if (badge) { badge.style.display = 'block'; badge.textContent = `◆ ${label} (${conf.toFixed(1)}%)`; }
      setCamStatus(`✓ AI Done: ${label}`);
      showAiModal(all);
    } catch(e) { setCamStatus('AI result error'); }
    return;
  }
  if (topic === T.IMAGE) {
    if (str === 'START') {
      clearTimeout(imageTimeout);
      base64Buffer = ''; isReceivingImage = true;
      setPreviewReceiving(true); showTransferBar(true);
      setCamStatus('Receiving image from ESP32-CAM...');
      imageTimeout = setTimeout(() => {
        if (isReceivingImage) {
          isReceivingImage = false;
          setPreviewReceiving(false); showTransferBar(false);
          setCaptureBtn(false);
          setCamStatus('⏱ Transfer timed out — tap Capture to try again');
        }
      }, 20000);
    } else if (str === 'END') {
      clearTimeout(imageTimeout);
      if (base64Buffer.length > 0) {
        try {
          imageDataUrl = `data:image/jpeg;base64,${base64Buffer}`;
          const img = document.getElementById('capturedImage');
          img.src   = imageDataUrl;
          img.style.display = 'block';
          document.getElementById('noImageMsg').style.display = 'none';
          isReceivingImage = false;
          setPreviewReceiving(false); showTransferBar(false);
          setCaptureBtn(false);
          document.getElementById('saveBtn').disabled = false;
          base64Buffer = '';
          setCamStatus('✅ Image ready — Save it, then use AI Portal for full diagnosis');
          imageHistory.unshift(imageDataUrl);
          if (imageHistory.length > 5) imageHistory.pop();
          historyIndex = -1;
          renderHistoryThumbs();
        } catch(e) {
          isReceivingImage = false;
          setPreviewReceiving(false); showTransferBar(false);
          setCaptureBtn(false);
          setCamStatus('Image decode failed — try capturing again');
        }
      }
    } else {
      if (isReceivingImage) {
        base64Buffer += str;
        const approxPct = Math.min(95, (base64Buffer.length / 150000) * 100);
        document.getElementById('transferFill').style.width = approxPct + '%';
      }
    }
  }
}

// ══════════════════════════════════════════════════════════
//  CAMERA
// ══════════════════════════════════════════════════════════
function wireCamera() {
  document.getElementById('captureBtn')?.addEventListener('click', () => {
    if (!mqttClient?.connected) { setCamStatus('Not connected to MQTT — check broker'); return; }
    setCaptureBtn(true);
    setCamStatus('Sending capture command to ESP32-CAM...');
    document.getElementById('aiResultBadge').style.display = 'none';
    mqttClient.publish(topics().CAPTURE, 'capture');
    clearTimeout(imageTimeout);
    imageTimeout = setTimeout(() => {
      if (!isReceivingImage && base64Buffer.length === 0) {
        isReceivingImage = false;
        setCaptureBtn(false);
        setCamStatus('⏱ No response — check ESP32-CAM is powered on');
      }
    }, 8000);
  });
  document.getElementById('saveBtn')?.addEventListener('click', () => {
    if (!imageDataUrl) return;
    const a = document.createElement('a');
    a.href = imageDataUrl; a.download = `plant_${Date.now()}.jpg`; a.click();
    setTimeout(() => setCamStatus('Image saved! → Go to AI Portal for diagnosis prompt'), 800);
  });
}

function renderHistoryThumbs() {
  const container = document.getElementById('imgHistory');
  if (!container) return;
  if (imageHistory.length <= 1) { container.innerHTML = ''; return; }
  container.innerHTML = imageHistory.map((url, i) => {
    const active = (historyIndex === i) || (historyIndex === -1 && i === 0);
    return `<div class="hist-thumb ${active ? 'active' : ''}" data-idx="${i}">
      <img src="${url}" alt="Capture ${i+1}" loading="lazy" />
    </div>`;
  }).join('');
  container.querySelectorAll('.hist-thumb').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.idx);
      historyIndex = idx;
      const img   = document.getElementById('capturedImage');
      const badge = document.getElementById('historyBadge');
      if (img) img.src = imageHistory[idx];
      if (badge) {
        badge.textContent  = idx > 0 ? `HISTORY ${imageHistory.length - idx}/${imageHistory.length}` : '';
        badge.style.display = idx > 0 ? 'block' : 'none';
      }
      renderHistoryThumbs();
    });
  });
}

function setCamStatus(msg) { const el = document.getElementById('camStatus'); if (el) el.textContent = msg; }
function setCaptureBtn(busy) {
  const btn = document.getElementById('captureBtn');
  if (!btn) return;
  btn.disabled  = busy;
  btn.innerHTML = busy ? '<span class="btn-icon">◌</span> PROCESSING...' : '<span class="btn-icon">◎</span> CAPTURE';
}
function setPreviewReceiving(on) { document.getElementById('cameraPreview')?.classList.toggle('receiving', on); }
function showTransferBar(on) {
  const bar  = document.getElementById('transferBar');
  const fill = document.getElementById('transferFill');
  if (bar)  bar.style.display = on ? 'block' : 'none';
  if (fill && !on) fill.style.width = '0%';
}

// ══════════════════════════════════════════════════════════
//  GAUGES + HEALTH + ALERTS
// ══════════════════════════════════════════════════════════
function getVal(data, key) {
  for (const k of (KEY_MAP[key] || [key])) {
    if (data[k] !== undefined && data[k] !== null) return parseFloat(data[k]);
  }
  return null;
}

// ── Circle arc math ─────────────────────────────────────
const CIRCLE_CX = 60, CIRCLE_CY = 60, CIRCLE_R = 50;
const GAP_DEG   = 60;
const START_DEG = 90 + GAP_DEG / 2;   // 120°
const SWEEP_DEG = 360 - GAP_DEG;      // 300°
function degToRad(d) { return d * Math.PI / 180; }

function arcPath(pct) {
  if (pct <= 0) return '';
  const clampedPct = Math.min(pct, 0.9999);
  const sweepAngle = clampedPct * SWEEP_DEG;
  const startRad = degToRad(START_DEG);
  const endRad   = degToRad(START_DEG + sweepAngle);
  const x1 = CIRCLE_CX + CIRCLE_R * Math.cos(startRad);
  const y1 = CIRCLE_CY + CIRCLE_R * Math.sin(startRad);
  const x2 = CIRCLE_CX + CIRCLE_R * Math.cos(endRad);
  const y2 = CIRCLE_CY + CIRCLE_R * Math.sin(endRad);
  const largeArc = sweepAngle > 180 ? 1 : 0;
  return `M${x1.toFixed(3)},${y1.toFixed(3)} A${CIRCLE_R},${CIRCLE_R} 0 ${largeArc},1 ${x2.toFixed(3)},${y2.toFixed(3)}`;
}

function updateGauges(data) {
  for (const [key, cfg] of Object.entries(GAUGE_CFG)) {
    const val = getVal(data, key);
    if (val === null) continue;
    const pct   = Math.max(0, Math.min(1, (val - cfg.min) / (cfg.max - cfg.min)));
    const arcEl = document.getElementById(`arc-${key}`);
    const valEl = document.getElementById(`val-${key}`);
    if (arcEl) arcEl.setAttribute('d', pct > 0.001 ? arcPath(pct) : '');
    if (valEl) valEl.textContent = val.toFixed(1);
    const thr     = THRESHOLDS[key];
    const alertEl = document.getElementById(`alert-${key}`);
    const card    = alertEl?.closest('.gauge-card');
    if (thr && alertEl) {
      const out = val < thr.min || val > thr.max;
      alertEl.style.display = out ? 'block' : 'none';
      card?.classList.toggle('alert', out);
    }
  }
}

function updateSnapshots(data) {
  for (const key of Object.keys(GAUGE_CFG)) {
    const el  = document.getElementById(`snap-${key}`);
    const val = getVal(data, key);
    if (el && val !== null) el.textContent = `${val.toFixed(1)} ${GAUGE_CFG[key].unit}`;
  }
  const relayEl = document.getElementById('snap-relay');
  if (relayEl) relayEl.textContent = (relayData.relay && relayData.relay !== 'UNKNOWN') ? relayData.relay : '--';
}

function updateLogSnapshot(data) {
  const map = {
    air_temp: 'logsnap-air_temp', air_hum: 'logsnap-air_hum',
    water_level: 'logsnap-water_level', light: 'logsnap-light', water_temp: 'logsnap-water_temp',
  };
  for (const [key, id] of Object.entries(map)) {
    const el  = document.getElementById(id);
    const val = getVal(data, key);
    if (el && val !== null) el.textContent = `${val.toFixed(1)}${GAUGE_CFG[key].unit}`;
  }
}

function updateHealthScore(data) {
  const checks = ['air_temp','air_hum','water_level','light','water_temp'];
  let pass = 0;
  checks.forEach(k => {
    const v = getVal(data, k);
    if (v !== null && v >= THRESHOLDS[k].min && v <= THRESHOLDS[k].max) pass++;
  });
  const score = Math.round((pass / checks.length) * 100);
  const clr   = score >= 80 ? '#69f0ae' : score >= 60 ? '#ffe57f' : score >= 40 ? '#ffab40' : '#ff5370';
  const lbl   = score >= 80 ? 'HEALTHY' : score >= 60 ? 'FAIR' : score >= 40 ? 'CAUTION' : 'CRITICAL';
  const circ  = 2 * Math.PI * 40;
  const ring  = document.getElementById('ringFill');
  const sc    = document.getElementById('healthScore');
  const st    = document.getElementById('healthStatus');
  const hc    = document.getElementById('healthCard');
  if (ring) { ring.style.strokeDashoffset = circ * (1 - pass / checks.length); ring.style.stroke = clr; }
  if (sc) sc.textContent = score + '%';
  if (st) { st.textContent = lbl; st.style.color = clr; }
  if (hc) hc.style.borderColor = clr.replace(')', ',0.25)').replace('rgb', 'rgba');
}

function updateAlertBanners(data) {
  const container = document.getElementById('alertBanners');
  if (!container) return;
  const msgs = [];
  const checks = {
    air_temp:    [['LOW','HIGH'], '°C'],
    air_hum:     [['LOW','HIGH'], '%'],
    water_level: [['LOW', null ], '%'],
    water_temp:  [['LOW','HIGH'], '°C'],
  };
  for (const [k, [dirs, unit]] of Object.entries(checks)) {
    const v = getVal(data, k);
    if (v === null) continue;
    if (dirs[0] && v < THRESHOLDS[k].min) msgs.push(`⚠ ${k.replace('_',' ')} LOW — ${v.toFixed(1)}${unit}`);
    if (dirs[1] && v > THRESHOLDS[k].max) msgs.push(`⚠ ${k.replace('_',' ')} HIGH — ${v.toFixed(1)}${unit}`);
  }
  container.innerHTML = msgs.map(m =>
    `<div class="alert-banner"><span class="alert-banner-icon">🔔</span>${m}</div>`
  ).join('');
}

// ══════════════════════════════════════════════════════════
//  RELAY CARD
// ══════════════════════════════════════════════════════════
function updateRelayCard(d) {
  const state   = (d.relay  || 'UNKNOWN').toUpperCase();
  const window_ = (d.window || '').toUpperCase();
  const isRest  = window_ === 'REST';
  const isFS    = window_ === 'FAILSAFE';
  const isForce = window_ === 'FORCE' || forceActive;

  // Light is ON when relay reports ON with a valid live reason.
  // We filter out stale retained boot messages by ignoring reason="RECONNECTED"
  // or empty reason, which are only published on first connect.
  const validReasons = ['LOW_AMBIENT','BRIGHT_AMBIENT','REST_WINDOW',
                        'FAILSAFE','FORCE_ON','ACTIVE_NO_READING'];
  const reasonValid = validReasons.includes(d.reason);
  const isOn = isForce || (state === 'ON' && reasonValid);

  const reasonMap = {
    LOW_AMBIENT:       'Dim ambient — grow light compensating',
    BRIGHT_AMBIENT:    'Bright ambient — grow light not needed',
    REST_WINDOW:       'Rest period — light disabled',
    FAILSAFE:          'Connection lost — light forced ON',
    ACTIVE_NO_READING: 'Waiting for sensor reading',
    FORCE_ON:          'Manually forced ON by user',
  };

  const icon     = document.getElementById('relayIcon');
  const badge    = document.getElementById('relayBadge');
  const schedule = document.getElementById('relaySchedule');
  const reason   = document.getElementById('relayReason');
  const card     = document.getElementById('relayCard');

  if (icon) icon.textContent = isOn ? '💡' : '🌑';
  if (badge) {
    badge.textContent = isForce ? 'FORCE ON' : state === 'UNKNOWN' ? '---' : state === 'ON' ? 'ON' : isRest ? 'REST' : 'OFF';
    badge.className   = `relay-badge ${isForce ? 'force' : isOn ? 'on' : isRest ? 'rest' : 'off'}`;
  }
  if (card) card.className = `relay-card ${isForce ? 'force' : isOn ? 'on' : isRest ? 'rest' : ''}`;
  if (schedule) {
    schedule.textContent = isForce        ? 'Forced ON — overrides schedule & rest period'
        : isFS                ? '⚠ FAILSAFE active'
        : isRest              ? 'Rest: 12:00 AM – 8:00 AM'
        : state === 'UNKNOWN' ? 'Waiting for signal...'
        : 'Active: 8:00 AM – 12:00 AM (midnight)';
  }
  if (reason) reason.textContent = isForce ? '' : (reasonMap[d.reason] || d.reason || '');

  // If ESP32 broadcasts that force ended, clear local state
  if (window_ !== 'FORCE' && forceActive && window_ !== '') _endForceLocal();
}

// ══════════════════════════════════════════════════════════
//  FORCE LIGHT
// ══════════════════════════════════════════════════════════
function wireForceLight() {
  document.getElementById('forceLightBtn')?.addEventListener('click', showForcePicker);
  document.getElementById('abortForceBtn')?.addEventListener('click', abortForce);

  // Wire modal buttons via JS (more reliable than inline onclick in some deployments)
  document.getElementById('forcePickerCancelBtn')?.addEventListener('click', hideForcePicker);
  document.getElementById('forcePickerConfirmBtn')?.addEventListener('click', confirmForceOn);
  document.getElementById('forceWarningCancelBtn')?.addEventListener('click', cancelForceWarning);
  document.getElementById('forceWarningConfirmBtn')?.addEventListener('click', confirmForceWarning);
  document.getElementById('abortCancelBtn')?.addEventListener('click', cancelAbort);
  document.getElementById('abortConfirmBtn')?.addEventListener('click', confirmAbort);

  // Also keep inline onclick as fallback — close picker/warning modals on overlay click
  document.getElementById('forceLightModal')?.addEventListener('click', e => {
    if (e.target.id === 'forceLightModal') hideForcePicker();
  });
  document.getElementById('forceWarningModal')?.addEventListener('click', e => {
    if (e.target.id === 'forceWarningModal') cancelForceWarning();
  });
  document.getElementById('abortConfirmModal')?.addEventListener('click', e => {
    if (e.target.id === 'abortConfirmModal') cancelAbort();
  });
}

function populateForcePickers() {
  const h = document.getElementById('forceHours');
  const m = document.getElementById('forceMinutes');
  if (h) {
    for (let i = 0; i <= 24; i++) {
      const o = document.createElement('option');
      o.value = i; o.textContent = String(i).padStart(2, '0');
      if (i === 1) o.selected = true;
      h.appendChild(o);
    }
  }
  if (m) {
    for (let i = 0; i < 60; i++) {
      const o = document.createElement('option');
      o.value = i; o.textContent = String(i).padStart(2, '0');
      m.appendChild(o);
    }
  }
}

function publishForce(payload) {
  if (!mqttClient?.connected) { alert('Not connected to MQTT broker.'); return false; }
  mqttClient.publish(topics().FORCE, JSON.stringify(payload));
  return true;
}

function overlapsRestPeriod(totalSeconds) {
  const now = new Date();
  const end = new Date(now.getTime() + totalSeconds * 1000);
  // Walk in 15-min steps up to AND including the end time
  let check = new Date(now);
  while (check <= end) {
    if (check.getHours() < 8) return true;  // 0–7 = rest
    check = new Date(check.getTime() + 15 * 60 * 1000);
  }
  // Also check the exact end time in case the step skipped past it
  if (end.getHours() < 8) return true;
  return false;
}

function _startForceLocal(seconds) {
  clearInterval(forceTimer);
  forceActive  = true;
  forceEndTime = new Date(Date.now() + seconds * 1000);
  _updateForceUI();
  forceTimer = setInterval(() => {
    if (!forceActive) { clearInterval(forceTimer); return; }
    if (new Date() >= forceEndTime) { _endForceLocal(); }
    else { _updateForceUI(); }
  }, 1000);
}

function _endForceLocal() {
  clearInterval(forceTimer);
  forceActive  = false;
  forceEndTime = null;
  _updateForceUI();
}

function _updateForceUI() {
  const forceSection = document.getElementById('forceOnSection');
  const abortSection = document.getElementById('abortSection');
  const countdownEl  = document.getElementById('forceCountdown');
  const relayCard    = document.getElementById('relayCard');
  const relayBadge   = document.getElementById('relayBadge');
  const relaySchedule= document.getElementById('relaySchedule');

  if (forceActive && forceEndTime) {
    const remaining = Math.max(0, Math.floor((forceEndTime - Date.now()) / 1000));
    const h = Math.floor(remaining / 3600);
    const m = Math.floor((remaining % 3600) / 60);
    const s = remaining % 60;
    const label = h > 0
        ? `${h}h ${String(m).padStart(2,'0')}m ${String(s).padStart(2,'0')}s`
        : `${String(m).padStart(2,'0')}m ${String(s).padStart(2,'0')}s`;

    if (forceSection)   forceSection.style.display  = 'none';
    if (abortSection)   abortSection.style.display   = 'flex';
    if (countdownEl)    countdownEl.textContent      = `⏱ Force ends in  ${label}`;
    if (relayCard)      relayCard.className           = 'relay-card force';
    if (relayBadge)   { relayBadge.textContent = 'FORCE ON'; relayBadge.className = 'relay-badge force'; }
    if (relaySchedule)  relaySchedule.textContent    = 'Forced ON — overrides schedule & rest period';
    const relayIcon = document.getElementById('relayIcon');
    if (relayIcon)      relayIcon.textContent        = '💡';
  } else {
    if (forceSection)  forceSection.style.display  = 'flex';
    if (abortSection)  abortSection.style.display   = 'none';
    if (countdownEl)   countdownEl.textContent      = '';
  }
}

function showForcePicker() {
  const modal = document.getElementById('forceLightModal');
  if (!modal) return;
  const hSel = document.getElementById('forceHours');
  const mSel = document.getElementById('forceMinutes');
  if (hSel) hSel.value = '1';
  if (mSel) mSel.value = '0';
  _updatePickerPreview();
  modal.style.display = 'flex';
}

function hideForcePicker() {
  const modal = document.getElementById('forceLightModal');
  if (modal) modal.style.display = 'none';
}

function _updatePickerPreview() {
  const h     = parseInt(document.getElementById('forceHours')?.value  || '0');
  const m     = parseInt(document.getElementById('forceMinutes')?.value || '0');
  const total = h * 3600 + m * 60;
  const el    = document.getElementById('forcePickerPreview');
  if (!el) return;
  if (total === 0) {
    el.textContent = 'Select at least 1 minute'; el.style.color = 'var(--amber)';
  } else if (h === 24 && m === 0) {
    el.textContent = '24 hours (maximum)'; el.style.color = 'var(--teal)';
  } else {
    el.textContent = h > 0 ? `${h}h ${m}m` : `${m} minutes`; el.style.color = 'var(--teal)';
  }
}

function confirmForceOn() {
  const h     = parseInt(document.getElementById('forceHours')?.value  || '0');
  const m     = parseInt(document.getElementById('forceMinutes')?.value || '0');
  const total = h * 3600 + m * 60;
  if (total === 0) return;
  hideForcePicker();
  if (overlapsRestPeriod(total)) {
    const warn = document.getElementById('forceWarningModal');
    if (warn) { warn.dataset.pendingSeconds = total; warn.style.display = 'flex'; return; }
  }
  _activateForce(total);
}

function confirmForceWarning() {
  const warn = document.getElementById('forceWarningModal');
  if (!warn) return;
  const total = parseInt(warn.dataset.pendingSeconds || '0');
  warn.style.display = 'none';
  if (total > 0) _activateForce(total);
}

function cancelForceWarning() {
  const warn = document.getElementById('forceWarningModal');
  if (warn) warn.style.display = 'none';
}

function _activateForce(totalSeconds) {
  if (!publishForce({ action: 'on', duration: totalSeconds })) return;
  _startForceLocal(totalSeconds);
}

function abortForce() {
  const modal = document.getElementById('abortConfirmModal');
  if (modal) { modal.style.display = 'flex'; return; }
  // Fallback if modal doesn't exist
  if (!confirm('Abort force light? Returns to automatic schedule immediately.')) return;
  publishForce({ action: 'off' });
  _endForceLocal();
}

function confirmAbort() {
  document.getElementById('abortConfirmModal').style.display = 'none';
  publishForce({ action: 'off' });
  _endForceLocal();
}

function cancelAbort() {
  document.getElementById('abortConfirmModal').style.display = 'none';
}

// ══════════════════════════════════════════════════════════
//  ANALYTICS — Charts
// ══════════════════════════════════════════════════════════
const CHART_DEFS = [
  { id: 'chart-air_temp',    label: 'Air Temp (°C)',       fbKey: 'air_temperature',  color: '#ff7f50' },
  { id: 'chart-air_hum',     label: 'Humidity (%)',        fbKey: 'humidity',         color: '#4fc3f7' },
  { id: 'chart-water_level', label: 'Water Level (%)',     fbKey: 'water_level',      color: '#00e5ff' },
  { id: 'chart-light',       label: 'Light Intensity (%)', fbKey: 'light_level',      color: '#ffe57f' },
  { id: 'chart-water_temp',  label: 'Water Temp (°C)',     fbKey: 'water_temperature',color: '#69f0ae' },
];

document.getElementById('rangeChips')?.addEventListener('click', e => {
  if (!e.target.classList.contains('chip')) return;
  document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  e.target.classList.add('active');
  selectedRange = parseInt(e.target.dataset.range);
  loadCharts();
});

function loadCharts() {
  const startTime = Date.now() - selectedRange;
  const gridClr   = appSettings.isDarkTheme ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.06)';
  const tickClr   = appSettings.isDarkTheme ? '#666' : '#999';
  const titleClr  = appSettings.isDarkTheme ? '#aaa' : '#555';

  // Pick x-axis time display format based on range
  // date-fns adapter tokens: 'HH:mm' for time, 'MMM d' for date
  let timeUnit, displayFormat, tooltipFmt;
  if      (selectedRange <=   600000) { timeUnit = 'minute'; displayFormat = { minute: 'HH:mm'       }; tooltipFmt = 'HH:mm:ss';    }
  else if (selectedRange <= 21600000) { timeUnit = 'minute'; displayFormat = { minute: 'HH:mm'       }; tooltipFmt = 'HH:mm';        }
  else if (selectedRange <= 86400000) { timeUnit = 'hour';   displayFormat = { hour:   'HH:mm'       }; tooltipFmt = 'HH:mm';        }
  else if (selectedRange <=259200000) { timeUnit = 'day';    displayFormat = { day:    'MMM d'        }; tooltipFmt = 'MMM d HH:mm'; }
  else                                { timeUnit = 'day';    displayFormat = { day:    'MMM d'        }; tooltipFmt = 'MMM d HH:mm'; }

  db.ref(activeProfile.firebasePath).orderByChild('timestamp').startAt(startTime).once('value', snap => {
    const raw  = snap.val() || {};
    const rows = Object.values(raw).filter(v => v && v.timestamp);
    rows.sort((a, b) => a.timestamp - b.timestamp);

    CHART_DEFS.forEach(def => {
      const canvas = document.getElementById(def.id);
      if (!canvas) return;

      const pts = rows
        .filter(r => r[def.fbKey] !== undefined && r[def.fbKey] !== null)
        .map(r => ({ x: new Date(r.timestamp), y: parseFloat(r[def.fbKey]) }));

      // ── Stats: min / max / avg ──────────────────────────────
      const statsEl = document.getElementById(`stats-${def.id}`);
      if (statsEl) {
        if (pts.length === 0) {
          statsEl.textContent = 'No data';
        } else {
          const vals   = pts.map(p => p.y);
          const minV   = Math.min(...vals).toFixed(1);
          const maxV   = Math.max(...vals).toFixed(1);
          const avgV   = (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1);
          // Extract unit from label e.g. "Air Temp (°C)" → "°C"
          const unitMatch = def.label.match(/\(([^)]+)\)$/);
          const unit = unitMatch ? unitMatch[1] : '';
          statsEl.textContent = `${pts.length} pts  ·  min ${minV}${unit}  ·  avg ${avgV}${unit}  ·  max ${maxV}${unit}`;
        }
      }

      // ── Threshold annotation lines ──────────────────────────
      // Map chart fbKey to THRESHOLDS key
      const thrKeyMap = {
        air_temperature:   'air_temp',
        humidity:          'air_hum',
        water_level:       'water_level',
        light_level:       'light',
        water_temperature: 'water_temp',
      };
      const thrKey = thrKeyMap[def.fbKey];
      const thr    = thrKey ? THRESHOLDS[thrKey] : null;

      const annotations = {};
      if (thr) {
        annotations.minLine = {
          type: 'line', yMin: thr.min, yMax: thr.min,
          borderColor: 'rgba(255,171,64,0.5)', borderWidth: 1, borderDash: [4, 3],
          label: { content: `min ${thr.min}`, display: true, position: 'start',
                   color: '#ffab40', font: { size: 8, family: 'Space Mono' }, backgroundColor: 'transparent', padding: 2 },
        };
        annotations.maxLine = {
          type: 'line', yMin: thr.max, yMax: thr.max,
          borderColor: 'rgba(255,83,112,0.5)', borderWidth: 1, borderDash: [4, 3],
          label: { content: `max ${thr.max}`, display: true, position: 'start',
                   color: '#ff5370', font: { size: 8, family: 'Space Mono' }, backgroundColor: 'transparent', padding: 2 },
        };
        // Safe zone fill between min and max
        annotations.safeZone = {
          type: 'box', yMin: thr.min, yMax: thr.max,
          backgroundColor: 'rgba(105,240,174,0.04)', borderWidth: 0,
        };
      }

      if (chartInstances[def.id]) chartInstances[def.id].destroy();
      chartInstances[def.id] = new Chart(canvas, {
        type: 'line',
        data: {
          datasets: [{
            label: def.label,
            data: pts,
            borderColor: def.color,
            backgroundColor: def.color + '18',
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 4,
            tension: 0.4,
            fill: true,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: false },   // title above serves as label
            tooltip: {
              backgroundColor: appSettings.isDarkTheme ? 'rgba(13,13,26,0.92)' : 'rgba(255,255,255,0.95)',
              titleColor: def.color,
              bodyColor:  appSettings.isDarkTheme ? '#ccc' : '#333',
              borderColor: def.color + '44',
              borderWidth: 1,
              titleFont:  { family: 'Orbitron', size: 10 },
              bodyFont:   { family: 'Space Mono', size: 11 },
              callbacks: {
                title: items => {
                  const d = new Date(items[0].parsed.x);
                  return d.toLocaleString('en-MY', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
                },
                label: item => {
                  const unitMatch = def.label.match(/\(([^)]+)\)$/);
                  const unit = unitMatch ? unitMatch[1] : '';
                  return `  ${item.parsed.y.toFixed(1)} ${unit}`;
                },
              },
            },
            annotation: { annotations },
          },
          scales: {
            x: {
              type: 'time',
              time: { unit: timeUnit, displayFormats: displayFormat, tooltipFormat: tooltipFmt },
              ticks: { color: tickClr, font: { size: 9, family: 'Space Mono' }, maxRotation: 0, autoSkipPadding: 16 },
              grid:  { color: gridClr },
              title: {
                display: true,
                text: 'Time',
                color: titleClr,
                font: { size: 9, family: 'Orbitron' },
                padding: { top: 4 },
              },
            },
            y: {
              ticks: { color: tickClr, font: { size: 9, family: 'Space Mono' } },
              grid:  { color: gridClr },
              title: {
                display: true,
                text: (() => {
                  const m = def.label.match(/\(([^)]+)\)$/);
                  return m ? m[1] : def.label;
                })(),
                color: titleClr,
                font: { size: 9, family: 'Orbitron' },
                padding: { bottom: 4 },
              },
            },
          },
        },
      });
    });
  });
}

// ══════════════════════════════════════════════════════════
//  AI PORTAL
// ══════════════════════════════════════════════════════════
function wireCopyPrompt() {
  document.getElementById('copyPromptBtn')?.addEventListener('click', () => {
    const plant    = document.getElementById('plantName').value.trim()  || 'Not specified';
    const stage    = document.getElementById('growthStage').value;
    const symptoms = document.getElementById('symptoms').value.trim()   || 'None described';
    const f = k => { const v = getVal(sensorData, k); return v !== null ? v.toFixed(1) : '--'; };
    const relayLine = (relayData.relay && relayData.relay !== 'UNKNOWN')
      ? `${relayData.relay} (${relayData.window || 'UNKNOWN'})` : '--';
    const prompt =
`PLANT HEALTH DIAGNOSIS REQUEST
------------------------------
Plant Type: ${plant}
Growth Stage: ${stage}
Observed Symptoms: ${symptoms}

LIVE SENSOR DATA (SEKKITO):
- Air Temperature:       ${f('air_temp')}°C
- Humidity:              ${f('air_hum')}%
- Water Temperature:     ${f('water_temp')}°C
- Water Level:           ${f('water_level')}%
- Light Intensity:       ${f('light')}%
- Grow Light:            ${relayLine}

INSTRUCTIONS:
Based on the image provided and the sensor data above, please provide:
1. A possible diagnosis of the plant's health condition.
2. Recommended adjustments to nutrients, water, or environment.
3. Immediate treatment steps if a disease or deficiency is detected.
4. Preventive measures for the next growth cycle.`;
    navigator.clipboard.writeText(prompt).then(() => {
      const btn = document.getElementById('copyPromptBtn');
      btn.textContent = '✓ Copied! Now open Gemini or ChatGPT ↓';
      btn.style.background = '#2e7d32';
      setTimeout(() => { btn.innerHTML = '⎘ Copy AI Prompt'; btn.style.background = ''; }, 2500);
    });
  });
}

function showAiModal(allResults) {
  const container = document.getElementById('modalResults');
  if (!container) return;
  container.innerHTML = '';
  allResults.forEach((res, i) => {
    const label = (res.label || '').replace(/_/g, ' ');
    const conf  = parseFloat(res.confidence) || 0;
    const isTop = i === 0;
    const color = isTop ? '#00e5d0' : 'rgba(199,125,255,0.5)';
    container.innerHTML += `
      <div class="modal-result-item">
        <div class="modal-result-row">
          <span class="modal-result-name ${isTop ? 'top' : 'other'}">${isTop ? '★ ' : ''}${label}</span>
          <span class="modal-result-conf ${isTop ? 'top' : 'other'}">${conf.toFixed(1)}%</span>
        </div>
        <div class="result-bar-bg"><div class="result-bar-fill" style="width:${conf}%;background:${color}"></div></div>
      </div>`;
  });
  document.getElementById('aiModal').style.display = 'flex';
}
document.getElementById('modalDismiss')?.addEventListener('click', () => document.getElementById('aiModal').style.display = 'none');
document.getElementById('aiModal')?.addEventListener('click', e => { if (e.target.id === 'aiModal') document.getElementById('aiModal').style.display = 'none'; });

// ══════════════════════════════════════════════════════════
//  PLANT LOG
// ══════════════════════════════════════════════════════════
function wireLogPage() {
  const input   = document.getElementById('logNoteInput');
  const addBtn  = document.getElementById('logAddBtn');
  const counter = document.getElementById('logCharCount');
  if (input && counter) input.addEventListener('input', () => { counter.textContent = `${input.value.length} chars`; });
  if (addBtn) addBtn.addEventListener('click', addLogEntry);
  if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); addLogEntry(); } });
}

function addLogEntry() {
  const input = document.getElementById('logNoteInput');
  if (!input) return;
  const note = input.value.trim();
  if (!note) return;
  const now = new Date();
  const timestamp = now.toLocaleDateString('en-MY', { day: '2-digit', month: 'short', year: 'numeric' })
    + '  ' + now.toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit', hour12: false });
  plantLog.unshift({ timestamp, note });
  savePlantLog();
  renderLog();
  input.value = '';
  const counter = document.getElementById('logCharCount');
  if (counter) counter.textContent = '0 chars';
}

function deleteLogEntry(idx) { plantLog.splice(idx, 1); savePlantLog(); renderLog(); }

function renderLog() {
  const container = document.getElementById('logEntries');
  if (!container) return;
  if (plantLog.length === 0) {
    container.innerHTML = `<div class="log-empty"><div class="log-empty-icon">📋</div><div>No log entries yet</div><div class="log-empty-sub">Add observations using the notepad above</div></div>`;
    return;
  }
  container.innerHTML = plantLog.map((entry, i) => `
    <div class="log-entry">
      <div class="log-entry-header">
        <span class="log-entry-ts">${entry.timestamp}</span>
        <button class="log-delete-btn" onclick="deleteLogEntry(${i})" title="Delete entry">✕</button>
      </div>
      <div class="log-entry-note">${entry.note.replace(/\n/g, '<br>')}</div>
    </div>
  `).join('');
}

// ══════════════════════════════════════════════════════════
//  PROFILE SYSTEM — UI
// ══════════════════════════════════════════════════════════

function renderProfileSwitcher() {
  const container = document.getElementById('profileSwitcher');
  if (!container) return;
  container.innerHTML = profiles.map(p => `
    <div class="profile-chip ${p.id === activeProfile.id ? 'active' : ''}"
         onclick="switchProfile('${p.id}')" title="${p.name}">
      <span class="profile-chip-emoji">${p.emoji}</span>
      <span class="profile-chip-name">${p.name}</span>
    </div>`
  ).join('');
}

function updateActiveProfileUI() {
  // Update sidebar hint text
  const hint = document.getElementById('statusHint');
  if (hint) hint.textContent = `${activeProfile.emoji} ${activeProfile.name}`;
  // Update page title area
  const activeName = document.getElementById('activeProfileName');
  if (activeName) activeName.textContent = `${activeProfile.emoji} ${activeProfile.name}`;
  // Populate MQTT settings inputs with active profile values
  const flds = ['mqttBroker','mqttPort','topicPrefix','camPrefix','firebasePath'];
  flds.forEach(f => {
    const el = document.getElementById(`mqtt-${f}`);
    if (el) el.value = activeProfile[f] ?? '';
  });
  const nameEl = document.getElementById('mqtt-profileName');
  if (nameEl) nameEl.value = activeProfile.name;
  const emojiEl = document.getElementById('mqtt-profileEmoji');
  if (emojiEl) emojiEl.value = activeProfile.emoji;
  // Re-render profile list in settings
  renderSettingsProfileList();
}

function renderSettingsProfileList() {
  const container = document.getElementById('settingsProfileList');
  if (!container) return;
  container.innerHTML = profiles.map((p, i) => `
    <div class="profile-row ${p.id === activeProfile.id ? 'active' : ''}">
      <span class="profile-row-emoji">${p.emoji}</span>
      <span class="profile-row-name">${p.name}</span>
      <span class="profile-row-broker">${p.mqttBroker}</span>
      <div class="profile-row-actions">
        ${p.id !== activeProfile.id
          ? `<button class="profile-action-btn select" onclick="switchProfile('${p.id}')">SELECT</button>`
          : `<span class="profile-active-badge">ACTIVE</span>`}
        ${profiles.length > 1
          ? `<button class="profile-action-btn delete" onclick="deleteProfile('${p.id}')">✕</button>`
          : ''}
      </div>
    </div>`
  ).join('');
}

function wireProfileSettings() {
  // Save active profile MQTT settings
  document.getElementById('saveMqttBtn')?.addEventListener('click', () => {
    activeProfile.name         = document.getElementById('mqtt-profileName')?.value.trim()  || activeProfile.name;
    activeProfile.emoji        = document.getElementById('mqtt-profileEmoji')?.value.trim() || activeProfile.emoji;
    activeProfile.mqttBroker   = document.getElementById('mqtt-mqttBroker')?.value.trim()   || activeProfile.mqttBroker;
    activeProfile.mqttPort     = parseInt(document.getElementById('mqtt-mqttPort')?.value)  || activeProfile.mqttPort;
    activeProfile.topicPrefix  = document.getElementById('mqtt-topicPrefix')?.value.trim()  || activeProfile.topicPrefix;
    activeProfile.camPrefix    = document.getElementById('mqtt-camPrefix')?.value.trim()    || activeProfile.camPrefix;
    activeProfile.firebasePath = document.getElementById('mqtt-firebasePath')?.value.trim() || activeProfile.firebasePath;
    saveProfiles();
    renderProfileSwitcher();
    updateActiveProfileUI();
    // Reconnect with updated broker/topics
    if (mqttClient) { mqttClient.end(true); mqttClient = null; }
    connectMQTT();
    const msg = document.getElementById('mqttSaveMsg');
    if (msg) { msg.style.display = 'block'; setTimeout(() => msg.style.display = 'none', 2500); }
  });

  // Add new profile
  document.getElementById('addProfileBtn')?.addEventListener('click', () => {
    const name = document.getElementById('newProfileName')?.value.trim();
    if (!name) return;
    const profileId = 'plant_' + Date.now();   // renamed from 'id' to avoid clash below
    const newP = {
      ...DEFAULT_PROFILE,
      id:           profileId,
      name,
      emoji:        document.getElementById('newProfileEmoji')?.value.trim()     || '🌿',
      mqttBroker:   document.getElementById('newProfileBroker')?.value.trim()    || DEFAULT_PROFILE.mqttBroker,
      mqttPort:     parseInt(document.getElementById('newProfilePort')?.value)    || DEFAULT_PROFILE.mqttPort,
      topicPrefix:  document.getElementById('newProfilePrefix')?.value.trim()    || `esp32/sekkito/${profileId}`,
      camPrefix:    document.getElementById('newProfileCamPrefix')?.value.trim() || `esp32cam/sekkito/${profileId}`,
      firebasePath: document.getElementById('newProfileFirebase')?.value.trim()  || 'history',
    };
    profiles.push(newP);
    saveProfiles();
    // Clear inputs — use 'inputId' to avoid shadowing profileId
    ['newProfileName','newProfileEmoji','newProfileBroker','newProfilePort',
     'newProfilePrefix','newProfileCamPrefix','newProfileFirebase'].forEach(inputId => {
      const el = document.getElementById(inputId);
      if (el) el.value = '';
    });
    renderProfileSwitcher();
    renderSettingsProfileList();
    // Collapse add form
    const form = document.getElementById('addProfileForm');
    if (form) form.style.display = 'none';
  });

  // Toggle add-profile form
  document.getElementById('showAddProfileBtn')?.addEventListener('click', () => {
    const form = document.getElementById('addProfileForm');
    if (form) form.style.display = form.style.display === 'none' ? 'block' : 'none';
  });
}

function deleteProfile(id) {
  if (profiles.length <= 1) return;
  profiles = profiles.filter(p => p.id !== id);
  if (activeProfile.id === id) {
    activeProfile = profiles[0];
    if (mqttClient) { mqttClient.end(true); mqttClient = null; }
    connectMQTT();
  }
  saveProfiles();
  renderProfileSwitcher();
  renderSettingsProfileList();
  updateActiveProfileUI();
}