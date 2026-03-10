// ═══════════════════════════════════════════════════════
//  SEKKITO — Plant Intelligence Dashboard  v3.0
//  app.js  — mirrors Flutter app (6 pages)
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

// ── MQTT CONFIG ────────────────────────────────────────
const MQTT_WS_URL     = "wss://broker.hivemq.com:8884/mqtt";
const TOPIC_SENSORS   = "esp32/sekkito/plant123/sensors";
const TOPIC_RELAY     = "esp32/sekkito/plant123/relay_status";
const TOPIC_CAPTURE   = "esp32cam/sekkito/plant123/capture";
const TOPIC_IMAGE     = "esp32cam/sekkito/plant123/imagePlant";  // chunked Base64 stream
const TOPIC_STATUS    = "esp32cam/sekkito/plant123/status";
const TOPIC_AI_RESULT = "esp32cam/sekkito/plant123/aiResult";

// ── GAUGE CONFIG ───────────────────────────────────────
const GAUGE_CFG = {
  air_temp:    { min: 0, max: 50,   color: '#ff7f50', unit: '°C'  },
  air_hum:     { min: 0, max: 100,  color: '#4fc3f7', unit: '%'   },
  water_level: { min: 0, max: 100,  color: '#00e5ff', unit: '%'   },
  light:       { min: 0, max: 100,  color: '#ffe57f', unit: '%'   },
  water_temp:  { min: 0, max: 50,   color: '#69f0ae', unit: '°C'  },
  tds:         { min: 0, max: 1000, color: '#ea80ff', unit: 'ppm' },
};
const KEY_MAP = {
  air_temp:    ['air_temp', 'air_temperature'],
  air_hum:     ['air_hum', 'humidity'],
  water_level: ['water_level'],
  light:       ['light', 'light_level'],
  water_temp:  ['water_temp', 'water_temperature'],
  tds:         ['tds', 'water_nutrient'],
};

// ── STATE ──────────────────────────────────────────────
let mqttClient       = null;
let sensorData       = {};
let relayData        = { relay: 'UNKNOWN', reason: '', window: '' };
let base64Buffer     = "";
let isReceivingImage = false;
let imageDataUrl     = null;
let imageTimeout     = null;
let imageHistory     = [];   // max 5 data URLs
let historyIndex     = -1;   // -1 = show latest

let THRESHOLDS = {
  air_temp:    { min: 18, max: 35  },
  air_hum:     { min: 40, max: 90  },
  water_level: { min: 20, max: 100 },
  light:       { min: 10, max: 100 },
  water_temp:  { min: 15, max: 30  },
};
let appSettings = { isDarkTheme: true, showGuides: true };
let plantLog    = [];   // [{ timestamp, note }]
let chartInstances = {};
let selectedRange  = 3600000;

// ══════════════════════════════════════════════════════════
//  BOOT
// ══════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  loadPersistedData();
  applyTheme();
  applyGuideVisibility();
  renderLog();
  wireNavigation();
  wireSettings();
  wireCamera();
  wireCopyPrompt();
  wireLogPage();
  connectMQTT();
});

// ── PERSISTENCE ────────────────────────────────────────
function loadPersistedData() {
  try {
    const s = localStorage.getItem('sekkito_settings');
    if (s) appSettings = { ...appSettings, ...JSON.parse(s) };
  } catch(e) {}
  try {
    const t = localStorage.getItem('sekkito_thresholds');
    if (t) THRESHOLDS = { ...THRESHOLDS, ...JSON.parse(t) };
  } catch(e) {}
  try {
    const l = localStorage.getItem('sekkito_plant_log');
    if (l) plantLog = JSON.parse(l);
  } catch(e) {}

  // Populate settings inputs
  const keys = ['air_temp','air_hum','water_level','light','water_temp'];
  keys.forEach(k => {
    const minEl = document.getElementById(`thr-${k}-min`);
    const maxEl = document.getElementById(`thr-${k}-max`);
    if (minEl) minEl.value = THRESHOLDS[k].min;
    if (maxEl) maxEl.value = THRESHOLDS[k].max;
  });
}

