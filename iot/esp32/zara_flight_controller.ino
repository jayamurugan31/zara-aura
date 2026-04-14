#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <ESP32Servo.h>

// WiFi credentials
const char* WIFI_SSID = "Zayma";
const char* WIFI_PASSWORD = "reddragon";

// MQTT broker (local Mosquitto)
const char* MQTT_HOST = "10.67.9.249";
const uint16_t MQTT_PORT = 1884;
const char* MQTT_USER = "";
const char* MQTT_PASSWORD = "";
const char* TOPIC_CONTROL = "zara/flight/control";
const char* TOPIC_STATUS = "zara/flight/status";

#ifndef LED_BUILTIN
#define LED_BUILTIN 2
#endif

// Pin mapping
constexpr uint8_t SERVO_PIN = 18;
constexpr uint8_t ENGINE_PIN = 19;
constexpr uint8_t THROTTLE_PWM_PIN = 21;

// Servo limits
constexpr int SERVO_MIN_DEG = 0;
constexpr int SERVO_MAX_DEG = 180;
constexpr int SERVO_LEFT_DEG = 60;
constexpr int SERVO_RIGHT_DEG = 120;
constexpr int SERVO_CENTER_DEG = 90;

// Throttle PWM (8-bit)
constexpr uint8_t PWM_CHANNEL = 0;
constexpr uint16_t PWM_FREQUENCY_HZ = 5000;
constexpr uint8_t PWM_RESOLUTION_BITS = 8;
constexpr uint8_t THROTTLE_MIN = 0;
constexpr uint8_t THROTTLE_MAX = 255;

WiFiClient wifiClient;
PubSubClient mqttClient(wifiClient);
Servo rudderServo;

bool engineEnabled = false;
uint8_t throttleValue = THROTTLE_MIN;
int servoAngle = SERVO_CENTER_DEG;

unsigned long lastWifiAttemptMs = 0;
unsigned long lastMqttAttemptMs = 0;

int clampServoAngle(int angle) {
  if (angle < SERVO_MIN_DEG) {
    return SERVO_MIN_DEG;
  }
  if (angle > SERVO_MAX_DEG) {
    return SERVO_MAX_DEG;
  }
  return angle;
}

uint8_t clampThrottle(int value) {
  if (value < THROTTLE_MIN) {
    return THROTTLE_MIN;
  }
  if (value > THROTTLE_MAX) {
    return THROTTLE_MAX;
  }
  return static_cast<uint8_t>(value);
}

void publishStatus(const char* status, int value = -1) {
  StaticJsonDocument<256> doc;
  doc["status"] = status;
  doc["engine_on"] = engineEnabled;
  doc["throttle"] = throttleValue;
  doc["servo"] = servoAngle;
  doc["uptime_ms"] = millis();

  if (value >= 0) {
    doc["value"] = value;
  }

  char payload[256];
  const size_t len = serializeJson(doc, payload, sizeof(payload));
  mqttClient.publish(TOPIC_STATUS, payload, len, false);
}

void setServoAngle(int angle) {
  servoAngle = clampServoAngle(angle);
  rudderServo.write(servoAngle);
}

void setThrottle(uint8_t value) {
  throttleValue = clampThrottle(value);
  ledcWrite(PWM_CHANNEL, throttleValue);
}

void applyEmergencyStop() {
  digitalWrite(LED_BUILTIN, LOW);
  engineEnabled = false;
  digitalWrite(ENGINE_PIN, LOW);
  setThrottle(THROTTLE_MIN);
  setServoAngle(SERVO_CENTER_DEG);
}

void handleControlMessage(const JsonDocument& doc) {
  const char* action = doc["action"] | "";
  const int value = doc["value"] | -1;

  if (strcmp(action, "led_on") == 0) {
    digitalWrite(LED_BUILTIN, HIGH);
    publishStatus("led_on");
    return;
  }

  if (strcmp(action, "led_off") == 0) {
    digitalWrite(LED_BUILTIN, LOW);
    publishStatus("led_off");
    return;
  }

  if (strcmp(action, "servo_right") == 0) {
    setServoAngle(value >= 0 ? value : SERVO_RIGHT_DEG);
    publishStatus("servo_moved_right", servoAngle);
    return;
  }

  if (strcmp(action, "servo_left") == 0) {
    setServoAngle(value >= 0 ? value : SERVO_LEFT_DEG);
    publishStatus("servo_moved_left", servoAngle);
    return;
  }

  if (strcmp(action, "engine_on") == 0) {
    engineEnabled = true;
    digitalWrite(ENGINE_PIN, HIGH);
    publishStatus("engine_on");
    return;
  }

  if (strcmp(action, "engine_off") == 0) {
    engineEnabled = false;
    digitalWrite(ENGINE_PIN, LOW);
    setThrottle(THROTTLE_MIN);
    publishStatus("engine_off");
    return;
  }

  if (strcmp(action, "throttle_up") == 0) {
    const int nextThrottle = value >= 0 ? value : throttleValue + 15;
    setThrottle(clampThrottle(nextThrottle));
    publishStatus("throttle_up", throttleValue);
    return;
  }

  if (strcmp(action, "throttle_down") == 0) {
    const int nextThrottle = value >= 0 ? value : throttleValue - 15;
    setThrottle(clampThrottle(nextThrottle));
    publishStatus("throttle_down", throttleValue);
    return;
  }

  if (strcmp(action, "emergency_stop") == 0) {
    applyEmergencyStop();
    publishStatus("emergency_stop");
    return;
  }

  publishStatus("unknown_action");
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  if (strcmp(topic, TOPIC_CONTROL) != 0) {
    return;
  }

  StaticJsonDocument<256> doc;
  DeserializationError error = deserializeJson(doc, payload, length);

  if (error) {
    publishStatus("invalid_json");
    return;
  }

  handleControlMessage(doc);
}

void ensureWifiConnected() {
  if (WiFi.status() == WL_CONNECTED) {
    return;
  }

  const unsigned long now = millis();
  if (now - lastWifiAttemptMs < 5000) {
    return;
  }

  lastWifiAttemptMs = now;
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

void ensureMqttConnected() {
  if (mqttClient.connected() || WiFi.status() != WL_CONNECTED) {
    return;
  }

  const unsigned long now = millis();
  if (now - lastMqttAttemptMs < 2000) {
    return;
  }

  lastMqttAttemptMs = now;

  const bool connected = (strlen(MQTT_USER) > 0)
    ? mqttClient.connect("zara-esp32-flight", MQTT_USER, MQTT_PASSWORD)
    : mqttClient.connect("zara-esp32-flight");

  if (!connected) {
    return;
  }

  mqttClient.subscribe(TOPIC_CONTROL, 1);
  publishStatus("controller_online");
}

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  pinMode(ENGINE_PIN, OUTPUT);

  digitalWrite(LED_BUILTIN, LOW);
  digitalWrite(ENGINE_PIN, LOW);

  ledcSetup(PWM_CHANNEL, PWM_FREQUENCY_HZ, PWM_RESOLUTION_BITS);
  ledcAttachPin(THROTTLE_PWM_PIN, PWM_CHANNEL);
  setThrottle(THROTTLE_MIN);

  rudderServo.setPeriodHertz(50);
  rudderServo.attach(SERVO_PIN, 500, 2400);
  setServoAngle(SERVO_CENTER_DEG);

  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setBufferSize(512);

  ensureWifiConnected();
}

void loop() {
  ensureWifiConnected();
  ensureMqttConnected();

  if (mqttClient.connected()) {
    mqttClient.loop();
  }
}
