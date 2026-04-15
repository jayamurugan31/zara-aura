#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <ESP32Servo.h>

#if __has_include(<esp_arduino_version.h>)
#include <esp_arduino_version.h>
#endif

// WiFi credentials
const char* WIFI_SSID = "Zayma";
const char* WIFI_PASSWORD = "reddragon";

// MQTT broker (HiveMQ Cloud)
const char* MQTT_HOST = "e5c35c674acb4ec6bdb8514fa465cfa6.s1.eu.hivemq.cloud";
const uint16_t MQTT_PORT = 8883;
const char* MQTT_USER = "Zayma";
const char* MQTT_PASSWORD = "Reddragon123";
const char* TOPIC_CONTROL = "zara/flight/control";
const char* TOPIC_STATUS = "zara/flight/status";

// Set true when using a cloud broker on TLS port (usually 8883).
const bool MQTT_USE_TLS = true;

// Paste the broker root CA PEM when available. Leave empty to fallback to insecure TLS mode.
const char* MQTT_ROOT_CA = "";

#ifndef LED_BUILTIN
#define LED_BUILTIN 2
#endif

// BLDC motor (ESC signal on GPIO5)
constexpr uint8_t BLDC_SIGNAL_PIN = 5;
constexpr uint8_t ENGINE_PWM_CHANNEL = 1;
constexpr uint16_t ENGINE_PWM_FREQUENCY_HZ = 50;
constexpr uint8_t ENGINE_PWM_RESOLUTION_BITS = 16;
constexpr uint16_t ESC_MIN_US = 1000;
constexpr uint16_t ESC_MAX_US = 2000;
constexpr uint16_t ESC_STOP_US = ESC_MIN_US;
constexpr uint16_t ESC_SPIN_US = 1300;
constexpr uint16_t ESC_START_BOOST_US = 1450;
constexpr uint16_t ESC_START_BOOST_MS = 350;
constexpr uint16_t ESC_ARM_DELAY_MS = 2500;

// Control surfaces
constexpr uint8_t RUDDER_PIN = 18;
constexpr uint8_t ELEVATOR_PIN = 19;
constexpr uint8_t AILERON_PIN = 21;
constexpr int SERVO_CENTER_ANGLE = 90;
constexpr int RUDDER_RIGHT_ANGLE = 45;
constexpr int RUDDER_LEFT_ANGLE = 135;
constexpr int ELEVATOR_UP_ANGLE = 45;
constexpr int ELEVATOR_DOWN_ANGLE = 135;
constexpr int AILERON_RIGHT_ANGLE = 45;
constexpr int AILERON_LEFT_ANGLE = 135;
constexpr uint16_t CONTROL_SURFACE_HOLD_MS = 800;

// Throttle level bridge (backend uses 0..255 by default).
constexpr int THROTTLE_MIN_LEVEL = 0;
constexpr int THROTTLE_MAX_LEVEL = 255;
constexpr int THROTTLE_STEP_LEVEL = 15;
constexpr int THROTTLE_DEFAULT_START_LEVEL = 80;

WiFiClient wifiClient;
WiFiClientSecure secureClient;
PubSubClient mqttClient;
Servo rudderServo;
Servo elevatorServo;
Servo aileronServo;

bool ledOn = false;
bool engineOn = false;
bool enginePwmReady = false;
bool controlSurfacesReady = false;
uint16_t enginePulseUs = ESC_STOP_US;
int throttleLevel = THROTTLE_MIN_LEVEL;
bool wifiConnectionLogged = false;
bool mqttConnectionLogged = false;
char mqttClientId[40] = {0};

unsigned long lastWifiAttemptMs = 0;
unsigned long lastMqttAttemptMs = 0;

