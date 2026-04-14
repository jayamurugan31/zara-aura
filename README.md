# ZARA AI

Voice-first AI assistant with a Vite/React frontend and FastAPI backend.

## Project Structure

- `src/`: Frontend (React + TypeScript)
- `backend/`: FastAPI backend, AI routing, voice processing, automation
- `iot/esp32/`: ESP32 Arduino firmware for Flight Mode hardware control

## Local Development

### Frontend

```powershell
npm install
npm run dev
```

### Backend

```powershell
pip install -r backend/requirements.txt
copy backend/.env.example backend/.env
uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000
```

## Flight Mode

Flight Mode adds real-time MQTT control for ESP32 hardware (LED, servo, engine pin, throttle PWM).

- UI toggle: Settings -> Mode -> Flight Mode
- Backend gate: `POST /flight-mode`
- Control topic: `zara/flight/control`
- Status topic: `zara/flight/status`

Detailed setup:

- `backend/FLIGHT_MODE_MQTT.md`
- `iot/esp32/zara_flight_controller.ino`
