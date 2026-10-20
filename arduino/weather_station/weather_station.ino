/*
  IoT Weather Station - ESP32 (replaces the old Blynk version, same wiring)
  Sensors : DHT11 (temperature + humidity), rain/water module (digital),
            light module (digital), HC-SR04 ultrasonic (distance)
  Output  : buzzer
  Sends a JSON reading to SERVER_URL every second (instantly on alarm changes) over a
  kept-open connection, and reads back the buzzer
  mode chosen on the website: "auto" (alarms below), "on" or "off".

  Libraries (Arduino IDE > Library Manager):
    - "DHT sensor library" by Adafruit (+ "Adafruit Unified Sensor")
    - "ArduinoJson" by Benoit Blanchon (v7)
  Board: ESP32 Dev Module
*/

#include <WiFi.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <DHT.h>

// ---------- EDIT THESE ----------
const char* WIFI_SSID     = "ARC";
const char* WIFI_PASSWORD = "Edan07251946";
// Testing on your PC: the address shown in the start-server window (PC and ESP32 on the same WiFi)
// On Hostinger later: "https://your-domain.com/data.php"
const char* SERVER_URL    = "https://wheat-pig-539291.hostingersite.com/data.php";
const char* API_KEY       = "8xB9P6SqQAZTpwHnt4uYFXOze5dDMCov"; // must match website/config.php
// --------------------------------

// ========================================
// PIN CONFIGURATION (matched to current wiring)
// ========================================
#define TRIG_PIN   5     // ultrasonic
#define ECHO_PIN   18
#define WATER_PIN  22    // rain/water module DO: LOW = water
#define LIGHT_PIN  21    // light module DO: HIGH = dark
#define DHT_PIN    4
#define DHT_TYPE   DHT11
#define BUZZER_PIN 23
#define SOUND_PIN  19    // sound sensor (KY-038 / KY-037) DO

// Clap to buzz with a sound sensor module: set to true once it's wired to SOUND_PIN.
// (Leave false without a sensor, or the loose pin will trigger random buzzes.)
const bool CLAP_SENSOR_ENABLED = false;
const bool SOUND_ACTIVE_HIGH   = true;   // most modules: DO goes HIGH on a loud sound
const unsigned long CLAP_BUZZ_MS = 1000; // how long one clap buzzes (sensor or website)

// true  = buzzer sounds when pin is LOW  (your module)
// false = buzzer sounds when pin is HIGH
const bool BUZZER_ACTIVE_LOW = true;
#define BUZZER_ON  (BUZZER_ACTIVE_LOW ? LOW : HIGH)
#define BUZZER_OFF (BUZZER_ACTIVE_LOW ? HIGH : LOW)

// Alarm rules (auto mode)
const float TEMP_ALARM_C      = 45.0;
const float DISTANCE_ALARM_CM = 10.0;

const unsigned long FAST_READ_MS = 250;   // water, light, distance
const unsigned long DHT_READ_MS  = 2000;  // DHT11 is slow, don't go below 2 s
const unsigned long SEND_MS      = 1000;  // regular send; changes are sent immediately

// ========================================
// STATE
// ========================================
DHT dht(DHT_PIN, DHT_TYPE);

float distance    = -1;
float temperature = NAN;
float humidity    = NAN;
int waterState    = HIGH;
int lightState    = LOW;

String buzzerMode = "auto";   // set from the website
bool buzzerSounding = false;  // true while an alarm/manual buzz is active

unsigned long lastFastRead = 0;
unsigned long lastDhtRead  = 0;
unsigned long lastSend     = 0;
String lastSentState = "";
unsigned long lastBuzzerChange = 0;
bool buzzerState = false;

bool tempBuzzing = false;
unsigned long tempTimer = 0;

volatile bool soundHeard = false;   // set by the sound sensor interrupt
unsigned long lastClap = 0;
unsigned long clapBuzzUntil = 0;
long lastBeep = -1;                 // website clap counter seen last time

void IRAM_ATTR onSound() { soundHeard = true; }
bool clapActive() { return millis() < clapBuzzUntil; }

int darkBeepCount = 0;
bool darkPause = false;
unsigned long darkPauseStart = 0;

void buzzerOn()  { digitalWrite(BUZZER_PIN, BUZZER_ON); }
void buzzerOff() { digitalWrite(BUZZER_PIN, BUZZER_OFF); }

// ========================================
// WIFI
// ========================================
void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  buzzerOff();
  Serial.printf("Connecting to WiFi \"%s\"", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(500);
    Serial.print(".");
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("\nWiFi connected, ESP32 IP address: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\nWiFi FAILED (check name/password, must be 2.4 GHz). Retrying soon.");
  }
}