void publishStatus(const char* status) {
  StaticJsonDocument<256> doc;
  doc["status"] = status;
  doc["led_on"] = ledOn;
  doc["engine_on"] = engineOn;
  doc["throttle_level"] = throttleLevel;
  doc["engine_signal_us"] = enginePulseUs;
  doc["control_surfaces_ready"] = controlSurfacesReady;
  doc["uptime_ms"] = millis();

  char payload[256];
  const size_t len = serializeJson(doc, payload, sizeof(payload));
  mqttClient.publish(TOPIC_STATUS, reinterpret_cast<const uint8_t*>(payload), static_cast<unsigned int>(len), false);
}

uint32_t escPulseUsToDuty(uint16_t pulseUs) {
  const uint32_t pwmPeriodUs = 1000000UL / ENGINE_PWM_FREQUENCY_HZ;
  const uint32_t maxDuty = (1UL << ENGINE_PWM_RESOLUTION_BITS) - 1UL;
  return static_cast<uint32_t>((static_cast<uint64_t>(pulseUs) * maxDuty) / pwmPeriodUs);
}

uint16_t clampEscPulseUs(int pulseUs) {
  if (pulseUs < static_cast<int>(ESC_MIN_US)) {
    return ESC_MIN_US;
  }
  if (pulseUs > static_cast<int>(ESC_MAX_US)) {
    return ESC_MAX_US;
  }
  return static_cast<uint16_t>(pulseUs);
}

void initEnginePwm() {
#if defined(ESP_ARDUINO_VERSION_MAJOR) && (ESP_ARDUINO_VERSION_MAJOR >= 3)
  enginePwmReady = ledcAttach(BLDC_SIGNAL_PIN, ENGINE_PWM_FREQUENCY_HZ, ENGINE_PWM_RESOLUTION_BITS);
#else
  ledcSetup(ENGINE_PWM_CHANNEL, ENGINE_PWM_FREQUENCY_HZ, ENGINE_PWM_RESOLUTION_BITS);
  ledcAttachPin(BLDC_SIGNAL_PIN, ENGINE_PWM_CHANNEL);
  enginePwmReady = true;
#endif
}

void writeEscPulseUs(uint16_t pulseUs) {
  if (!enginePwmReady) {
    return;
  }

  const uint16_t clampedPulseUs = clampEscPulseUs(pulseUs);
  const uint32_t duty = escPulseUsToDuty(clampedPulseUs);
#if defined(ESP_ARDUINO_VERSION_MAJOR) && (ESP_ARDUINO_VERSION_MAJOR >= 3)
  ledcWrite(BLDC_SIGNAL_PIN, duty);
#else
  ledcWrite(ENGINE_PWM_CHANNEL, duty);
#endif
}

int clampThrottleLevel(int level) {
  if (level < THROTTLE_MIN_LEVEL) {
    return THROTTLE_MIN_LEVEL;
  }
  if (level > THROTTLE_MAX_LEVEL) {
    return THROTTLE_MAX_LEVEL;
  }
  return level;
}

uint16_t throttleLevelToPulseUs(int level) {
  const int clampedLevel = clampThrottleLevel(level);
  return static_cast<uint16_t>(map(clampedLevel, THROTTLE_MIN_LEVEL, THROTTLE_MAX_LEVEL, ESC_MIN_US, ESC_MAX_US));
}

int pulseUsToThrottleLevel(uint16_t pulseUs) {
  const uint16_t clampedPulseUs = clampEscPulseUs(pulseUs);
  return clampThrottleLevel(map(clampedPulseUs, ESC_MIN_US, ESC_MAX_US, THROTTLE_MIN_LEVEL, THROTTLE_MAX_LEVEL));
}

int clampServoAngle(int angle) {
  if (angle < 0) {
    return 0;
  }
  if (angle > 180) {
    return 180;
  }
  return angle;
}

void centerControlSurfaces() {
  if (!controlSurfacesReady) {
    return;
  }

  rudderServo.write(SERVO_CENTER_ANGLE);
  elevatorServo.write(SERVO_CENTER_ANGLE);
  aileronServo.write(SERVO_CENTER_ANGLE);
}

void moveSurface(Servo& surface, int targetAngle) {
  if (!controlSurfacesReady) {
    return;
  }

  surface.write(clampServoAngle(targetAngle));
  delay(CONTROL_SURFACE_HOLD_MS);
  surface.write(SERVO_CENTER_ANGLE);
}

