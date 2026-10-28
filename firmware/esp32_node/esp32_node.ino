/*
  Disaster management system field node — reference sketch (ESP32, Arduino core).
  STATUS: written to match the gateway's /api/telemetry format; NOT yet tested on hardware.
  Calibrate every constant below against your actual sensors before trusting any number.

  Sensors (first-build choices, see hardware/kicad_notes/README.md):
    - Water level : downward-looking ultrasonic (JSN-SR04T). Level = MOUNT_HEIGHT_CM - distance.
                    ECHO outputs 5 V on most modules -> use a divider/level shifter to 3.3 V.
    - Rain        : tipping-bucket reed switch on RAIN_PIN (pulls to GND on each tip).
    - Wind        : reed/pulse anemometer on WIND_PIN.
    - Microphone  : optional I2S MEMS mic (set USE_I2S_MIC 1). Classification here is a crude
                    energy-ratio heuristic that needs tuning with recordings from the real site.
*/
#define USE_I2S_MIC 0          // 1 = enable I2S microphone classifier (needs tuning)
#include <WiFi.h>
#include <HTTPClient.h>
#if USE_I2S_MIC
#include <driver/i2s.h>
#endif

// ---------- configure ----------
const char* WIFI_SSID   = "YOUR_WIFI";
const char* WIFI_PASS   = "YOUR_PASSWORD";
const char* GATEWAY_URL = "http://192.168.1.20:8000/api/telemetry";   // PC running run.py
const char* STATION_ID  = "FG-CHM-01";                                // must exist in backend/engine.py
const char* ZONE        = "Central Himalaya";
const float MOUNT_HEIGHT_CM = 300.0;     // sensor face to riverbed
const float MM_PER_TIP      = 0.2794;    // check your gauge
const float WIND_MS_PER_HZ  = 0.667;     // check your anemometer
const uint32_t POST_EVERY_MS = 10000;    // one packet every 10 s
const int TRIG_PIN = 5, ECHO_PIN = 18, RAIN_PIN = 27, WIND_PIN = 26;
// --------------------------------

const int BUCKETS = 60;                  // 60 x 10 s = 10 min
volatile uint32_t rainTips = 0, windPulses = 0;
uint16_t rainBucket[BUCKETS] = {0};
float levelRing[BUCKETS];
int idx = 0; bool filled = false;
uint32_t lastPost = 0, lastRainIsr = 0, lastWindIsr = 0;

void IRAM_ATTR onRain() { uint32_t t = millis(); if (t - lastRainIsr > 50) { rainTips++; lastRainIsr = t; } }
void IRAM_ATTR onWind() { uint32_t t = millis(); if (t - lastWindIsr > 3)  { windPulses++; lastWindIsr = t; } }

float readLevelCm() {
  float sum = 0; int ok = 0;
  for (int i = 0; i < 5; i++) {
    digitalWrite(TRIG_PIN, LOW); delayMicroseconds(3);
    digitalWrite(TRIG_PIN, HIGH); delayMicroseconds(12); digitalWrite(TRIG_PIN, LOW);
    long us = pulseIn(ECHO_PIN, HIGH, 30000);
    if (us > 0) { sum += us * 0.0343f / 2.0f; ok++; }
    delay(60);
  }
  if (!ok) return NAN;
  return constrain(MOUNT_HEIGHT_CM - sum / ok, 0, 2000);
}

const char* classifyAudio() {
#if USE_I2S_MIC
  // Crude heuristic: compare low-band vs high-band energy of ~0.25 s of audio. TUNE ON SITE.
  static bool init = false;
  if (!init) {
    i2s_config_t c = {}; c.mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX); c.sample_rate = 16000;
    c.bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT; c.channel_format = I2S_CHANNEL_FMT_ONLY_LEFT;
    c.communication_format = I2S_COMM_FORMAT_STAND_I2S; c.dma_buf_count = 4; c.dma_buf_len = 256;
    i2s_pin_config_t p = { .bck_io_num = 14, .ws_io_num = 15, .data_out_num = -1, .data_in_num = 32 };
    i2s_driver_install(I2S_NUM_0, &c, 0, NULL); i2s_set_pin(I2S_NUM_0, &p); init = true;
  }
  static int32_t buf[256]; size_t got; double eAll = 0, eHigh = 0; float lp = 0; int n = 0;
  for (int k = 0; k < 16; k++) {
    i2s_read(I2S_NUM_0, buf, sizeof(buf), &got, 100);
    for (size_t i = 0; i < got / 4; i++) {
      float s = (buf[i] >> 14) / 262144.0f; lp += 0.08f * (s - lp); float hp = s - lp;
      eAll += s * s; eHigh += hp * hp; n++;
    }
  }
  if (!n) return "unknown";
  float rms = sqrt(eAll / n), hiRatio = eHigh / (eAll + 1e-9);
  if (rms < 0.01) return "background";
  if (hiRatio > 0.55) return "rain_like";
  if (rms > 0.05) return "flowing_water";
  return "wind_noise";
#else
  return "unknown";
#endif
}

void setup() {
  Serial.begin(115200);
  pinMode(TRIG_PIN, OUTPUT); pinMode(ECHO_PIN, INPUT);
  pinMode(RAIN_PIN, INPUT_PULLUP); pinMode(WIND_PIN, INPUT_PULLUP);
  attachInterrupt(RAIN_PIN, onRain, FALLING); attachInterrupt(WIND_PIN, onWind, FALLING);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) { delay(400); Serial.print('.'); }
  Serial.printf("\nWiFi OK, IP %s\n", WiFi.localIP().toString().c_str());
}

void loop() {
  if (millis() - lastPost < POST_EVERY_MS) return;
  lastPost = millis();
  if (WiFi.status() != WL_CONNECTED) { WiFi.reconnect(); return; }

  noInterrupts(); uint32_t tips = rainTips, pulses = windPulses; rainTips = 0; windPulses = 0; interrupts();
  rainBucket[idx] = tips;
  uint32_t tips10 = 0; for (int i = 0; i < BUCKETS; i++) tips10 += rainBucket[i];
  float rain_mm_h = tips10 * MM_PER_TIP * 6.0f;               // last 10 min scaled to an hour
  float wind = (pulses / (POST_EVERY_MS / 1000.0f)) * WIND_MS_PER_HZ;

  float level = readLevelCm();
  if (isnan(level)) { Serial.println("Level sensor: no echo, skipping packet"); return; }
  float oldest = filled ? levelRing[idx] : levelRing[0];
  if (!filled && idx == 0) oldest = level;
  float change10 = level - oldest;
  levelRing[idx] = level;
  if (++idx >= BUCKETS) { idx = 0; filled = true; }

  char body[320];
  snprintf(body, sizeof(body),
    "{\"station_id\":\"%s\",\"zone\":\"%s\",\"audio_class\":\"%s\",\"rainfall_mm_h\":%.1f,\"wind_speed_m_s\":%.1f,"
    "\"water_level_cm\":%.1f,\"water_level_change_cm_10m\":%.1f,\"source\":\"prototype_sensor\"}",
    STATION_ID, ZONE, classifyAudio(), rain_mm_h, wind, level, change10);

  HTTPClient http; http.begin(GATEWAY_URL); http.addHeader("Content-Type", "application/json");
  int code = http.POST((uint8_t*)body, strlen(body));
  Serial.printf("POST %d  %s\n", code, body);
  http.end();
}
