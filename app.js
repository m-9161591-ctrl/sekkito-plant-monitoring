// ═══════════════════════════════════════════════════════
//  SEKKITO — Plant Intelligence Dashboard  v2.0
//  app.js
// ═══════════════════════════════════════════════════════

// ── FIREBASE CONFIG ────────────────────────────────────
const firebaseConfig = {
  apiKey:      "AIzaSyANQV1gV4-6mpejtKb-CdPmWoYDA5qMtMk",
  databaseURL: "https://aquapi-11257-default-rtdb.asia-southeast1.firebasedatabase.app",
};
firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// ── MQTT CONFIG ────────────────────────────────────────
const MQTT_WS_URL     = "wss://broker.hivemq.com:8884/mqtt";
const TOPIC_SENSORS   = "esp32/sekkito/plant123/sensors";
const TOPIC_RELAY     = "esp32/sekkito/plant123/relay_status";
const TOPIC_IMAGE     = "esp32cam/sekkito/plant123/imagePlant";
const TOPIC_CAPTURE   = "esp32cam/sekkito/plant123/capture";
const TOPIC_STATUS    = "esp32cam/sekkito/plant123/status";
const TOPIC_AI_RESULT = "esp32cam/sekkito/plant123/aiResult";

// ── THRESHOLDS (mirrors Flutter app defaults) ──────────
const THRESHOLDS = {
  air_temp:    { min: 18, max: 35 },
  air_hum:     { min: 40, max: 90 },
  water_level: { min: 20, max: 100 },
  light:       { min: 10, max: 100 },
  water_temp:  { min: 15, max: 30  },
};

// ── STATE ──────────────────────────────────────────────
let mqttClient       = null;
let sensorData       = {};
let relayData        = { relay: 'UNKNOWN', reason: '', window: '' };
let base64Buffer     = "";
let isReceivingImage = false;
let isAnalyzing      = false;
let imageDataUrl     = null;
let imageTimeout     = null;
let aiTimeout        = null;

// ── GUIDE CARD TOGGLE ──────────────────────────────────
function toggleGuide(id) {
  const body    = document.getElementById(`guidebody-${id}`);
  const chevron = document.getElementById(`chevron-${id}`);
  const open    = body.classList.toggle('open');
  chevron.classList.toggle('open', open);
}

// ── NAVIGATION ─────────────────────────────────────────
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const page = btn.dataset.page;
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`page-${page}`).classList.add('active');
    if (page === 'analytics') loadCharts();
    document.getElementById('sidebar').classList.remove('open');
  });
});

document.getElementById('hamburger').addEventListener('click', () => {
  document.getElementById('sidebar').classList.toggle('open');
});

// ── MQTT CONNECT ───────────────────────────────────────
function connectMQTT() {
  const clientId = `sekkito_web_${Date.now()}`;
  mqttClient = mqtt.connect(MQTT_WS_URL, {
    clientId, keepalive: 20, reconnectPeriod: 3000, connectTimeout: 10000,
  });

  mqttClient.on('connect', () => {
    setStatus(true, 'Receiving ESP32 data');
    mqttClient.subscribe([TOPIC_SENSORS, TOPIC_RELAY, TOPIC_IMAGE, TOPIC_STATUS, TOPIC_AI_RESULT]);
  });
  mqttClient.on('disconnect', () => setStatus(false, 'Disconnected — retrying'));
  mqttClient.on('error',      () => setStatus(false, 'Connection error'));
  mqttClient.on('offline',    () => setStatus(false, 'Broker offline — retrying'));
  mqttClient.on('reconnect',  () => setStatus(false, 'Reconnecting...'));

  mqttClient.on('message', (topic, payload) => {
    handleMessage(topic, payload.toString('utf8'));
  });
}

