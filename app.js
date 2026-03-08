// ═══════════════════════════════════════════════════════
//  SEKKITO — Plant Intelligence Dashboard
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
const MQTT_WS_URL     = "wss://broker.hivemq.com:8884/mqtt"; // WebSocket TLS port
const TOPIC_SENSORS   = "esp32/sekkito/plant123/sensors";
const TOPIC_IMAGE     = "esp32cam/sekkito/plant123/imagePlant";
const TOPIC_CAPTURE   = "esp32cam/sekkito/plant123/capture";
const TOPIC_STATUS    = "esp32cam/sekkito/plant123/status";
const TOPIC_AI_RESULT = "esp32cam/sekkito/plant123/aiResult";

// ── STATE ──────────────────────────────────────────────
let mqttClient        = null;
let sensorData        = {};
let base64Buffer      = "";
let isReceivingImage  = false;
let isAnalyzing       = false;
let imageDataUrl      = null;
let imageTimeout      = null;
let aiTimeout         = null;

// ── NAVIGATION ─────────────────────────────────────────
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const page = btn.dataset.page;
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`page-${page}`).classList.add('active');
    if (page === 'analytics') loadCharts();
    // Close sidebar on mobile
    document.getElementById('sidebar').classList.remove('open');
  });
});

// Hamburger
document.getElementById('hamburger').addEventListener('click', () => {
  document.getElementById('sidebar').classList.toggle('open');
});

// ── MQTT CONNECT ───────────────────────────────────────
function connectMQTT() {
  const clientId = `sekkito_web_${Date.now()}`;
  mqttClient = mqtt.connect(MQTT_WS_URL, {
    clientId,
    keepalive: 20,
    reconnectPeriod: 3000,
    connectTimeout: 10000,
  });

  mqttClient.on('connect', () => {
    setStatus(true);
    mqttClient.subscribe([TOPIC_SENSORS, TOPIC_IMAGE, TOPIC_STATUS, TOPIC_AI_RESULT]);
  });

  mqttClient.on('disconnect', () => setStatus(false));
  mqttClient.on('error', () => setStatus(false));
  mqttClient.on('offline', () => setStatus(false));

  mqttClient.on('message', (topic, payload) => {
    const str = payload.toString('utf8');
    handleMessage(topic, str, payload);
  });
}

function setStatus(online) {
  const dot  = document.getElementById('statusDot');
  const text = document.getElementById('statusText');
  dot.className  = 'status-dot' + (online ? ' online' : '');
  text.textContent = online ? 'ONLINE' : 'OFFLINE';
}

// ── MESSAGE HANDLER ────────────────────────────────────
function handleMessage(topic, str, rawPayload) {

  // ── Sensor data ──────────────────────────────────────
  if (topic === TOPIC_SENSORS) {
    try {
      const data = JSON.parse(str);
      sensorData = data;
      updateGauges(data);
      updateSnapshots(data);
      document.getElementById('lastUpdated').textContent =
        `— last update: ${new Date().toLocaleTimeString()}`;
    } catch(e) { console.warn('Sensor parse error', e); }
    return;
  }

  // ── Camera status ────────────────────────────────────
  if (topic === TOPIC_STATUS) {
    setCamStatus(str.replace(/_/g, ' '));
    return;
  }

  // ── AI result ────────────────────────────────────────
  if (topic === TOPIC_AI_RESULT) {
    clearTimeout(aiTimeout);
    try {
      const decoded    = JSON.parse(str);
      const label      = decoded.top_label || 'Unknown';
      const allResults = decoded.all_results || [];
      const topConf    = allResults.length ? allResults[0].confidence : 0;

      isAnalyzing = false;
      setAiBtn(false);
      document.getElementById('aiResultBadge').style.display = 'block';
      document.getElementById('aiResultBadge').textContent   = `◆ ${label} (${topConf.toFixed(1)}%)`;
      setCamStatus(`✓ AI Done: ${label}`);
      showAiModal(allResults);
    } catch(e) {
      isAnalyzing = false;
      setAiBtn(false);
      setCamStatus('AI Result Error');
    }
    return;
  }

  // ── Image transfer (Base64 chunked) ─────────────────
  if (topic === TOPIC_IMAGE) {
    if (str === 'START') {
      clearTimeout(imageTimeout);
      base64Buffer     = '';
      isReceivingImage = true;
      setPreviewReceiving(true);
      showTransferBar(true);
      setCamStatus('Receiving image...');

      // 20s timeout for full transfer
      imageTimeout = setTimeout(() => {
        if (isReceivingImage) {
          isReceivingImage = false;
          setPreviewReceiving(false);
          showTransferBar(false);
          setCamStatus('⏱ Transfer timed out');
          setCaptureBtn(false);
        }
      }, 20000);

    } else if (str === 'END') {
      clearTimeout(imageTimeout);
      if (base64Buffer.length > 0) {
        try {
          imageDataUrl = `data:image/jpeg;base64,${base64Buffer}`;
          const img = document.getElementById('capturedImage');
          img.src = imageDataUrl;
          img.style.display = 'block';
          document.getElementById('noImageMsg').style.display = 'none';
          isReceivingImage = false;
          setPreviewReceiving(false);
          showTransferBar(false);
          setCamStatus("Image ready — tap Fast AI Analysis");
          setCaptureBtn(false);
          document.getElementById('saveBtn').disabled = false;
          document.getElementById('aiBtn').disabled   = false;
          base64Buffer = '';
        } catch(e) {
          isReceivingImage = false;
          setPreviewReceiving(false);
          showTransferBar(false);
          setCamStatus('Image decode failed');
          setCaptureBtn(false);
        }
      }
    } else {
      // Accumulate Base64 chunks
      if (isReceivingImage) {
        base64Buffer += str;
        // Animate transfer bar (rough progress indication)
        const bar = document.getElementById('transferFill');
        const approxPct = Math.min(95, (base64Buffer.length / 150000) * 100);
        bar.style.width = approxPct + '%';
      }
    }
  }
}