function saveSettings() { localStorage.setItem('sekkito_settings', JSON.stringify(appSettings)); }
function saveThresholds() { localStorage.setItem('sekkito_thresholds', JSON.stringify(THRESHOLDS)); }
function savePlantLog()   { localStorage.setItem('sekkito_plant_log',  JSON.stringify(plantLog)); }

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
    saveSettings();
    applyTheme();
  });

  document.getElementById('guidesToggle')?.addEventListener('change', e => {
    appSettings.showGuides = e.target.checked;
    saveSettings();
    applyGuideVisibility();
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
  const clientId = `sekkito_web_${Date.now()}`;
  mqttClient = mqtt.connect(MQTT_WS_URL, {
    clientId, keepalive: 20, reconnectPeriod: 3000, connectTimeout: 10000,
  });
  mqttClient.on('connect',    () => { setStatus(true,  'Receiving ESP32 data'); mqttClient.subscribe([TOPIC_SENSORS, TOPIC_RELAY, TOPIC_IMAGE, TOPIC_STATUS, TOPIC_AI_RESULT]); });
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
  if (topic === TOPIC_SENSORS) {
    try {
      const data = JSON.parse(str);
      sensorData = data;
      updateGauges(data);
      updateSnapshots(data);
      updateHealthScore(data);
      updateAlertBanners(data);
      updateLogSnapshot(data);
      document.getElementById('lastUpdated').textContent = `— last update: ${new Date().toLocaleTimeString()}`;
    } catch(e) { console.warn('Sensor parse:', e); }
    return;
  }
  if (topic === TOPIC_RELAY) {
    try { relayData = JSON.parse(str); updateRelayCard(relayData); updateSnapshots(sensorData); } catch(e) {}
    return;
  }
  if (topic === TOPIC_STATUS) {
    setCamStatus(str.replace(/_/g, ' '));
    return;
  }
  if (topic === TOPIC_AI_RESULT) {
    try {
      const d = JSON.parse(str);
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

  // Image transfer (Base64 chunked)
  if (topic === TOPIC_IMAGE) {
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
          // Add to history
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
    mqttClient.publish(TOPIC_CAPTURE, 'capture');
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
    a.href     = imageDataUrl;
    a.download = `plant_${Date.now()}.jpg`;
    a.click();
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
        badge.textContent = idx > 0 ? `HISTORY ${imageHistory.length - idx}/${imageHistory.length}` : '';
        badge.style.display = idx > 0 ? 'block' : 'none';
      }
      renderHistoryThumbs();
    });
  });
}

function setCamStatus(msg) {
  const el = document.getElementById('camStatus');
  if (el) el.textContent = msg;
}
function setCaptureBtn(busy) {
  const btn = document.getElementById('captureBtn');
  if (!btn) return;
  btn.disabled  = busy;
  btn.innerHTML = busy
    ? '<span class="btn-icon">◌</span> PROCESSING...'
    : '<span class="btn-icon">◎</span> CAPTURE';
}
function setPreviewReceiving(on) {
  document.getElementById('cameraPreview')?.classList.toggle('receiving', on);
}
function showTransferBar(on) {
  const bar  = document.getElementById('transferBar');
  const fill = document.getElementById('transferFill');
  if (bar)  bar.style.display = on ? 'block' : 'none';
  if (fill && !on) fill.style.width = '0%';
}

// ══════════════════════════════════════════════════════════
//  GAUGES + HEALTH + ALERTS + RELAY
// ══════════════════════════════════════════════════════════
function getVal(data, key) {
  for (const k of (KEY_MAP[key] || [key])) {
    if (data[k] !== undefined && data[k] !== null) return parseFloat(data[k]);
  }
  return null;
}

function arcPath(pct) {
  const cx = 60, cy = 65, r = 50;
  const end   = Math.PI - pct * Math.PI;
  const x     = cx + r * Math.cos(end);
  const y     = cy + r * Math.sin(end);
  const large = pct > 0.5 ? 1 : 0;
  return `M10,65 A${r},${r} 0 ${large},1 ${x.toFixed(2)},${y.toFixed(2)}`;
}