function setStatus(online, hint = '') {
  const dot  = document.getElementById('statusDot');
  const text = document.getElementById('statusText');
  const h    = document.getElementById('statusHint');
  dot.className   = 'status-dot' + (online ? ' online' : '');
  text.textContent = online ? 'ONLINE' : 'OFFLINE';
  if (hint) h.textContent = hint;
}

// ── MESSAGE HANDLER ────────────────────────────────────
function handleMessage(topic, str) {

  // Sensor data
  if (topic === TOPIC_SENSORS) {
    try {
      const data = JSON.parse(str);
      sensorData = data;
      updateGauges(data);
      updateSnapshots(data);
      updateHealthScore(data);
      updateAlertBanners(data);
      document.getElementById('lastUpdated').textContent =
        `— last update: ${new Date().toLocaleTimeString()}`;
    } catch(e) { console.warn('Sensor parse error', e); }
    return;
  }

  // Relay / grow light
  if (topic === TOPIC_RELAY) {
    try {
      relayData = JSON.parse(str);
      updateRelayCard(relayData);
      updateSnapshots(sensorData);  // refresh relay in snapshot
    } catch(e) {}
    return;
  }

  // Camera status
  if (topic === TOPIC_STATUS) {
    setCamStatus(str.replace(/_/g, ' '));
    return;
  }

  // AI result
  if (topic === TOPIC_AI_RESULT) {
    clearTimeout(aiTimeout);
    try {
      const decoded    = JSON.parse(str);
      const label      = decoded.top_label || 'Unknown';
      const allResults = decoded.all_results || [];
      const topConf    = allResults.length ? allResults[0].confidence : 0;
      isAnalyzing = false;
      setAiBtn(false);
      const badge = document.getElementById('aiResultBadge');
      badge.style.display  = 'block';
      badge.textContent    = `◆ ${label} (${topConf.toFixed(1)}%)`;
      setCamStatus(`✓ AI Done: ${label} — see AI Portal for full diagnosis`);
      showAiModal(allResults);
    } catch(e) {
      isAnalyzing = false;
      setAiBtn(false);
      setCamStatus('AI result error — try again');
    }
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
          document.getElementById('aiBtn').disabled   = false;
          base64Buffer = '';
          setCamStatus('✅ Image ready — Save it, then use AI Portal for full diagnosis');
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

// ── GAUGE CONFIG ───────────────────────────────────────
const GAUGE_CONFIG = {
  air_temp:    { min: 0, max: 50,   color: '#ff7f50', unit: '°C'  },
  air_hum:     { min: 0, max: 100,  color: '#4fc3f7', unit: '%'   },
  water_level: { min: 0, max: 100,  color: '#00e5ff', unit: '%'   },
  light:       { min: 0, max: 100,  color: '#ffe57f', unit: '%'   },
  water_temp:  { min: 0, max: 50,   color: '#69f0ae', unit: '°C'  },
  tds:         { min: 0, max: 1000, color: '#ea80ff', unit: 'ppm' },
};

// Key aliases from MQTT payload → gauge key
const KEY_MAP = {
  air_temp:    ['air_temp', 'air_temperature'],
  air_hum:     ['air_hum', 'humidity'],
  water_level: ['water_level'],
  light:       ['light', 'light_level'],
  water_temp:  ['water_temp', 'water_temperature'],
  tds:         ['tds', 'water_nutrient'],
};

function getVal(data, key) {
  const candidates = KEY_MAP[key] || [key];
  for (const k of candidates) {
    if (data[k] !== undefined && data[k] !== null) return parseFloat(data[k]);
  }
  return null;
}

function arcPath(pct) {
  const cx = 60, cy = 65, r = 50;
  const end = Math.PI - (pct * Math.PI);
  const x   = cx + r * Math.cos(end);
  const y   = cy + r * Math.sin(end);
  const large = pct > 0.5 ? 1 : 0;
  return `M10,65 A${r},${r} 0 ${large},1 ${x.toFixed(2)},${y.toFixed(2)}`;
}

function updateGauges(data) {
  for (const [key, cfg] of Object.entries(GAUGE_CONFIG)) {
    const val = getVal(data, key);
    if (val === null) continue;
    const pct   = Math.max(0, Math.min(1, (val - cfg.min) / (cfg.max - cfg.min)));
    const arcEl = document.getElementById(`arc-${key}`);
    const valEl = document.getElementById(`val-${key}`);
    if (arcEl) arcEl.setAttribute('d', pct > 0.005 ? arcPath(pct) : 'M10,65 A50,50 0 0,1 10,65');
    if (valEl) valEl.textContent = val.toFixed(1);

    // Alert badge on gauge
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
  for (const key of Object.keys(GAUGE_CONFIG)) {
    const el  = document.getElementById(`snap-${key}`);
    const cfg = GAUGE_CONFIG[key];
    const val = getVal(data, key);
    if (el && val !== null) el.textContent = `${val.toFixed(1)} ${cfg.unit}`;
  }
  // Relay in snapshot
  const relayEl = document.getElementById('snap-relay');
  if (relayEl) {
    const s = relayData.relay || 'UNKNOWN';
    relayEl.textContent = s === 'UNKNOWN' ? '--' : s;
  }
}

// ── HEALTH SCORE ───────────────────────────────────────
function updateHealthScore(data) {
  const checks = [
    { key: 'air_temp',    thr: THRESHOLDS.air_temp    },
    { key: 'air_hum',     thr: THRESHOLDS.air_hum     },
    { key: 'water_level', thr: THRESHOLDS.water_level },
    { key: 'light',       thr: THRESHOLDS.light       },
    { key: 'water_temp',  thr: THRESHOLDS.water_temp  },
  ];
  let pass = 0;
  checks.forEach(c => {
    const v = getVal(data, c.key);
    if (v !== null && v >= c.thr.min && v <= c.thr.max) pass++;
  });
  const pct   = (pass / checks.length) * 100;
  const score = Math.round(pct);

  // Update ring
  const circumference = 2 * Math.PI * 40; // r=40 → 251.2
  const offset = circumference * (1 - pass / checks.length);
  const ring   = document.getElementById('ringFill');
  const sc     = document.getElementById('healthScore');
  const st     = document.getElementById('healthStatus');
  const hc     = document.getElementById('healthCard');

  if (ring) {
    ring.style.strokeDashoffset = offset;
    ring.style.stroke = score >= 80 ? '#69f0ae' : score >= 60 ? '#ffe57f' : score >= 40 ? '#ffab40' : '#ff5370';
  }
  if (sc) sc.textContent = score + '%';
  if (st) {
    const lbl = score >= 80 ? 'HEALTHY' : score >= 60 ? 'FAIR' : score >= 40 ? 'CAUTION' : 'CRITICAL';
    st.textContent  = lbl;
    st.style.color  = score >= 80 ? '#69f0ae' : score >= 60 ? '#ffe57f' : score >= 40 ? '#ffab40' : '#ff5370';
  }
  if (hc) {
    hc.style.borderColor = score >= 80 ? 'rgba(105,240,174,0.25)' : score >= 60 ? 'rgba(255,229,127,0.25)' : score >= 40 ? 'rgba(255,171,64,0.25)' : 'rgba(255,83,112,0.25)';
  }
}

// ── ALERT BANNERS ──────────────────────────────────────
function updateAlertBanners(data) {
  const container = document.getElementById('alertBanners');
  const messages  = [];

  const v_t = getVal(data, 'air_temp');
  const v_h = getVal(data, 'air_hum');
  const v_w = getVal(data, 'water_level');
  const v_l = getVal(data, 'light');
  const v_wt = getVal(data, 'water_temp');

  if (v_t !== null) {
    if (v_t < THRESHOLDS.air_temp.min) messages.push(`⚠ Air Temp LOW — ${v_t.toFixed(1)}°C (min ${THRESHOLDS.air_temp.min}°C)`);
    if (v_t > THRESHOLDS.air_temp.max) messages.push(`⚠ Air Temp HIGH — ${v_t.toFixed(1)}°C (max ${THRESHOLDS.air_temp.max}°C)`);
  }
  if (v_h !== null) {
    if (v_h < THRESHOLDS.air_hum.min) messages.push(`⚠ Humidity LOW — ${v_h.toFixed(1)}% (min ${THRESHOLDS.air_hum.min}%)`);
    if (v_h > THRESHOLDS.air_hum.max) messages.push(`⚠ Humidity HIGH — ${v_h.toFixed(1)}% (max ${THRESHOLDS.air_hum.max}%)`);
  }
  if (v_w !== null && v_w < THRESHOLDS.water_level.min)
    messages.push(`⚠ Water Level LOW — ${v_w.toFixed(1)}% (min ${THRESHOLDS.water_level.min}%)`);
  if (v_wt !== null) {
    if (v_wt < THRESHOLDS.water_temp.min) messages.push(`⚠ Water Temp LOW — ${v_wt.toFixed(1)}°C (min ${THRESHOLDS.water_temp.min}°C)`);
    if (v_wt > THRESHOLDS.water_temp.max) messages.push(`⚠ Water Temp HIGH — ${v_wt.toFixed(1)}°C (max ${THRESHOLDS.water_temp.max}°C)`);
  }

  container.innerHTML = messages.map(m =>
    `<div class="alert-banner"><span class="alert-banner-icon">🔔</span>${m}</div>`
  ).join('');
}

// ── RELAY / GROW LIGHT CARD ────────────────────────────
function updateRelayCard(d) {
  const card     = document.getElementById('relayCard');
  const icon     = document.getElementById('relayIcon');
  const badge    = document.getElementById('relayBadge');
  const schedule = document.getElementById('relaySchedule');
  const reason   = document.getElementById('relayReason');

  const state  = (d.relay  || 'UNKNOWN').toUpperCase();
  const window_ = (d.window || '').toUpperCase();
  const isOn   = state === 'ON';
  const isRest = window_ === 'REST';
  const isFS   = window_ === 'FAILSAFE';

  const reasonMap = {
    LOW_AMBIENT:       'Ambient light is dim — grow light compensates',
    BRIGHT_AMBIENT:    'Ambient light is bright enough — light stays off',
    REST_WINDOW:       'Plants are in their scheduled rest period',
    FAILSAFE:          'Connection lost — light forced ON as safety measure',
    ACTIVE_NO_READING: 'Waiting for first sensor reading...',
  };

  icon.textContent = isOn ? '💡' : '🌑';
  badge.textContent = state === 'UNKNOWN' ? '---' : state;
  badge.className   = `relay-badge ${isOn ? 'on' : isRest ? 'rest' : 'off'}`;

  card.className = `relay-card ${isOn ? 'on' : isRest ? 'rest' : ''}`;

  schedule.textContent = isFS   ? '⚠ FAILSAFE active'
    : isRest ? 'Rest window: 12:00 PM – 8:00 AM'
    : state === 'UNKNOWN' ? 'Waiting for signal from light controller...'
    : 'Active window: 8:00 AM – 12:00 PM';

  reason.textContent = reasonMap[d.reason] || d.reason || '';
}

// ── CHARTS ─────────────────────────────────────────────
const CHART_DEFS = [
  { id: 'chart-air_temp',    label: 'Air Temp (°C)',       fbKey: 'air_temperature',   color: '#ff7f50' },
  { id: 'chart-air_hum',     label: 'Humidity (%)',        fbKey: 'humidity',           color: '#4fc3f7' },
  { id: 'chart-water_level', label: 'Water Level (%)',     fbKey: 'water_level',        color: '#00e5ff' },
  { id: 'chart-light',       label: 'Light Intensity (%)', fbKey: 'light_level',        color: '#ffe57f' },
  { id: 'chart-water_temp',  label: 'Water Temp (°C)',     fbKey: 'water_temperature',  color: '#69f0ae' },
];

let chartInstances = {};
let selectedRange  = 3600000;

document.getElementById('rangeChips').addEventListener('click', e => {
  if (!e.target.classList.contains('chip')) return;
  document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  e.target.classList.add('active');
  selectedRange = parseInt(e.target.dataset.range);
  loadCharts();
});

function loadCharts() {
  const startTime = Date.now() - selectedRange;

  db.ref('history').orderByChild('timestamp').startAt(startTime).once('value', snap => {
    const raw  = snap.val() || {};
    const rows = Object.values(raw).filter(v => v.timestamp);
    rows.sort((a, b) => a.timestamp - b.timestamp);

    CHART_DEFS.forEach(def => {
      const canvas = document.getElementById(def.id);
      if (!canvas) return;
      const points = rows
        .filter(r => r[def.fbKey] !== undefined && r[def.fbKey] !== null)
        .map(r => ({ x: new Date(r.timestamp), y: parseFloat(r[def.fbKey]) }));

      if (chartInstances[def.id]) chartInstances[def.id].destroy();

      chartInstances[def.id] = new Chart(canvas, {
        type: 'line',
        data: {
          datasets: [{
            label: def.label, data: points,
            borderColor: def.color, backgroundColor: def.color + '20',
            borderWidth: 2, pointRadius: 0, tension: 0.4, fill: true,
          }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { labels: { color: '#888', font: { family: 'Space Mono', size: 10 } } },
          },
          scales: {
            x: {
              type: 'time', time: { tooltipFormat: 'HH:mm' },
              ticks: { color: '#444', font: { size: 9 } },
              grid:  { color: 'rgba(255,255,255,0.04)' },
            },
            y: {
              ticks: { color: '#444', font: { size: 9 } },
              grid:  { color: 'rgba(255,255,255,0.04)' },
            }
          }
        }
      });
    });
  });
}

// ── CAMERA CONTROLS ────────────────────────────────────
document.getElementById('captureBtn').addEventListener('click', () => {
  if (!mqttClient?.connected) { setCamStatus('Not connected to MQTT — check broker'); return; }
  setCaptureBtn(true);
  setCamStatus('Sending capture command to ESP32-CAM...');
  document.getElementById('aiResultBadge').style.display = 'none';
  mqttClient.publish(TOPIC_CAPTURE, 'capture');
  clearTimeout(imageTimeout);
  imageTimeout = setTimeout(() => {
    if (isReceivingImage && base64Buffer.length === 0) {
      isReceivingImage = false;
      setCaptureBtn(false);
      setCamStatus('⏱ No response — check ESP32-CAM is powered on');
    }
  }, 8000);
});

document.getElementById('saveBtn').addEventListener('click', () => {
  if (!imageDataUrl) return;
  const a = document.createElement('a');
  a.href = imageDataUrl;
  a.download = `plant_${Date.now()}.jpg`;
  a.click();
  // Remind user what to do next
  setTimeout(() => {
    const camStatus = document.getElementById('camStatus');
    if (camStatus) camStatus.textContent = 'Image saved! → Go to AI Portal to generate a diagnosis prompt';
  }, 800);
});

document.getElementById('aiBtn').addEventListener('click', () => {
  if (!mqttClient?.connected) { setCamStatus('Not connected'); return; }
  isAnalyzing = true;
  setAiBtn(true);
  setCamStatus('Requesting TFLite analysis from Raspberry Pi...');
  mqttClient.publish(TOPIC_CAPTURE, 'analyze');
  clearTimeout(aiTimeout);
  aiTimeout = setTimeout(() => {
    if (isAnalyzing) {
      isAnalyzing = false;
      setAiBtn(false);
      setCamStatus('⏱ AI timed out — check Pi is running ai_bridge.py');
    }
  }, 8000);
});

// ── CAMERA UI HELPERS ──────────────────────────────────
function setCamStatus(msg) { document.getElementById('camStatus').textContent = msg; }
function setCaptureBtn(busy) {
  const btn = document.getElementById('captureBtn');
  btn.disabled  = busy;
  btn.innerHTML = busy
    ? '<span class="btn-icon">◌</span> PROCESSING...'
    : '<span class="btn-icon">◎</span> CAPTURE';
}
function setAiBtn(busy) {
  const btn = document.getElementById('aiBtn');
  btn.disabled  = busy;
  btn.innerHTML = busy
    ? '<span class="btn-icon">◌</span> ANALYZING...'
    : '<span class="btn-icon">◆</span> FAST AI ANALYSIS';
}
function setPreviewReceiving(on) { document.getElementById('cameraPreview').classList.toggle('receiving', on); }
function showTransferBar(on) {
  document.getElementById('transferBar').style.display = on ? 'block' : 'none';
  if (!on) document.getElementById('transferFill').style.width = '0%';
}

// ── AI MODAL ───────────────────────────────────────────
function showAiModal(allResults) {
  const container = document.getElementById('modalResults');
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
        <div class="result-bar-bg">
          <div class="result-bar-fill" style="width:${conf}%;background:${color}"></div>
        </div>
      </div>`;
  });
  document.getElementById('aiModal').style.display = 'flex';
}
document.getElementById('modalDismiss').addEventListener('click', () => {
  document.getElementById('aiModal').style.display = 'none';
});
document.getElementById('aiModal').addEventListener('click', e => {
  if (e.target === document.getElementById('aiModal'))
    document.getElementById('aiModal').style.display = 'none';
});

// ── AI PORTAL PROMPT ───────────────────────────────────
document.getElementById('copyPromptBtn').addEventListener('click', () => {
  const plant    = document.getElementById('plantName').value.trim()   || 'Not specified';
  const stage    = document.getElementById('growthStage').value;
  const symptoms = document.getElementById('symptoms').value.trim()    || 'None described';
  const s        = sensorData;

  const f = (key) => {
    const v = getVal(s, key);
    return v !== null ? v.toFixed(1) : '--';
  };

  const relayLine = relayData.relay && relayData.relay !== 'UNKNOWN'
    ? `${relayData.relay} (${relayData.window || 'UNKNOWN'})`
    : '--';

  const prompt =
`PLANT HEALTH DIAGNOSIS REQUEST
------------------------------
Plant Type: ${plant}
Growth Stage: ${stage}
Observed Symptoms: ${symptoms}

LIVE SENSOR DATA (SEKKITO Hydroponics System):
- Air Temperature:   ${f('air_temp')}°C
- Humidity:          ${f('air_hum')}%
- Water Temperature: ${f('water_temp')}°C
- Water Level:       ${f('water_level')}%
- Light Intensity:   ${f('light')}%
- Nutrient TDS:      ${f('tds')} PPM
- Grow Light:        ${relayLine}

INSTRUCTIONS:
Based on the plant image I am uploading and the sensor data above, please provide:
1. A diagnosis of the plant's current health condition.
2. Recommended adjustments to nutrients, water, light, or temperature.
3. Immediate treatment steps if a disease or deficiency is detected.
4. Preventive measures to avoid recurrence in the next growth cycle.`;

  navigator.clipboard.writeText(prompt).then(() => {
    const btn = document.getElementById('copyPromptBtn');
    btn.textContent = '✓ Copied! Now open Gemini or ChatGPT ↓';
    btn.style.background = '#2e7d32';
    setTimeout(() => {
      btn.innerHTML = '⎘ Copy AI Prompt';
      btn.style.background = '';
    }, 2500);
  });
});

// ── INIT ───────────────────────────────────────────────
connectMQTT();
