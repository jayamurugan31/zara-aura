# ZARA AI Flight Mode (FastAPI + MQTT + ESP32)

This module adds real-time flight hardware control using voice commands.

## End-to-End Flow

Voice Command -> ZARA AI -> FastAPI Automation Engine -> MQTT Broker -> ESP32 -> Hardware Action

## MQTT Topics

- Control topic: `zara/flight/control`
- Status topic: `zara/flight/status`

## Backend APIs

- `POST /flight-mode`
  - Body: `{ "enabled": true }`
  - Enables/disables hardware command publishing.
- `GET /flight-mode`
  - Returns current Flight Mode state.
- `GET /flight/status`
  - Returns broker connection state and latest ESP32 feedback payload.

## Voice Intent to MQTT Mapping

- `start light` -> `led_on`
- `stop light` -> `led_off`
- `turn right` -> `servo_right` (value defaults to 120)
- `turn left` -> `servo_left` (value defaults to 60)
- `start engine` -> `engine_on`
- `stop engine` -> `engine_off`
- `increase speed` -> `throttle_up`
- `decrease speed` -> `throttle_down`
- `emergency stop` -> `emergency_stop`

Example MQTT payload:

```json
{
  "action": "servo_right",
  "value": 120,
  "source": "zara-backend",
  "ts": "2026-04-14T13:17:00.000000+00:00"
}
```

## Safety Behavior

- Servo angles are clamped to `0..180`.
- Throttle is clamped to configured min/max.
- `emergency_stop` immediately sets engine off, throttle to minimum, and safe servo position.
- Commands are blocked when Flight Mode is disabled.
- MQTT publish includes reconnect retries.

## Configuration

Set these in `backend/.env`:

- `FLIGHT_MODE_DEFAULT=false`
- `FLIGHT_MQTT_ENABLED=true`
- `FLIGHT_MQTT_HOST=192.168.x.x`
- `FLIGHT_MQTT_PORT=1883`
- `FLIGHT_MQTT_CONTROL_TOPIC=zara/flight/control`
- `FLIGHT_MQTT_STATUS_TOPIC=zara/flight/status`

Optional tuning:

- `FLIGHT_MQTT_RETRY_ATTEMPTS=3`
- `FLIGHT_MQTT_RETRY_DELAY_MS=250`
- `FLIGHT_MQTT_PUBLISH_TIMEOUT_S=1.5`
- `FLIGHT_THROTTLE_STEP=15`
- `FLIGHT_SERVO_LEFT_ANGLE=60`
- `FLIGHT_SERVO_RIGHT_ANGLE=120`

## ESP32 Firmware

Use the Arduino sketch at:

- `iot/esp32/zara_flight_controller.ino`

Required libraries:

- PubSubClient
- ArduinoJson
- ESP32Servo

The ESP32 sketch:

- Connects to WiFi and MQTT broker.
- Subscribes to `zara/flight/control`.
- Controls LED, servo, engine pin, and PWM throttle.
- Publishes JSON status updates to `zara/flight/status`.
- Implements non-blocking reconnection loops.

## Quick Local Broker

If Mosquitto is not installed locally, you can run it with Docker:

```powershell
docker run --name zara-mqtt -p 1883:1883 -d eclipse-mosquitto
```

Check status stream:

```powershell
mosquitto_sub -h 127.0.0.1 -p 1883 -t zara/flight/status -v
```

Send a test command:

```powershell
mosquitto_pub -h 127.0.0.1 -p 1883 -t zara/flight/control -m '{"action":"led_on"}'
```