// ── GAUGES ─────────────────────────────────────────────
const GAUGE_CONFIG = {
  air_temp:    { min: 0, max: 50,   color: '#ff7f50', unit: '°C'  },
  air_hum:     { min: 0, max: 100,  color: '#4fc3f7', unit: '%'   },
  water_level: { min: 0, max: 100,  color: '#00e5ff', unit: '%'   },
  light:       { min: 0, max: 100,  color: '#ffe57f', unit: '%'   },
  water_temp:  { min: 0, max: 50,   color: '#69f0ae', unit: '°C'  },
  tds:         { min: 0, max: 1000, color: '#ea80ff', unit: 'ppm' },
};

// Sensor key mapping from MQTT payload keys
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
    if (data[k] !== undefined) return parseFloat(data[k]) || 0;
  }
  return null;
}

// SVG arc path for semicircle gauge
// Arc from 180° to 0° (left to right), parameterised by pct 0-1
function arcPath(pct) {
  // Center (60,65), radius 50, sweep from left(10,65) to right(110,65)
  const cx = 60, cy = 65, r = 50;
  const startAngle = Math.PI;          // 180° = left
  const endAngle   = startAngle - (pct * Math.PI); // sweeps right
  const x = cx + r * Math.cos(endAngle);
  const y = cy + r * Math.sin(endAngle);
  const large = pct > 0.5 ? 1 : 0;
  // From (10,65) to (x,y) going counter-clockwise
  return `M10,65 A${r},${r} 0 ${large},1 ${x.toFixed(2)},${y.toFixed(2)}`;
}

function updateGauges(data) {
  for (const [key, cfg] of Object.entries(GAUGE_CONFIG)) {
    const val = getVal(data, key);
    if (val === null) continue;
    const pct     = Math.max(0, Math.min(1, (val - cfg.min) / (cfg.max - cfg.min)));
    const arcEl   = document.getElementById(`arc-${key}`);
    const valEl   = document.getElementById(`val-${key}`);
    if (arcEl) arcEl.setAttribute('d', pct > 0.005 ? arcPath(pct) : 'M10,65 A50,50 0 0,1 10,65');
    if (valEl) valEl.textContent = val.toFixed(1);
  }
}

function updateSnapshots(data) {
  for (const key of Object.keys(GAUGE_CONFIG)) {
    const el  = document.getElementById(`snap-${key}`);
    const cfg = GAUGE_CONFIG[key];
    const val = getVal(data, key);
    if (el && val !== null) el.textContent = `${val.toFixed(1)} ${cfg.unit}`;
  }
}

// ── CHARTS ─────────────────────────────────────────────
const CHART_DEFS = [
  { id: 'chart-air_temp',    label: 'Air Temp (°C)',     fbKey: 'air_temp',    color: '#ff7f50' },
  { id: 'chart-air_hum',     label: 'Humidity (%)',      fbKey: 'humidity',    color: '#4fc3f7' },
  { id: 'chart-water_level', label: 'Water Level (%)',   fbKey: 'water_level', color: '#00e5ff' },
  { id: 'chart-light',       label: 'Light Intensity (%)', fbKey: 'light',     color: '#ffe57f' },
];