void turnRight() {
  moveSurface(rudderServo, RUDDER_RIGHT_ANGLE);
}

void turnLeft() {
  moveSurface(rudderServo, RUDDER_LEFT_ANGLE);
}

void upward() {
  moveSurface(elevatorServo, ELEVATOR_UP_ANGLE);
}

void downward() {
  moveSurface(elevatorServo, ELEVATOR_DOWN_ANGLE);
}

void rightRoll() {
  moveSurface(aileronServo, AILERON_RIGHT_ANGLE);
}

void leftRoll() {
  moveSurface(aileronServo, AILERON_LEFT_ANGLE);
}

void controlCheck() {
  turnRight();
  turnLeft();
  upward();
  downward();
  rightRoll();
  leftRoll();
}

void initControlSurfaces() {
  rudderServo.setPeriodHertz(50);
  elevatorServo.setPeriodHertz(50);
  aileronServo.setPeriodHertz(50);

  rudderServo.attach(RUDDER_PIN, 500, 2400);
  elevatorServo.attach(ELEVATOR_PIN, 500, 2400);
  aileronServo.attach(AILERON_PIN, 500, 2400);

  controlSurfacesReady = rudderServo.attached() && elevatorServo.attached() && aileronServo.attached();
  if (!controlSurfacesReady) {
    Serial.println("[SERVO] Failed to initialize one or more control surfaces.");
    return;
  }

  centerControlSurfaces();
  Serial.println("[SERVO] Control surfaces ready.");
}

void setEngineState(bool enabled, int requestedPulseUs = -1) {
  if (!enabled) {
    engineOn = false;
    throttleLevel = THROTTLE_MIN_LEVEL;
    enginePulseUs = ESC_STOP_US;
    writeEscPulseUs(enginePulseUs);
    return;
  }

  int effectiveThrottleLevel = throttleLevel;
  uint16_t targetPulseUs = ESC_SPIN_US;

  if (requestedPulseUs >= static_cast<int>(ESC_MIN_US) && requestedPulseUs <= static_cast<int>(ESC_MAX_US)) {
    targetPulseUs = static_cast<uint16_t>(requestedPulseUs);
    effectiveThrottleLevel = pulseUsToThrottleLevel(targetPulseUs);
  } else {
    if (effectiveThrottleLevel <= THROTTLE_MIN_LEVEL) {
      effectiveThrottleLevel = THROTTLE_DEFAULT_START_LEVEL;
    }
    targetPulseUs = throttleLevelToPulseUs(effectiveThrottleLevel);
  }

  // Give a short startup boost so BLDC can overcome static friction.
  const uint16_t boostPulseUs = targetPulseUs < ESC_START_BOOST_US ? ESC_START_BOOST_US : targetPulseUs;
  writeEscPulseUs(boostPulseUs);
  delay(ESC_START_BOOST_MS);

  throttleLevel = clampThrottleLevel(effectiveThrottleLevel);
  engineOn = true;
  enginePulseUs = targetPulseUs;
  writeEscPulseUs(enginePulseUs);
}

void setThrottleLevel(int level, bool autoStart = true) {
  throttleLevel = clampThrottleLevel(level);

  if (throttleLevel <= THROTTLE_MIN_LEVEL) {
    if (engineOn) {
      setEngineState(false);
    }
    return;
  }

  if (!engineOn && autoStart) {
    setEngineState(true);
    return;
  }

  if (engineOn) {
    enginePulseUs = throttleLevelToPulseUs(throttleLevel);
    writeEscPulseUs(enginePulseUs);
  }
}

void increaseThrottle(int requestedLevel = -1) {
  if (requestedLevel >= THROTTLE_MIN_LEVEL) {
    setThrottleLevel(requestedLevel);
    return;
  }

  setThrottleLevel(throttleLevel + THROTTLE_STEP_LEVEL);
}