// ========================================
// SENSORS
// ========================================
// Keeps the last good value if one read fails, so the dashboard doesn't flicker
void readDHT() {
  static int failures = 0;
  float t = dht.readTemperature();
  float h = dht.readHumidity();
  if (!isnan(t) && !isnan(h)) {
    temperature = t;
    humidity = h;
    failures = 0;
  } else if (++failures >= 3) {
    temperature = NAN;
    humidity = NAN;
  }
}

float getDistance() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  long duration = pulseIn(ECHO_PIN, HIGH, 30000);
  if (duration == 0) return -1;
  return duration * 0.0343 / 2.0;
}

// Why the buzzer is (or would be) sounding in auto mode
const char* alarmReason() {
  if (clapActive()) return "Clap detected";
  if (waterState == LOW) return "Water detected";
  if (!isnan(temperature) && temperature > TEMP_ALARM_C) return "High temperature";
  if (lightState == HIGH) return "Dark";
  if (distance > 0 && distance <= DISTANCE_ALARM_CM) return "Object too close";
  return "";
}

void readFastSensors() {
  distance   = getDistance();
  waterState = digitalRead(WATER_PIN);
  lightState = digitalRead(LIGHT_PIN);
}

// The things that should reach the dashboard instantly when they change
String alarmState() {
  bool tooClose = distance > 0 && distance <= DISTANCE_ALARM_CM;
  return String(waterState) + String(lightState) + String(tooClose) + String(clapActive());
}

void printReading() {
  Serial.printf("T %s C | H %s %% | dist %s | %s | %s | buzzer %s (%s)\n",
    isnan(temperature) ? "ERR" : String(temperature, 1).c_str(),
    isnan(humidity) ? "ERR" : String(humidity, 0).c_str(),
    distance < 0 ? "none" : (String(distance, 1) + " cm").c_str(),
    waterState == LOW ? "WATER" : "dry",
    lightState == HIGH ? "DARK" : "bright",
    buzzerMode.c_str(), *alarmReason() ? alarmReason() : "no alarm");
}

// ========================================
// SEND TO WEBSITE
// ========================================
WiFiClientSecure secureClient;
WiFiClient plainClient;
HTTPClient http;
const bool USE_HTTPS = String(SERVER_URL).startsWith("https");

WiFiClient& netClient() {
  if (USE_HTTPS) return secureClient;
  return plainClient;
}

bool postBody(const String& body);

void sendReading() {
  const char* reason = buzzerMode == "on" ? "Manual (website)" : buzzerMode == "off" ? "" : alarmReason();

  JsonDocument doc;
  if (isnan(temperature)) doc["temperature"] = nullptr; else doc["temperature"] = round(temperature * 10) / 10.0;
  if (isnan(humidity))    doc["humidity"]    = nullptr; else doc["humidity"]    = round(humidity);
  if (distance < 0)       doc["distance"]    = nullptr; else doc["distance"]    = round(distance * 10) / 10.0;
  doc["raining"] = waterState == LOW;
  doc["dark"]    = lightState == HIGH;
  doc["buzzer"]  = *reason != 0;
  doc["reason"]  = reason;
  String body;
  serializeJson(doc, body);

  // A reused connection may have been dropped silently by the host: retry once on a fresh one
  if (!postBody(body)) postBody(body);
}

// The clients are global so the connection stays open between sends (keep-alive).
// Only a new connection pays for the slow HTTPS handshake.
bool postBody(const String& body) {
  bool reused = netClient().connected();
  http.setReuse(true);
  http.begin(netClient(), SERVER_URL);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-API-Key", API_KEY);
  http.setUserAgent("ESP32-WeatherStation");
  http.setConnectTimeout(3000);
  http.setTimeout(reused ? 1500 : 3000);  // a normal send takes ~0.2 s

  unsigned long t0 = millis();
  int code = http.POST(body);
  if (code == 200) {
    JsonDocument reply;
    if (!deserializeJson(reply, http.getString())) {
      buzzerMode = reply["buzzer"] | "auto";
      long beep = reply["beep"] | -1L;  // goes up each time someone claps on the website
      if (beep >= 0) {
        if (lastBeep >= 0 && beep != lastBeep) {
          clapBuzzUntil = millis() + CLAP_BUZZ_MS;
          Serial.println("  -> clap from website!");
        }
        lastBeep = beep;
      }
    }
    Serial.printf("  -> sent OK in %lu ms%s\n", millis() - t0, reused ? "" : " (new connection)");
    http.end();  // keeps the connection open for the next send
    return true;
  }
  Serial.printf("  -> HTTP error %d %s after %lu ms\n", code,
                code < 0 ? http.errorToString(code).c_str() : http.getString().c_str(), millis() - t0);
  http.end();
  netClient().stop();  // drop the broken connection
  return code > 0;     // server answered (e.g. wrong key): don't retry
}