let chartInstances = {};
let selectedRange  = 3600000; // 1H default

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
    const raw = snap.val() || {};
    const rows = Object.values(raw).filter(v => v.timestamp);
    rows.sort((a, b) => a.timestamp - b.timestamp);

    CHART_DEFS.forEach(def => {
      const canvas = document.getElementById(def.id);
      if (!canvas) return;

      const points = rows
        .filter(r => r[def.fbKey] !== undefined && r[def.fbKey] !== null)
        .map(r => ({ x: new Date(r.timestamp), y: parseFloat(r[def.fbKey]) }));

      if (chartInstances[def.id]) {
        chartInstances[def.id].destroy();
      }

      chartInstances[def.id] = new Chart(canvas, {
        type: 'line',
        data: {
          datasets: [{
            label: def.label,
            data: points,
            borderColor: def.color,
            backgroundColor: def.color + '22',
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.4,
            fill: true,
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { labels: { color: '#aaa', font: { family: 'Space Mono', size: 10 } } },
          },
          scales: {
            x: {
              type: 'time',
              time: { tooltipFormat: 'HH:mm' },
              ticks: { color: '#555', font: { size: 9 } },
              grid:  { color: 'rgba(255,255,255,0.04)' },
            },
            y: {
              ticks: { color: '#555', font: { size: 9 } },
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
  if (!mqttClient || !mqttClient.connected) {
    setCamStatus('Not connected to MQTT');
    return;
  }
  setCaptureBtn(true);
  setCamStatus('Sending capture command...');
  document.getElementById('aiResultBadge').style.display = 'none';
  mqttClient.publish(TOPIC_CAPTURE, 'capture');

  // 8s timeout waiting for ESP32-CAM to respond with START
  clearTimeout(imageTimeout);
  imageTimeout = setTimeout(() => {
    if (isReceivingImage && base64Buffer.length === 0) {
      isReceivingImage = false;
      setCaptureBtn(false);
      setCamStatus('⏱ No response from ESP32-CAM');
    }
  }, 8000);
});

document.getElementById('saveBtn').addEventListener('click', () => {
  if (!imageDataUrl) return;
  const a = document.createElement('a');
  a.href     = imageDataUrl;
  a.download = `plant_${Date.now()}.jpg`;
  a.click();
});

document.getElementById('aiBtn').addEventListener('click', () => {
  if (!mqttClient || !mqttClient.connected) {
    setCamStatus('Not connected to MQTT');
    return;
  }
  isAnalyzing = true;
  setAiBtn(true);
  setCamStatus('Requesting AI analysis...');
  mqttClient.publish(TOPIC_CAPTURE, 'analyze');

  clearTimeout(aiTimeout);
  aiTimeout = setTimeout(() => {
    if (isAnalyzing) {
      isAnalyzing = false;
      setAiBtn(false);
      setCamStatus('⏱ AI timed out — no response from Pi');
    }
  }, 8000);
});

// ── CAMERA UI HELPERS ──────────────────────────────────
function setCamStatus(msg) {
  document.getElementById('camStatus').textContent = msg;
}

function setCaptureBtn(busy) {
  const btn = document.getElementById('captureBtn');
  btn.disabled = busy;
  btn.innerHTML = busy
    ? '<span class="btn-icon">◌</span> PROCESSING...'
    : '<span class="btn-icon">◎</span> CAPTURE';
}

function setAiBtn(busy) {
  const btn = document.getElementById('aiBtn');
  btn.disabled = busy;
  btn.innerHTML = busy
    ? '<span class="btn-icon">◌</span> ANALYZING...'
    : '<span class="btn-icon">◆</span> FAST AI ANALYSIS';
}

function setPreviewReceiving(on) {
  document.getElementById('cameraPreview').classList.toggle('receiving', on);
}

function showTransferBar(on) {
  const bar = document.getElementById('transferBar');
  bar.style.display = on ? 'block' : 'none';
  if (!on) document.getElementById('transferFill').style.width = '0%';
}

// ── AI MODAL ───────────────────────────────────────────
function showAiModal(allResults) {
  const container = document.getElementById('modalResults');
  container.innerHTML = '';

  allResults.forEach((res, i) => {
    const label  = (res.label || '').replace(/_/g, ' ');
    const conf   = parseFloat(res.confidence) || 0;
    const isTop  = i === 0;
    const color  = isTop ? '#00e5d0' : 'rgba(199,125,255,0.5)';

    container.innerHTML += `
      <div class="modal-result-item">
        <div class="modal-result-row">
          <span class="modal-result-name ${isTop ? 'top' : 'other'}">
            ${isTop ? '★ ' : ''}${label}
          </span>
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
  const plant   = document.getElementById('plantName').value || 'Unknown';
  const stage   = document.getElementById('growthStage').value;
  const symptoms= document.getElementById('symptoms').value || 'None described';

  const s = sensorData;
  const prompt = `PLANT HEALTH DIAGNOSIS REQUEST
------------------------------
Plant Type: ${plant}
Growth Stage: ${stage}
Observed Symptoms: ${symptoms}

LIVE SENSOR DATA (SEKKITO):
- Air Temperature: ${getVal(s,'air_temp') ?? '--'}°C
- Humidity: ${getVal(s,'air_hum') ?? '--'}%
- Light Intensity: ${getVal(s,'light') ?? '--'}%
- Water Level: ${getVal(s,'water_level') ?? '--'}%
- Water Temperature: ${getVal(s,'water_temp') ?? '--'}°C
- Nutrient Concentration (TDS): ${getVal(s,'tds') ?? '--'} PPM

INSTRUCTIONS:
Based on the image provided and the sensor data above, please provide:
1. A possible diagnosis of the plant's health.
2. Recommended adjustments to the nutrients or environment.
3. Steps for immediate treatment if a disease is detected.`;

  navigator.clipboard.writeText(prompt).then(() => {
    const btn = document.getElementById('copyPromptBtn');
    btn.textContent = '✓ Copied!';
    setTimeout(() => btn.innerHTML = '⎘ Copy AI Prompt', 2000);
  });
});

// ── INIT ───────────────────────────────────────────────
connectMQTT();
