from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging
import threading
import time
from typing import Any

import paho.mqtt.client as mqtt

from app.config import Settings


logger = logging.getLogger(__name__)


class MQTTFlightController:
    """MQTT bridge between backend voice intents and ESP32 flight hardware."""

    SUPPORTED_ACTIONS: set[str] = {
        "led_on",
        "led_off",
        "servo_right",
        "servo_left",
        "engine_on",
        "engine_off",
        "throttle_up",
        "throttle_down",
        "emergency_stop",
    }

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._connected = False
        self._loop_started = False
        self._state_lock = threading.Lock()
        self._connection_lock = threading.Lock()

        self._engine_enabled = False
        self._throttle = settings.flight_throttle_min

        self._last_status: dict[str, Any] | None = None
        self._last_status_at: dt.datetime | None = None

        client_kwargs: dict[str, Any] = {
            "client_id": settings.flight_mqtt_client_id,
            "protocol": mqtt.MQTTv311,
            "transport": "tcp",
        }

        # paho-mqtt >=2.0 requires an explicit callback API version for legacy callback signatures.
        if hasattr(mqtt, "CallbackAPIVersion"):
            client_kwargs["callback_api_version"] = mqtt.CallbackAPIVersion.VERSION1

        self._client = mqtt.Client(**client_kwargs)

        if settings.flight_mqtt_username:
            self._client.username_pw_set(
                username=settings.flight_mqtt_username,
                password=settings.flight_mqtt_password or None,
            )

        retry_delay_s = max(0.05, settings.flight_mqtt_retry_delay_ms / 1000.0)
        self._client.reconnect_delay_set(min_delay=retry_delay_s, max_delay=max(1.0, retry_delay_s * 10))

        self._client.on_connect = self._on_connect
        self._client.on_disconnect = self._on_disconnect
        self._client.on_message = self._on_message

    def start(self) -> None:
        if not self.settings.flight_mqtt_enabled:
            logger.info("Flight MQTT is disabled")
            return

        with self._connection_lock:
            if self._loop_started:
                return

            self._client.connect_async(
                host=self.settings.flight_mqtt_host,
                port=self.settings.flight_mqtt_port,
                keepalive=max(10, self.settings.flight_mqtt_keepalive_s),
            )
            self._client.loop_start()
            self._loop_started = True
            logger.info(
                "Flight MQTT loop started for broker %s:%s",
                self.settings.flight_mqtt_host,
                self.settings.flight_mqtt_port,
            )

    def stop(self) -> None:
        with self._connection_lock:
            if not self._loop_started:
                return

            try:
                self._client.disconnect()
            except Exception:
                logger.debug("MQTT disconnect failed during shutdown", exc_info=True)
            finally:
                self._client.loop_stop()
                self._loop_started = False
                self._connected = False

    async def publish_action(self, action: str, value: int | None = None) -> dict[str, Any]:
        normalized_action = action.strip().lower()
        if normalized_action not in self.SUPPORTED_ACTIONS:
            return {
                "type": normalized_action,
                "domain": "flight",
                "status": "failed",
                "error": f"Unsupported flight action: {normalized_action}",
            }

        command = self._build_command(normalized_action, value)
        message = {
            **command,
            "source": "zara-backend",
            "ts": dt.datetime.now(dt.timezone.utc).isoformat(),
        }

        if not self.settings.flight_mqtt_enabled:
            return {
                "type": normalized_action,
                "domain": "flight",
                "status": "failed",
                "error": "Flight MQTT is disabled by configuration",
            }

        try:
            await asyncio.to_thread(self._publish_json, message)
            return {
                "type": normalized_action,
                "action": command["action"],
                "value": command.get("value"),
                "domain": "flight",
                "status": "executed",
                "target": f"mqtt://{self.settings.flight_mqtt_host}:{self.settings.flight_mqtt_port}",
                "topic": self.settings.flight_mqtt_control_topic,
                "connected": self._connected,
            }
        except Exception as exc:
            logger.warning("Failed to publish flight action %s: %s", normalized_action, exc)
            return {
                "type": normalized_action,
                "action": command["action"],
                "value": command.get("value"),
                "domain": "flight",
                "status": "failed",
                "error": str(exc),
                "target": f"mqtt://{self.settings.flight_mqtt_host}:{self.settings.flight_mqtt_port}",
                "topic": self.settings.flight_mqtt_control_topic,
            }

    def status_snapshot(self) -> dict[str, Any]:
        with self._state_lock:
            last_status = dict(self._last_status) if isinstance(self._last_status, dict) else self._last_status
            last_status_at = self._last_status_at.isoformat() if self._last_status_at else None

        return {
            "connected": self._connected,
            "broker": f"{self.settings.flight_mqtt_host}:{self.settings.flight_mqtt_port}",
            "control_topic": self.settings.flight_mqtt_control_topic,
            "status_topic": self.settings.flight_mqtt_status_topic,
            "last_status": last_status,
            "last_status_at": last_status_at,
        }

    def _build_command(self, action: str, value: int | None) -> dict[str, Any]:
        with self._state_lock:
            if action == "servo_right":
                angle = self._clamp_servo(value if value is not None else self.settings.flight_servo_right_angle)
                return {"action": "servo_right", "value": angle}

            if action == "servo_left":
                angle = self._clamp_servo(value if value is not None else self.settings.flight_servo_left_angle)
                return {"action": "servo_left", "value": angle}

            if action == "engine_on":
                self._engine_enabled = True
                return {"action": "engine_on", "value": 1}

            if action == "engine_off":
                self._engine_enabled = False
                self._throttle = self.settings.flight_throttle_min
                return {"action": "engine_off", "value": 0}

            if action == "throttle_up":
                next_value = self._throttle + max(1, self.settings.flight_throttle_step)
                self._throttle = self._clamp_throttle(next_value)
                return {"action": "throttle_up", "value": self._throttle}

            if action == "throttle_down":
                next_value = self._throttle - max(1, self.settings.flight_throttle_step)
                self._throttle = self._clamp_throttle(next_value)
                return {"action": "throttle_down", "value": self._throttle}

            if action == "emergency_stop":
                self._engine_enabled = False
                self._throttle = self.settings.flight_throttle_min
                return {"action": "emergency_stop", "value": 0}

            # led_on/led_off have no numeric payload requirement.
            return {"action": action}

    def _publish_json(self, payload: dict[str, Any]) -> None:
        if not self._loop_started:
            self.start()

        if not self._connected:
            self._retry_connection()

        qos = min(2, max(0, self.settings.flight_mqtt_qos))
        encoded_payload = json.dumps(payload, separators=(",", ":"), ensure_ascii=True)
        result = self._client.publish(self.settings.flight_mqtt_control_topic, encoded_payload, qos=qos, retain=False)

        if result.rc != mqtt.MQTT_ERR_SUCCESS:
            raise RuntimeError(f"MQTT publish failed with code {result.rc}")

        result.wait_for_publish(timeout=max(0.2, self.settings.flight_mqtt_publish_timeout_s))
        if not result.is_published():
            raise RuntimeError("MQTT publish timed out")

    def _retry_connection(self) -> None:
        attempts = max(1, self.settings.flight_mqtt_retry_attempts)
        retry_delay_s = max(0.05, self.settings.flight_mqtt_retry_delay_ms / 1000.0)

        for attempt in range(1, attempts + 1):
            if self._connected:
                return

            try:
                self._client.reconnect()
            except Exception as exc:
                logger.debug("MQTT reconnect attempt %s failed: %s", attempt, exc)

            deadline = time.monotonic() + max(0.2, self.settings.flight_mqtt_publish_timeout_s)
            while time.monotonic() < deadline:
                if self._connected:
                    return
                time.sleep(0.03)

            if attempt < attempts:
                time.sleep(retry_delay_s)

        raise RuntimeError("Unable to connect to MQTT broker after retries")

    def _clamp_servo(self, value: int) -> int:
        return max(0, min(180, int(value)))

    def _clamp_throttle(self, value: int) -> int:
        minimum = min(self.settings.flight_throttle_min, self.settings.flight_throttle_max)
        maximum = max(self.settings.flight_throttle_min, self.settings.flight_throttle_max)
        return max(minimum, min(maximum, int(value)))

    def _on_connect(self, _client: mqtt.Client, _userdata: Any, _flags: Any, reason_code: Any) -> None:
        try:
            code = int(reason_code)
        except Exception:
            code = 1

        self._connected = code == 0

        if self._connected:
            qos = min(2, max(0, self.settings.flight_mqtt_qos))
            self._client.subscribe(self.settings.flight_mqtt_status_topic, qos=qos)
            logger.info("Connected to MQTT broker and subscribed to %s", self.settings.flight_mqtt_status_topic)
        else:
            logger.warning("MQTT connection failed with reason code=%s", reason_code)

    def _on_disconnect(self, _client: mqtt.Client, _userdata: Any, reason_code: Any) -> None:
        self._connected = False
        logger.warning("Disconnected from MQTT broker (reason=%s)", reason_code)

    def _on_message(self, _client: mqtt.Client, _userdata: Any, message: mqtt.MQTTMessage) -> None:
        raw = message.payload.decode("utf-8", errors="ignore").strip()
        parsed: dict[str, Any]

        try:
            payload = json.loads(raw) if raw else {}
            if isinstance(payload, dict):
                parsed = payload
            else:
                parsed = {"message": payload}
        except json.JSONDecodeError:
            parsed = {"message": raw}

        parsed.setdefault("topic", message.topic)

        with self._state_lock:
            self._last_status = parsed
            self._last_status_at = dt.datetime.now(dt.timezone.utc)
