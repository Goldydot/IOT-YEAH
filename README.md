# IoT Weather Station

ESP32 reads temperature, humidity, rain, light and distance, then POSTs JSON to `data.php` on your
Hostinger site. The website (`index.html` + `app.js`) polls `data.php` every 2 seconds
and shows live values and charts. The buzzer can be set to **Auto / On / Off** from the website.

```
Sensors -> ESP32 --WiFi, JSON POST--> example.com/data.php --JSON--> app.js -> dashboard
                 <---- buzzer mode ----        ^
                                               | buzzer.php (Auto/On/Off buttons)
Local repo --git push--> GitHub --Hostinger Git deploy--> public_html
```

## 1. Wiring (ESP32)

| Part | Module pin | ESP32 pin |
|---|---|---|
| DHT11 | DATA | **GPIO 4** |
| Rain / water module | DO (LOW = water) | **GPIO 22** |
| Light module | DO (HIGH = dark) | **GPIO 21** |
| Buzzer (sounds on LOW) | I/O | **GPIO 23** |
| HC-SR04 ultrasonic | TRIG / ECHO | **GPIO 5** / **GPIO 18** (ECHO through a divider) |

The rain and light sensors are wired to their **digital** outputs, so the dashboard shows
Raining/Dry and Dark/Bright. Turn each module's blue potentiometer to set when it switches.

Buzzer in **Auto** mode, in priority order:
1. Water detected: continuous.
2. Temperature above 45 °C: 1.5 s on, 1.5 s off.
3. Dark: two beeps, then a 3 s pause.
4. Object within 10 cm: beeps, faster the closer it gets.

**On** and **Off** on the website override all of these.

**HC-SR04 ECHO outputs 5V.** Connect ECHO → 1 kΩ → GPIO 18, and GPIO 18 → 2 kΩ → GND.
Connecting ECHO directly to the ESP32 can damage it over time.

## 2. Arduino IDE

1. Boards Manager: install **esp32 by Espressif**. Select *ESP32 Dev Module*.
2. Library Manager: install **DHT sensor library** (Adafruit), **Adafruit Unified Sensor**, **ArduinoJson**.
3. Open `arduino/weather_station/weather_station.ino` and edit the WiFi name, password,
   `SERVER_URL` (your domain + `/data.php`) and `API_KEY`.
4. Upload, then open Serial Monitor at **115200** baud. It shows the IP address and each JSON it sends.

If the buzzer is on when it should be off and off when it should be on, set `BUZZER_ACTIVE_LOW` to `false`.

## 3. Website on Hostinger with Git

1. Set the same `API_KEY` in `website/config.php` as in the sketch.
2. Make a **private** GitHub repo, because `config.php` contains your API key. Push only the `website` folder:
   ```
   cd website
   git init
   git add .
   git commit -m "Weather station website"
   git branch -M main
   git remote add origin https://github.com/YOUR-USER/weather-site.git
   git push -u origin main
   ```
3. Hostinger hPanel → **Websites → Advanced → Git**: paste the repo URL (*copy URL* from GitHub),
   branch `main`, leave the install path empty (deploys to `public_html`). For a private repo,
   copy the SSH key Hostinger shows into GitHub → repo → Settings → Deploy keys, and use the SSH repo URL.
4. Turn on **Auto Deployment** and add the webhook URL Hostinger gives you to GitHub → Settings → Webhooks.
   After that, each `git push` updates the live site.

Open `https://your-domain/index.html?demo` to check the dashboard with fake data before the ESP32 is connected.

## Files

| File | Purpose |
|---|---|
| `website/data.php` | POST from ESP32 saves a reading; GET returns latest (+ `?history=1`) |
| `website/buzzer.php` | Website sets buzzer mode; ESP32 gets it in the reply to its next POST |
| `website/config.php` | API key, history size, helpers |
| `website/data/` | Readings stored as JSON files (blocked from direct access by `.htaccess`) |
| `website/index.html`, `style.css`, `app.js` | Real-time dashboard |

## Troubleshooting

- **HTTP error 401**: the API keys in the sketch and `config.php` are different.
- **HTTP error -1 or 403**: check `SERVER_URL` and open it in a browser; it should show JSON.
  If you get 403 only from the ESP32, try `http://` instead of `https://`.
- **Temperature shows `--`**: DHT wiring problem, or `DHT_TYPE` doesn't match your sensor.
- **"Device offline"**: no reading in the last 15 s. Check Serial Monitor.
- **Anyone can press the buzzer buttons**: `buzzer.php` has no login. That's fine for a demo, but add a password before you leave the site public.
