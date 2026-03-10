# 🌿 SEKKITO — Plant Intelligence Dashboard

A real-time plant monitoring web dashboard that connects to your ESP32 sensor node, ESP32-CAM, and Raspberry Pi AI engine via MQTT over WebSocket.

## Live Dashboard Features

| Page | Description |
|---|---|
| **Dashboard** | Live sensor gauges — Air Temp, Humidity, Water Level, Light, Water Temp, TDS |
| **Analytics** | Firebase time-series charts with 10M / 1H / 6H / 1D / 3D / 1W range selector |
| **Camera Hub** | Capture plant images via ESP32-CAM, receive via Base64 MQTT, trigger Pi AI analysis |
| **AI Portal** | Generate a diagnosis prompt with live sensor data, open Gemini or ChatGPT |

> No build step required — pure HTML, CSS, and vanilla JS.

## MQTT Topics

| Topic | Direction | Description |
|---|---|---|
| `esp32/sekkito/plant123/sensors` | Subscribe | JSON sensor readings |
| `esp32cam/sekkito/plant123/imagePlant` | Subscribe | Base64 image chunks (START / chunks / END) |
| `esp32cam/sekkito/plant123/capture` | Publish | `"capture"` or `"analyze"` |
| `esp32cam/sekkito/plant123/status` | Subscribe | Status strings from ESP32-CAM / Pi |
| `esp32cam/sekkito/plant123/aiResult` | Subscribe | JSON `{ top_label, all_results }` from Pi |

## Firebase Setup

The Firebase config is already set in `app.js`. The dashboard reads from `/history` for charts and listens to `/current_stats` for live data.

## Dependencies (via CDN — no install needed)

- [MQTT.js](https://github.com/mqttjs/MQTT.js) — WebSocket MQTT client
- [Firebase JS SDK](https://firebase.google.com/docs/web/setup) — Realtime Database
- [Chart.js](https://www.chartjs.org/) + date-fns adapter — Time-series charts
- [Orbitron + Space Mono](https://fonts.google.com/) — Google Fonts

## Architecture

```
ESP32 Sensor Node ──── MQTT ──→ broker.hivemq.com ←──── Web Browser
ESP32-CAM         ──── MQTT ──→        ↑                    │
Raspberry Pi AI   ──── MQTT ──→        │              MQTT.js (WSS)
                                       │                    │
Firebase RTDB ←── ESP32 direct ────────┘        Chart.js + Firebase SDK
```