void decreaseThrottle(int requestedLevel = -1) {
  if (requestedLevel >= THROTTLE_MIN_LEVEL) {
    setThrottleLevel(requestedLevel, false);
    return;
  }

  setThrottleLevel(throttleLevel - THROTTLE_STEP_LEVEL, false);
}

void applyEngineFailsafe(const char* reason) {
  if (!engineOn) {
    centerControlSurfaces();
    return;
  }

  setEngineState(false);
  centerControlSurfaces();
  Serial.print("[ENGINE] FAILSAFE OFF: ");
  Serial.println(reason);
}

String normalizeCommand(const char* raw) {
  String cmd = String(raw ? raw : "");
  cmd.trim();
  cmd.toLowerCase();
  while (cmd.indexOf("  ") >= 0) {
    cmd.replace("  ", " ");
  }
  return cmd;
}

bool isTurnOnLightsCommand(const String& cmd) {
  return cmd == "turn on lights" || cmd == "turn on light" || cmd == "start light";
}

bool isTurnOffLightsCommand(const String& cmd) {
  return cmd == "turn off lights" || cmd == "turn off light" || cmd == "stop light";
}

bool isTurnOnEngineCommand(const String& cmd) {
  return cmd == "turn on engine" || cmd == "start engine" || cmd == "engine on" || cmd == "turn on motor";
}

bool isTurnOffEngineCommand(const String& cmd) {
  return cmd == "turn off engine" || cmd == "stop engine" || cmd == "engine off" || cmd == "turn off motor";
}

bool isTurnRightCommand(const String& cmd) {
  return cmd == "turn right" || cmd == "move right" || cmd == "servo right";
}

bool isTurnLeftCommand(const String& cmd) {
  return cmd == "turn left" || cmd == "move left" || cmd == "servo left";
}

bool isUpwardCommand(const String& cmd) {
  return cmd == "upward" || cmd == "move up" || cmd == "elevator up" || cmd == "pitch up";
}

bool isDownwardCommand(const String& cmd) {
  return cmd == "downward" || cmd == "move down" || cmd == "elevator down" || cmd == "pitch down";
}

bool isRightRollCommand(const String& cmd) {
  return cmd == "right roll" || cmd == "roll right" || cmd == "bank right" || cmd == "aileron right";
}

bool isLeftRollCommand(const String& cmd) {
  return cmd == "left roll" || cmd == "roll left" || cmd == "bank left" || cmd == "aileron left";
}

bool isControlCheckCommand(const String& cmd) {
  return cmd == "control check" || cmd == "flight check" || cmd == "preflight check" || cmd == "system check";
}

bool isIncreaseThrottleCommand(const String& cmd) {
  return cmd == "increase throttle" || cmd == "throttle up" || cmd == "increase speed";
}

bool isDecreaseThrottleCommand(const String& cmd) {
  return cmd == "decrease throttle" || cmd == "throttle down" || cmd == "decrease speed";
}

bool isEmergencyStopCommand(const String& cmd) {
  return cmd == "emergency stop" || cmd == "abort" || cmd == "kill switch";
}