function updateGauges(data) {
  for (const [key, cfg] of Object.entries(GAUGE_CFG)) {
    const val = getVal(data, key);
    if (val === null) continue;
    const pct   = Math.max(0, Math.min(1, (val - cfg.min) / (cfg.max - cfg.min)));
    const arcEl = document.getElementById(`arc-${key}`);
    const valEl = document.getElementById(`val-${key}`);
    if (arcEl) arcEl.setAttribute('d', pct > 0.005 ? arcPath(pct) : 'M10,65 A50,50 0 0,1 10,65');
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
  const lbl   = score >= 80 ? 'HEALTHY' : score >= 60 ? 'FAIR'    : score >= 40 ? 'CAUTION' : 'CRITICAL';
  const circ  = 2 * Math.PI * 40;

  const ring = document.getElementById('ringFill');
  const sc   = document.getElementById('healthScore');
  const st   = document.getElementById('healthStatus');
  const hc   = document.getElementById('healthCard');

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

function updateRelayCard(d) {
  const state  = (d.relay  || 'UNKNOWN').toUpperCase();
  const window_ = (d.window || '').toUpperCase();
  const isOn   = state === 'ON';
  const isRest = window_ === 'REST';
  const isFS   = window_ === 'FAILSAFE';
  const reasonMap = {
    LOW_AMBIENT:       'Dim ambient — grow light compensating',
    BRIGHT_AMBIENT:    'Bright ambient — grow light not needed',
    REST_WINDOW:       'Rest period — light disabled',
    FAILSAFE:          'Connection lost — light forced ON',
    ACTIVE_NO_READING: 'Waiting for sensor reading',
  };
  const icon     = document.getElementById('relayIcon');
  const badge    = document.getElementById('relayBadge');
  const schedule = document.getElementById('relaySchedule');
  const reason   = document.getElementById('relayReason');
  const card     = document.getElementById('relayCard');
  if (icon)     icon.textContent     = isOn ? '💡' : '🌑';
  if (badge)  { badge.textContent    = state === 'UNKNOWN' ? '---' : state; badge.className = `relay-badge ${isOn ? 'on' : isRest ? 'rest' : 'off'}`; }
  if (card)     card.className       = `relay-card ${isOn ? 'on' : isRest ? 'rest' : ''}`;
  if (schedule) schedule.textContent = isFS ? '⚠ FAILSAFE active'
    : isRest ? 'Rest: 12:00 PM – 8:00 AM'
    : state === 'UNKNOWN' ? 'Waiting for signal...'
    : 'Active: 8:00 AM – 12:00 PM';
  if (reason) reason.textContent = reasonMap[d.reason] || d.reason || '';
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
  const tickClr   = appSettings.isDarkTheme ? '#555' : '#888';

  db.ref('history').orderByChild('timestamp').startAt(startTime).once('value', snap => {
    const raw  = snap.val() || {};
    const rows = Object.values(raw).filter(v => v && v.timestamp);
    rows.sort((a, b) => a.timestamp - b.timestamp);

    CHART_DEFS.forEach(def => {
      const canvas = document.getElementById(def.id);
      if (!canvas) return;
      const pts = rows
        .filter(r => r[def.fbKey] !== undefined && r[def.fbKey] !== null)
        .map(r => ({ x: new Date(r.timestamp), y: parseFloat(r[def.fbKey]) }));

      if (chartInstances[def.id]) chartInstances[def.id].destroy();
      chartInstances[def.id] = new Chart(canvas, {
        type: 'line',
        data: { datasets: [{ label: def.label, data: pts, borderColor: def.color, backgroundColor: def.color + '20', borderWidth: 2, pointRadius: 0, tension: 0.4, fill: true }] },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: { legend: { labels: { color: tickClr, font: { family: 'Space Mono', size: 10 } } } },
          scales: {
            x: { type: 'time', time: { tooltipFormat: 'HH:mm' }, ticks: { color: tickClr, font: { size: 9 } }, grid: { color: gridClr } },
            y: { ticks: { color: tickClr, font: { size: 9 } }, grid: { color: gridClr } },
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
- Nutrient TDS:          ${f('tds')} PPM
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

  if (input && counter) {
    input.addEventListener('input', () => {
      counter.textContent = `${input.value.length} chars`;
    });
  }

  if (addBtn) {
    addBtn.addEventListener('click', addLogEntry);
  }

  // Ctrl+Enter to submit from textarea
  if (input) {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); addLogEntry(); }
    });
  }
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

function deleteLogEntry(idx) {
  plantLog.splice(idx, 1);
  savePlantLog();
  renderLog();
}

function renderLog() {
  const container = document.getElementById('logEntries');
  if (!container) return;

  if (plantLog.length === 0) {
    container.innerHTML = `<div class="log-empty">
      <div class="log-empty-icon">📋</div>
      <div>No log entries yet</div>
      <div class="log-empty-sub">Add observations using the notepad above</div>
    </div>`;
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