// ========================================
// BUZZER (non-blocking patterns)
// ========================================
void resetDarkPattern() {
  darkBeepCount = 0;
  darkPause = false;
}

void handleBuzzer() {
  unsigned long now = millis();

  if (buzzerMode == "off") { buzzerOff(); resetDarkPattern(); return; }
  if (buzzerMode == "on" || clapActive()) { buzzerOn(); resetDarkPattern(); return; }

  // 1: WATER DETECTED - continuous
  if (waterState == LOW) {
    buzzerOn();
    resetDarkPattern();
    tempBuzzing = false;
    return;
  }

  // 2: HIGH TEMPERATURE - 1.5 s on / 1.5 s off
  if (!isnan(temperature) && temperature > TEMP_ALARM_C) {
    if (now - tempTimer >= 1500) {
      tempBuzzing = !tempBuzzing;
      tempTimer = now;
      if (tempBuzzing) buzzerOn(); else buzzerOff();
    }
    resetDarkPattern();
    return;
  }
  tempBuzzing = false;
  tempTimer = now;

  // 3: DARK - 2 beeps, 3 s pause, repeat
  if (lightState == HIGH) {
    if (darkPause) {
      buzzerOff();
      if (now - darkPauseStart >= 3000) {
        darkPause = false;
        darkBeepCount = 0;
        buzzerState = false;
        lastBuzzerChange = now;
      }
      return;
    }
    if (now - lastBuzzerChange >= 250) {
      lastBuzzerChange = now;
      buzzerState = !buzzerState;
      if (buzzerState) { buzzerOn(); darkBeepCount++; }
      else buzzerOff();
      if (darkBeepCount >= 2 && !buzzerState) {
        darkPause = true;
        darkPauseStart = now;
      }
    }
    return;
  }
  resetDarkPattern();

  // 4: OBJECT CLOSE - closer = faster beeps
  if (distance > 0 && distance <= DISTANCE_ALARM_CM) {
    unsigned long interval = distance <= 3 ? 100 : distance <= 5 ? 200 : distance <= 7 ? 350 : 500;
    if (now - lastBuzzerChange >= interval) {
      lastBuzzerChange = now;
      buzzerState = !buzzerState;
      if (buzzerState) buzzerOn(); else buzzerOff();
    }
    return;
  }

  buzzerOff();
  buzzerState = false;
}

// ========================================
// SETUP / LOOP
// ========================================
void setup() {
  Serial.begin(115200);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  pinMode(WATER_PIN, INPUT);
  pinMode(LIGHT_PIN, INPUT);
  pinMode(DHT_PIN, INPUT_PULLUP);
  pinMode(BUZZER_PIN, OUTPUT);
  buzzerOff();
  if (CLAP_SENSOR_ENABLED) {
    pinMode(SOUND_PIN, INPUT);
    attachInterrupt(digitalPinToInterrupt(SOUND_PIN), onSound, SOUND_ACTIVE_HIGH ? RISING : FALLING);
  }
  dht.begin();

  Serial.println();
  Serial.println("==============================");
  Serial.println(" ESP32 WEATHER STATION (WEB)");
  Serial.println("==============================");
  Serial.printf("Sending to: %s\n", SERVER_URL);
  secureClient.setInsecure();  // skip certificate check (fine for a school project)
  delay(1000);  // let the DHT11 settle
  connectWiFi();
}

void loop() {
  unsigned long now = millis();

  // Double clap on the sound sensor: buzz right away (no internet needed)
  if (soundHeard) {
    soundHeard = false;
    if (now - lastClap > 120 && !clapActive()) {   // ignore the echo of the same clap
      unsigned long gap = now - lastClap;
      if (lastClap && gap >= 150 && gap <= 1000) {  // second clap in time
        clapBuzzUntil = now + CLAP_BUZZ_MS;
        lastClap = 0;
        Serial.println("Double clap detected!");
      } else {
        lastClap = now;                            // first clap: wait for the second
      }
    }
  }

  if (now - lastDhtRead >= DHT_READ_MS || lastDhtRead == 0) {
    lastDhtRead = now;
    readDHT();
  }

  if (now - lastFastRead >= FAST_READ_MS) {
    lastFastRead = now;
    readFastSensors();

    // send on schedule, or immediately when water / light / distance alarm changes
    String state = alarmState();
    if (now - lastSend >= SEND_MS || state != lastSentState) {
      lastSend = now;
      lastSentState = state;
      printReading();
      connectWiFi();
      if (WiFi.status() == WL_CONNECTED) sendReading();
    }
  }

  handleBuzzer();
}