void handleControlMessage(const JsonDocument& doc) {
  const char* action = doc["action"] | "";
  const char* command = doc["command"] | doc["text"] | "";
  const int value = doc["value"] | -1;
  const String normalizedCommand = normalizeCommand(command);

  if (strcmp(action, "led_on") == 0 || strcmp(action, "turn_on_lights") == 0 || isTurnOnLightsCommand(normalizedCommand)) {
    ledOn = true;
    digitalWrite(LED_BUILTIN, HIGH);
    Serial.println("[LED] ON (voice command: turn on lights)");
    publishStatus("led_on");
    return;
  }

  if (strcmp(action, "led_off") == 0 || strcmp(action, "turn_off_lights") == 0 || isTurnOffLightsCommand(normalizedCommand)) {
    ledOn = false;
    digitalWrite(LED_BUILTIN, LOW);
    Serial.println("[LED] OFF (voice command: turn off lights)");
    publishStatus("led_off");
    return;
  }

  if (strcmp(action, "engine_on") == 0 || strcmp(action, "turn_on_engine") == 0 || isTurnOnEngineCommand(normalizedCommand)) {
    setEngineState(true, value);
    Serial.println("[ENGINE] ON (voice command: turn on engine)");
    Serial.print("[ENGINE] Pulse(us): ");
    Serial.println(enginePulseUs);
    publishStatus("engine_on");
    return;
  }

  if (strcmp(action, "engine_off") == 0 || strcmp(action, "turn_off_engine") == 0 || isTurnOffEngineCommand(normalizedCommand)) {
    setEngineState(false);
    Serial.println("[ENGINE] OFF (voice command: turn off engine)");
    publishStatus("engine_off");
    return;
  }

  if (strcmp(action, "throttle_up") == 0 || strcmp(action, "increase_throttle") == 0 || isIncreaseThrottleCommand(normalizedCommand)) {
    if (value >= THROTTLE_MIN_LEVEL) {
      increaseThrottle(value);
    } else {
      increaseThrottle();
    }
    Serial.println("[ENGINE] THROTTLE UP");
    publishStatus("throttle_up");
    return;
  }

  if (strcmp(action, "throttle_down") == 0 || strcmp(action, "decrease_throttle") == 0 || isDecreaseThrottleCommand(normalizedCommand)) {
    if (value >= THROTTLE_MIN_LEVEL) {
      decreaseThrottle(value);
    } else {
      decreaseThrottle();
    }
    Serial.println("[ENGINE] THROTTLE DOWN");
    publishStatus("throttle_down");
    return;
  }

  if (strcmp(action, "servo_right") == 0 || strcmp(action, "turn_right") == 0 || isTurnRightCommand(normalizedCommand)) {
    turnRight();
    Serial.println("[SERVO] RUDDER RIGHT");
    publishStatus("servo_right");
    return;
  }

  if (strcmp(action, "servo_left") == 0 || strcmp(action, "turn_left") == 0 || isTurnLeftCommand(normalizedCommand)) {
    turnLeft();
    Serial.println("[SERVO] RUDDER LEFT");
    publishStatus("servo_left");
    return;
  }

  if (strcmp(action, "elevator_up") == 0 || strcmp(action, "upward") == 0 || isUpwardCommand(normalizedCommand)) {
    upward();
    Serial.println("[SERVO] ELEVATOR UP");
    publishStatus("elevator_up");
    return;
  }

  if (strcmp(action, "elevator_down") == 0 || strcmp(action, "downward") == 0 || isDownwardCommand(normalizedCommand)) {
    downward();
    Serial.println("[SERVO] ELEVATOR DOWN");
    publishStatus("elevator_down");
    return;
  }

  if (strcmp(action, "roll_right") == 0 || strcmp(action, "right_roll") == 0 || isRightRollCommand(normalizedCommand)) {
    rightRoll();
    Serial.println("[SERVO] ROLL RIGHT");
    publishStatus("roll_right");
    return;
  }

  if (strcmp(action, "roll_left") == 0 || strcmp(action, "left_roll") == 0 || isLeftRollCommand(normalizedCommand)) {
    leftRoll();
    Serial.println("[SERVO] ROLL LEFT");
    publishStatus("roll_left");
    return;
  }

  if (strcmp(action, "control_check") == 0 || isControlCheckCommand(normalizedCommand)) {
    controlCheck();
    Serial.println("[SERVO] CONTROL CHECK COMPLETE");
    publishStatus("control_check");
    return;
  }

  if (strcmp(action, "emergency_stop") == 0 || isEmergencyStopCommand(normalizedCommand)) {
    setEngineState(false);
    centerControlSurfaces();
    Serial.println("[SAFETY] EMERGENCY STOP");
    publishStatus("emergency_stop");
    return;
  }

  publishStatus("ignored_command");
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
    if (!wifiConnectionLogged) {
      Serial.print("[WiFi] Connected. IP: ");
      Serial.println(WiFi.localIP());
      wifiConnectionLogged = true;
    }
    return;
  }

  if (wifiConnectionLogged) {
    Serial.println("[WiFi] Disconnected.");
    wifiConnectionLogged = false;
  }

  applyEngineFailsafe("WiFi disconnected");

  const unsigned long now = millis();
  if (now - lastWifiAttemptMs < 5000) {
    return;
  }

  lastWifiAttemptMs = now;
  WiFi.mode(WIFI_STA);
  Serial.println("[WiFi] Connecting...");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

void ensureMqttConnected() {
  if (WiFi.status() != WL_CONNECTED) {
    if (mqttConnectionLogged) {
      Serial.println("[MQTT] Disconnected (WiFi unavailable).");
      mqttConnectionLogged = false;
    }
    applyEngineFailsafe("MQTT unavailable (WiFi down)");
    return;
  }

  if (mqttClient.connected()) {
    if (!mqttConnectionLogged) {
      Serial.print("[MQTT] Connected to ");
      Serial.print(MQTT_HOST);
      Serial.print(":");
      Serial.println(MQTT_PORT);
      mqttConnectionLogged = true;
    }
    return;
  }

  if (mqttConnectionLogged) {
    Serial.println("[MQTT] Disconnected.");
    mqttConnectionLogged = false;
  }

  applyEngineFailsafe("MQTT disconnected");

  const unsigned long now = millis();
  if (now - lastMqttAttemptMs < 2000) {
    return;
  }

  lastMqttAttemptMs = now;

  const bool connected = (strlen(MQTT_USER) > 0)
    ? mqttClient.connect(mqttClientId, MQTT_USER, MQTT_PASSWORD)
    : mqttClient.connect(mqttClientId);

  if (!connected) {
    Serial.print("[MQTT] Connect failed, state=");
    Serial.println(mqttClient.state());
    applyEngineFailsafe("MQTT connect failed");
    return;
  }

  mqttClient.subscribe(TOPIC_CONTROL, 1);
  Serial.print("[MQTT] Connected to ");
  Serial.print(MQTT_HOST);
  Serial.print(":");
  Serial.println(MQTT_PORT);
  mqttConnectionLogged = true;
  publishStatus("controller_online");
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("[BOOT] Flight controller starting...");

  const uint64_t chipId = ESP.getEfuseMac();
  snprintf(mqttClientId, sizeof(mqttClientId), "zara-esp32-%04X", static_cast<unsigned int>(chipId & 0xFFFF));
  Serial.print("[MQTT] Client ID: ");
  Serial.println(mqttClientId);

  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, LOW);
  ledOn = false;

  initEnginePwm();
  if (!enginePwmReady) {
    Serial.println("[ENGINE] PWM init failed.");
  }

  initControlSurfaces();

  setEngineState(false);
  Serial.println("[ENGINE] Arming ESC...");
  delay(ESC_ARM_DELAY_MS);
  Serial.println("[ENGINE] ESC ready.");

  WiFi.setSleep(false);

  if (MQTT_USE_TLS) {
    if (strlen(MQTT_ROOT_CA) > 0) {
      secureClient.setCACert(MQTT_ROOT_CA);
      Serial.println("[MQTT] TLS enabled with CA certificate.");
    } else {
      secureClient.setInsecure();
      Serial.println("[MQTT] TLS enabled in insecure mode (no CA cert configured).");
    }
    mqttClient.setClient(secureClient);
  } else {
    mqttClient.setClient(wifiClient);
    Serial.println("[MQTT] TLS disabled (plain TCP).");
  }

  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setBufferSize(512);

  ensureWifiConnected();
}

void loop() {
  ensureWifiConnected();
  ensureMqttConnected();

  if (mqttClient.connected()) {
    if (!mqttClient.loop()) {
      Serial.print("[MQTT] Loop lost connection, state=");
      Serial.println(mqttClient.state());
      mqttClient.disconnect();
      mqttConnectionLogged = false;
      applyEngineFailsafe("MQTT loop disconnected");
    }
  }
}
