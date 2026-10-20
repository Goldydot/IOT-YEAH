// Polls data.php and animates the dashboard in real time.
// Open index.html?demo to see it working with fake data (no ESP32 needed).

const POLL_MS = 500;           // polling when live push isn't available (e.g. PHP hosting)
const OFFLINE_AFTER_S = 15;    // device counts as offline if no reading for this long
const TEMP_MAX = 50;           // gauge range 0..50 °C
const RADAR_MAX_CM = 200;      // radar edge
const GAUGE_LEN = 377;         // 270° of a r=80 circle
const DEMO = new URLSearchParams(location.search).has('demo');

const $ = (id) => document.getElementById(id);
let history = [];
let buzzerMode = 'auto';

// ---------- data loading ----------
async function fetchData(withHistory) {
  if (DEMO) return demoData(withHistory);
  const res = await fetch('data.php' + (withHistory ? '?history=1' : ''), { cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

function handleData(data) {
  if (data.history) history = data.history.slice();
  else if (data.latest && (!history.length || history.at(-1).time !== data.latest.time
           || JSON.stringify(history.at(-1)) !== JSON.stringify(data.latest))) {
    history.push(data.latest);
    if (history.length > 400) history.shift();
  }
  render(data);
}

async function poll(withHistory = false) {
  try {
    handleData(await fetchData(withHistory));
  } catch (err) {
    if (location.protocol === 'file:') setStatus('offline', 'Opened as a file: run start-server.bat and open http://localhost:8000');
    else setStatus('offline', 'Server unreachable');
    drawCharts();
    console.error(err);
  }
}

// ---------- helpers ----------
const has = (v) => v !== null && v !== undefined && !Number.isNaN(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function setStatus(cls, text) {
  $('status').className = 'status ' + cls;
  $('statusText').textContent = text;
}

function setChip(id, text, cls = '') {
  const el = $(id);
  el.textContent = text;
  el.className = 'chip ' + cls;
}

function bump(el) {
  el.classList.remove('bump');
  void el.offsetWidth;  // restart the animation
  el.classList.add('bump');
}

// Smoothly counts a number from its previous value to the new one
function tween(el, to, digits) {
  if (!has(to)) { el.textContent = '--'; el._v = undefined; return; }
  const from = el._v ?? 0;
  el._v = to;
  if (from === to) { el.textContent = to.toFixed(digits); return; }
  bump(el);
  const start = performance.now(), dur = 450;
  cancelAnimationFrame(el._raf);
  const step = (now) => {
    const t = clamp((now - start) / dur, 0, 1);
    const e = 1 - Math.pow(1 - t, 3);
    el.textContent = (from + (to - from) * e).toFixed(digits);
    if (t < 1) el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
}

function setText(el, text) {
  if (el.textContent !== text) { el.textContent = text; bump(el); }
}

// ---------- rendering ----------
function render(data) {
  const r = data.latest;
  setMode(data.control?.buzzer || 'auto');

  if (!r) {
    setStatus('offline', 'Waiting for device…');
    drawCharts();
    return;
  }

  const age = data.serverTime - r.time;
  if (age > OFFLINE_AFTER_S) setStatus('offline', `Device offline · ${Math.round(age)} s ago`);
  else setStatus('online', 'Live');

  // Temperature gauge
  tween($('temperature'), r.temperature, 1);
  if (has(r.temperature)) {
    $('tempArc').style.strokeDashoffset = GAUGE_LEN * (1 - clamp(r.temperature / TEMP_MAX, 0, 1));
    const t = r.temperature;
    if (t > 45) setChip('tempChip', 'Extreme', 'hot');
    else if (t >= 35) setChip('tempChip', 'Hot', 'hot');
    else if (t >= 28) setChip('tempChip', 'Warm', 'warn');
    else if (t >= 20) setChip('tempChip', 'Comfortable', 'ok');
    else setChip('tempChip', 'Cool', 'ok');
  } else setChip('tempChip', 'Sensor error', 'warn');
  $('tempCard').classList.toggle('alert', has(r.temperature) && r.temperature > 45);
  renderTempCompare(r.temperature);

  // Humidity liquid level (circle spans y = 16..184, wave crest sits 10px above level)
  tween($('humidity'), r.humidity, 0);
  if (has(r.humidity)) {
    const y = 184 - clamp(r.humidity, 0, 100) / 100 * 168 - 10;
    $('waterLevel').style.transform = `translateY(${y}px)`;
  }
  renderHumidityType(r.temperature, r.humidity);

  // Distance radar
  tween($('distance'), r.distance, 1);
  const blip = $('blip');
  if (has(r.distance)) {
    const f = clamp(r.distance / RADAR_MAX_CM, 0.04, 1) * 46;  // % from centre
    const a = -40 * Math.PI / 180;
    blip.style.left = 50 + f * Math.sin(-a) + '%';
    blip.style.top = 50 - f * Math.cos(a) + '%';
    blip.hidden = false;
    if (r.distance <= 10) setChip('distanceBadge', 'Too close', 'hot');
    else if (r.distance < 50) setChip('distanceBadge', 'Near', 'warn');
    else setChip('distanceBadge', 'Clear', 'ok');
  } else {
    blip.hidden = true;
    setChip('distanceBadge', 'Out of range');
  }
  $('distCard').classList.toggle('alert', has(r.distance) && r.distance <= 10);

  // Rain
  renderRain(!!r.raining);

  // Light
  renderLight(!!r.dark);

  // Buzzer
  $('buzzerCard').classList.toggle('is-on', !!r.buzzer);
  setText($('buzzer'), r.buzzer ? 'Sounding' : 'Silent');
  $('buzzerReason').textContent = r.buzzer && r.reason ? '· ' + r.reason : '';
  setChip('buzzerChip', r.buzzer ? 'ON' : 'OFF', r.buzzer ? 'hot' : '');

  // Alarm toast
  if (r.buzzer && r.reason && age <= OFFLINE_AFTER_S) {
    $('toastText').textContent = 'Alarm · ' + r.reason;
    $('toast').classList.add('show');
  } else $('toast').classList.remove('show');

  $('updated').textContent = new Date(r.time * 1000).toLocaleTimeString();
  drawCharts();
}

// ---------- what kind of humidity is it? ----------
// Dew point (Magnus formula): the temperature where the air would turn to fog/dew.
// It's the best measure of how sticky the air feels.
function dewPoint(t, rh) {
  const g = Math.log(rh / 100) + (17.62 * t) / (243.12 + t);
  return (243.12 * g) / (17.62 - g);
}

// Heat index ("feels like"), NOAA formula; only meaningful above ~27 °C
function heatIndex(t, rh) {
  if (t < 27) return t;
  const f = t * 9 / 5 + 32;
  const hi = -42.379 + 2.04901523 * f + 10.14333127 * rh - 0.22475541 * f * rh - 0.00683783 * f * f
    - 0.05481717 * rh * rh + 0.00122874 * f * f * rh + 0.00085282 * f * rh * rh - 0.00000199 * f * f * rh * rh;
  return (hi - 32) * 5 / 9;
}

function setStat(id, text, cls = '') {
  $(id).textContent = text;
  $(id).className = cls;
}

function renderHumidityType(t, rh) {
  if (!has(rh)) {
    setChip('humChip', 'Sensor error', 'warn');
    $('humType').textContent = '--';
    $('humDesc').textContent = 'No reading from the humidity sensor';
    return;
  }
  const dp = has(t) ? dewPoint(t, rh) : null;
  let icon, type, desc, cls;
  if (rh >= 95) { icon = '🌫️'; type = 'Foggy / misty'; desc = 'Air is saturated: mist or condensation likely'; cls = 'warn'; }
  else if (rh < 30) { icon = '🏜️'; type = 'Very dry'; desc = 'Dry air: skin and throat may feel dry'; cls = 'warn'; }
  else if (dp === null) { icon = '💧'; type = rh >= 70 ? 'Humid' : 'Normal'; desc = ''; cls = rh >= 70 ? 'warn' : 'ok'; }
  else if (dp < 10) { icon = '🍃'; type = 'Dry'; desc = 'Crisp, dry air'; cls = 'ok'; }
  else if (dp < 16) { icon = '😊'; type = 'Comfortable'; desc = 'Pleasant, not sticky'; cls = 'ok'; }
  else if (dp < 18) { icon = '🙂'; type = 'Slightly humid'; desc = 'Starting to feel a little sticky'; cls = 'ok'; }
  else if (dp < 21) { icon = '💦'; type = 'Humid'; desc = 'Feels sticky'; cls = 'warn'; }
  else if (dp < 24) { icon = '🥵'; type = 'Muggy'; desc = "Uncomfortable: sweat doesn't dry easily"; cls = 'hot'; }
  else { icon = '🥵'; type = 'Oppressive'; desc = 'Very muggy, tropical air: stay hydrated'; cls = 'hot'; }

  setChip('humChip', type, cls);
  $('humIcon').textContent = icon;
  setText($('humType'), type);
  $('humDesc').textContent = desc;

  if (dp !== null) {
    setStat('dewPoint', `${dp.toFixed(1)} °C`);
    const hi = heatIndex(t, rh);
    setStat('heatIndex', `${hi.toFixed(1)} °C`, hi >= 41 ? 'hot' : hi >= 32 ? 'warn' : 'ok');
  } else { setStat('dewPoint', '--'); setStat('heatIndex', '--'); }

  // Fog: outdoor weather says fog, or the room air is (nearly) saturated
  const spread = has(t) && dp !== null ? t - dp : 99;
  if (outside && (outside.code === 45 || outside.code === 48)) setStat('fogState', 'Foggy outside', 'warn');
  else if (rh >= 95) setStat('fogState', 'Misty indoors', 'warn');
  else if (rh >= 90 && spread < 2.5) setStat('fogState', 'Possible mist', 'warn');
  else setStat('fogState', 'None', 'ok');

  renderSmoke();
  renderHumCompare(rh);
}

// Smoke / haze from outdoor PM2.5 (fine particles from smoke, fires, traffic)
function renderSmoke() {
  if (!outside || !has(outside.pm25)) { setStat('smokeState', outside ? 'No data' : 'Checking…'); return; }
  const pm = outside.pm25;
  const label = pm <= 12 ? ['Clean air', 'ok'] : pm <= 35.4 ? ['Slight haze', 'ok'] : pm <= 55.4 ? ['Hazy', 'warn']
    : pm <= 150.4 ? ['Smoky', 'hot'] : ['Very smoky', 'hot'];
  setStat('smokeState', `${label[0]} · PM2.5 ${Math.round(pm)}`, label[1]);
}

// ---------- what kind of rain is it? ----------
// The sensor only knows wet/dry, so the type comes from the weather at your location.
const RAIN_TYPES = {
  none:        ['🌤️', 'No rain', 'No rain right now', 0],
  mist:        ['🌫️', 'Mist', 'Tiny water drops floating in the air', 1],
  drizzle:     ['🌦️', 'Drizzle', 'Very light rain with tiny drops', 1],
  sprinkle:    ['🌦️', 'Sprinkle', 'A few light drops of rain', 1],
  light:       ['🌧️', 'Light rain', 'Gentle and steady rainfall', 2],
  shower:      ['🌦️', 'Shower', 'Sudden rain that starts and stops quickly', 3],
  heavy:       ['🌧️', 'Heavy rain', 'Strong, continuous rain', 3],
  torrential:  ['🌊', 'Torrential rain', 'Extremely heavy and intense rain', 4],
  hail:        ['🧊', 'Hail', 'Frozen rain falling as ice balls', 3],
  thunder:     ['⛈️', 'Thunderstorm', 'Rain with thunder and lightning', 3],
};

function rainTypeOutside() {
  if (!outside) return null;
  const c = outside.code, mm = outside.precip ?? 0;
  if (c === 96 || c === 99) return 'hail';
  if (c === 95) return 'thunder';
  if (c === 82 || mm >= 30) return 'torrential';
  if (c === 80 || c === 81) return 'shower';
  if (c >= 51 && c <= 57) return 'drizzle';
  if (c === 65 || mm >= 7.6) return 'heavy';
  if ((c >= 61 && c <= 67) || mm > 0) return mm > 0 && mm < 0.3 ? 'sprinkle' : 'light';
  if (c === 45 || c === 48) return 'mist';
  return 'none';
}

// The SENSOR decides "raining here"; the FORECAST is shown next to it for comparison.
function renderRain(wet) {
  const fc = rainTypeOutside();                       // null until the forecast arrives
  const fcRain = !!fc && fc !== 'none' && fc !== 'mist';
  const [icon, name, desc, level] = RAIN_TYPES[fc || 'none'];

  // scene follows the sensor; forecast only sets how heavy it looks while the sensor is wet
  const card = $('rainCard');
  card.classList.toggle('is-raining', wet);
  card.classList.toggle('alert', wet);
  ['lvl-1', 'lvl-2', 'lvl-3', 'lvl-4'].forEach((c) => card.classList.remove(c));
  if (wet) card.classList.add('lvl-' + (fcRain ? Math.max(1, level) : 1));
  card.classList.toggle('hail', wet && fc === 'hail');
  card.classList.toggle('thunder', wet && fc === 'thunder');
  card.classList.toggle('misty', fc === 'mist');

  setText($('rain'), wet ? 'Raining here' : 'Dry here');
  setChip('rainBadge', wet ? 'Water detected' : 'No water', wet ? 'hot' : 'ok');
  setStat('rainSensor', wet ? 'Wet' : 'Dry', wet ? 'hot' : 'ok');

  $('rainIcon').textContent = fc ? icon : '⏳';
  setText($('rainType'), fc ? name : 'Checking…');
  $('rainDesc').textContent = fc ? desc : 'Getting the forecast for your location…';
  if (!fc) setStat('rainAmount', '--');
  else if (has(outside.precip) && outside.precip > 0) setStat('rainAmount', `${outside.precip.toFixed(1)} mm/h`, level >= 3 ? 'hot' : 'warn');
  else setStat('rainAmount', fcRain ? name : 'No rain', fcRain ? 'warn' : 'ok');

  if (!fc) setStat('rainCmp', 'Waiting for forecast…');
  else if (wet === fcRain) setStat('rainCmp', wet ? '✓ Both say rain' : '✓ Both say no rain', 'ok');
  else setStat('rainCmp', wet ? '⚠ Wet here, but no rain forecast' : '⚠ Dry here, but rain is forecast', 'warn');

  const s = seasonNow();
  setStat('season', s.text, s.cls);
}

// Temperature & humidity: sensor vs forecast
function renderTempCompare(t) {
  const el = $('tempCmp');
  if (!outside || !has(outside.temp) || !has(t)) { el.textContent = ''; return; }
  const d = t - outside.temp;
  el.className = 'cmp ' + (Math.abs(d) < 1.5 ? 'ok' : 'warn');
  el.textContent = Math.abs(d) < 1.5
    ? `✓ Sensor (${t.toFixed(1)}°) matches the forecast`
    : `Sensor (${t.toFixed(1)}°) is ${Math.abs(d).toFixed(1)}° ${d > 0 ? 'warmer' : 'cooler'} than the forecast`;
}

function renderHumCompare(rh) {
  if (!outside || !has(outside.rh) || !has(rh)) { setStat('humCmp', outside ? '--' : 'Waiting for forecast…'); return; }
  const d = rh - outside.rh;
  if (Math.abs(d) < 8) setStat('humCmp', `✓ Close to forecast (${outside.rh}%)`, 'ok');
  else setStat('humCmp', `Sensor ${Math.abs(Math.round(d))}% ${d > 0 ? 'more humid' : 'drier'} than forecast (${outside.rh}%)`, 'warn');
}

// ---------- what kind of light is it? ----------
// The sensor only knows bright/dark; the sun's position and the sky at your location add the rest.
const LIGHT_TYPES = {
  night:    ['🌙', 'Night', 'The sun is down'],
  dawn:     ['🌄', 'Dawn', 'Sky brightening before sunrise'],
  sunrise:  ['🌅', 'Sunrise', 'The sun is coming up'],
  golden:   ['🌇', 'Golden hour', 'Warm, soft, low sunlight'],
  sunny:    ['☀️', 'Bright sunlight', 'Clear sky, strong daylight'],
  soft:     ['🌤️', 'Soft daylight', 'Sun with some clouds'],
  overcast: ['☁️', 'Overcast daylight', 'Dim, diffused light through clouds'],
  storm:    ['⛈️', 'Stormy dark', 'Thick storm clouds block the sun'],
  sunset:   ['🌇', 'Sunset', 'The sun is going down'],
  dusk:     ['🌆', 'Twilight', 'Fading light after sunset'],
};

function lightTypeOutside() {
  if (!outside || !outside.sunrise) return null;
  const now = Date.now(), sr = outside.sunrise, ss = outside.sunset, H = 3600e3;
  if (now < sr - H / 2 || now > ss + H / 2) return 'night';
  if (now < sr) return 'dawn';
  if (now > ss) return 'dusk';
  if (now < sr + H / 2) return 'sunrise';
  if (now > ss - H / 2) return 'sunset';
  if (now < sr + 1.5 * H || now > ss - 1.5 * H) return 'golden';
  if (outside.code >= 95) return 'storm';
  if (outside.cloud >= 80 || outside.code >= 61) return 'overcast';
  if (outside.cloud >= 40) return 'soft';
  return 'sunny';
}

const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// The SENSOR decides bright/dark here; the FORECAST sky is shown next to it for comparison.
function renderLight(dark) {
  const card = $('lightCard');
  const sky = lightTypeOutside();
  const nightish = sky === 'night' || sky === 'dusk' || sky === 'dawn';
  const lamp = !!sky && !dark && nightish;

  card.classList.toggle('is-dark', dark);
  card.classList.toggle('lamp', lamp);
  card.classList.toggle('golden', ['golden', 'sunrise', 'sunset'].includes(sky) && !dark);
  card.classList.toggle('twilight', (sky === 'dawn' || sky === 'dusk') && dark);
  card.classList.toggle('overcast', (sky === 'overcast' || sky === 'storm') && !dark);

  // move the sun along an arc from sunrise (left) to sunset (right)
  const sun = card.querySelector('.sun');
  if (outside?.sunrise && !nightish) {
    const p = clamp((Date.now() - outside.sunrise) / (outside.sunset - outside.sunrise), 0, 1);
    sun.style.left = 18 + p * 64 + '%';
    sun.style.top = 72 - Math.sin(Math.PI * p) * 40 + '%';
  } else { sun.style.left = ''; sun.style.top = ''; }

  setText($('light'), dark ? 'Dark here' : 'Bright here');
  setChip('lightBadge', dark ? 'Low light' : 'Bright', dark ? 'warn' : 'ok');
  setStat('lightSensor', dark ? 'Dark' : 'Bright', dark ? 'warn' : 'ok');
  const [icon, name, desc] = sky ? LIGHT_TYPES[sky] : ['⏳', 'Checking…', 'Getting the sky forecast for your location…'];
  $('lightIcon').textContent = icon;
  setText($('lightType'), name);
  $('lightDesc').textContent = desc;

  if (!sky) setStat('lightCmp', 'Waiting for forecast…');
  else if (dark === nightish) setStat('lightCmp', dark ? '✓ Both say dark' : '✓ Both say bright', 'ok');
  else setStat('lightCmp', dark ? "🏠 Dark here in daytime: sensor shaded or covered" : '💡 Bright here at night: lights are on', 'warn');

  if (outside && has(outside.uv)) {
    const uv = outside.uv;
    const lvl = uv < 3 ? ['Low', 'ok'] : uv < 6 ? ['Moderate', 'warn'] : uv < 8 ? ['High', 'hot'] : uv < 11 ? ['Very high', 'hot'] : ['Extreme', 'hot'];
    setStat('uvIndex', `${uv.toFixed(0)} · ${lvl[0]}`, lvl[1]);
  } else setStat('uvIndex', '--');
  setStat('sunrise', outside?.sunrise ? fmtTime(outside.sunrise) : '--');
  setStat('sunset', outside?.sunset ? fmtTime(outside.sunset) : '--');
}

// Season for where you are (Philippine monsoon seasons, otherwise by hemisphere)
function seasonNow() {
  const m = new Date().getMonth() + 1;
  if (!place) return { text: 'Checking location…', cls: '' };
  if (place.cc === 'PH') {
    if (m >= 6 && m <= 9) return { text: '🌧️ Habagat · rainy & typhoon season', cls: 'warn' };
    if (m === 10 || m === 11) return { text: '🌀 Late rainy season · typhoons, Amihan starting', cls: 'warn' };
    if (m === 12 || m <= 2) return { text: '🌬️ Amihan · cool, drier season', cls: 'ok' };
    return { text: '☀️ Tag-init · hot dry season', cls: 'hot' };
  }
  if (Math.abs(place.lat) < 23.5) return { text: 'Tropical climate · check local wet season', cls: '' };
  const north = place.lat >= 0;
  const idx = Math.floor((m % 12) / 3);   // 0 Dec-Feb, 1 Mar-May, 2 Jun-Aug, 3 Sep-Nov
  const names = north ? ['❄️ Winter', '🌸 Spring', '☀️ Summer', '🍂 Autumn'] : ['☀️ Summer', '🍂 Autumn', '❄️ Winter', '🌸 Spring'];
  return { text: names[idx], cls: '' };
}

// ---------- buzzer control ----------
function setMode(mode) {
  buzzerMode = mode;
  const buttons = [...document.querySelectorAll('#buzzerMode button')];
  const i = Math.max(0, buttons.findIndex((b) => b.dataset.mode === mode));
  buttons.forEach((b, j) => b.classList.toggle('active', j === i));
  $('modePill').style.transform = `translateX(${i * 100}%)`;
}

document.querySelectorAll('#buzzerMode button').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const mode = btn.dataset.mode;
    setMode(mode);
    if (DEMO) { demo.mode = mode; return; }
    try {
      const res = await fetch('buzzer.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
    } catch (err) {
      setStatus('offline', 'Could not change buzzer mode');
    }
  });
});

// ---------- clap to buzz (microphone of the device viewing the page) ----------
// Double clap: two claps between DOUBLE_MIN_MS and DOUBLE_MAX_MS apart trigger one buzz.
const clap = { on: false, stream: null, ctx: null, raf: 0, bg: 0.01, lastHit: 0, first: 0, cooldownUntil: 0 };
const ECHO_MS = 120;          // ignore the tail/echo of the same clap
const DOUBLE_MIN_MS = 150;
const DOUBLE_MAX_MS = 1000;
const COOLDOWN_MS = 1500;     // after a double clap, wait before listening again

// Sensitivity 1..10 -> how loud (0..1) and how far above room noise a clap must be
function clapThresholds() {
  const s = +$('clapSens').value;
  return { minPeak: 0.32 - s * 0.03, jump: 6 - s * 0.35 };   // 7 -> 0.11 & 3.55x, 10 -> 0.02 & 2.5x
}

function setClapUI(on, label, hint) {
  $('clapBtn').classList.toggle('on', on);
  $('clapBtn').setAttribute('aria-pressed', on);
  $('clapLabel').textContent = label;
  $('clapHint').textContent = hint;
  if (!on) $('clapMeter').style.width = '0';
}

async function startClap() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    setClapUI(false, 'Microphone unavailable', 'Open the site with https:// or on localhost');
    return;
  }
  try {
    clap.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (err) {
    setClapUI(false, 'Microphone blocked', 'Allow the microphone in the address bar, then try again');
    return;
  }
  clap.ctx = new (window.AudioContext || window.webkitAudioContext)();
  const analyser = clap.ctx.createAnalyser();
  analyser.fftSize = 1024;
  clap.ctx.createMediaStreamSource(clap.stream).connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  clap.on = true;
  setClapUI(true, 'Listening…', 'Clap twice to buzz · tap to stop');

  const listen = () => {
    analyser.getFloatTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > peak) peak = a; }
    $('clapMeter').style.width = Math.min(100, peak * 250) + '%';
    const now = performance.now();
    const { minPeak, jump } = clapThresholds();
    const isHit = peak > minPeak && peak > clap.bg * jump;
    if (isHit && now - clap.lastHit > ECHO_MS && now > clap.cooldownUntil) {
      clap.lastHit = now;
      onClapHit(now);
    }
    if (!isHit) clap.bg = clap.bg * 0.97 + peak * 0.03;  // follow the room's background noise (not the claps)
    clap.raf = requestAnimationFrame(listen);
  };
  listen();
}

function stopClap() {
  clap.on = false;
  cancelAnimationFrame(clap.raf);
  clap.stream?.getTracks().forEach((t) => t.stop());
  clap.ctx?.close();
  clap.stream = clap.ctx = null;
  setClapUI(false, 'Double clap to buzz', "Uses this device's microphone");
}

function popClap(cardFlash) {
  const btn = $('clapBtn'), card = $('buzzerCard');
  btn.classList.remove('hit'); void btn.offsetWidth; btn.classList.add('hit');
  if (cardFlash) { card.classList.remove('clap-hit'); void card.offsetWidth; card.classList.add('clap-hit'); }
}

let clapHintTimer;
function clapHint(text, ms) {
  $('clapHint').textContent = text;
  clearTimeout(clapHintTimer);
  if (ms) clapHintTimer = setTimeout(() => { if (clap.on) $('clapHint').textContent = 'Clap twice to buzz · tap to stop'; }, ms);
}

function onClapHit(now) {
  const gap = now - clap.first;
  if (clap.first && gap >= DOUBLE_MIN_MS && gap <= DOUBLE_MAX_MS) {
    clap.first = 0;
    clap.cooldownUntil = now + COOLDOWN_MS;
    onDoubleClap();
  } else {
    clap.first = now;  // first clap: wait for the second one
    popClap(false);
    clapHint('👏 1… clap again!', DOUBLE_MAX_MS);
  }
}

async function onDoubleClap() {
  popClap(true);
  clapHint('👏👏 Double clap! Buzzing…', 1800);
  if (DEMO) { demo.clapUntil = Date.now() + 1000; return; }
  try {
    await fetch('buzzer.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'beep' }),
    });
  } catch (err) {
    clapHint('Could not reach the server', 2000);
  }
}

$('clapBtn').addEventListener('click', () => (clap.on ? stopClap() : startClap()));

// sensitivity slider, remembered in this browser
try { const s = localStorage.getItem('clapSens'); if (s) $('clapSens').value = s; } catch (e) {}
$('clapSens').addEventListener('input', () => {
  $('clapSensVal').textContent = $('clapSens').value;
  try { localStorage.setItem('clapSens', $('clapSens').value); } catch (e) {}
});
$('clapSensVal').textContent = $('clapSens').value;

// ---------- charts (one metric per chart, plain SVG) ----------
const SVG = 'http://www.w3.org/2000/svg';
function el(tag, attrs, parent) {
  const n = document.createElementNS(SVG, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
}
const timeLabel = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function drawCharts() {
  document.querySelectorAll('.chart').forEach(drawChart);
}

function drawChart(fig) {
  const { key, unit, title } = fig.dataset;
  if (fig.dataset.drawn && fig.matches(':hover')) return;  // don't redraw under the mouse
  const pts = history.filter((h) => has(h[key]));
  const firstDraw = !fig.dataset.drawn && pts.length >= 2;

  fig.innerHTML = `<figcaption>${title}<span>${pts.length} readings · ${unit}</span></figcaption>`;
  const W = Math.max(fig.clientWidth - 40, 200), H = 170, L = 34, R = 10, T = 10, B = 22;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${title} over time` }, fig);

  if (pts.length < 2) {
    el('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'empty' }, svg).textContent = 'Waiting for data…';
    return;
  }
  fig.dataset.drawn = '1';

  const vals = pts.map((p) => p[key]);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (unit === '%') { lo = Math.min(lo, 0); hi = Math.max(hi, 100); }
  else { const pad = Math.max((hi - lo) * 0.25, 1); lo = Math.max(0, Math.floor(lo - pad)); hi = Math.ceil(hi + pad); }

  const t0 = pts[0].time, t1 = pts.at(-1).time;
  const x = (t) => L + ((t - t0) / Math.max(t1 - t0, 1)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);

  const defs = el('defs', {}, svg);
  const grad = el('linearGradient', { id: 'area-' + key, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
  el('stop', { offset: 0, 'stop-color': '#ff2e4d', 'stop-opacity': 0.35 }, grad);
  el('stop', { offset: 1, 'stop-color': '#ff2e4d', 'stop-opacity': 0 }, grad);

  const grid = el('g', { class: 'gl' }, svg);
  const axis = el('g', { class: 'axis' }, svg);
  for (let i = 0; i <= 3; i++) {
    const v = lo + ((hi - lo) * i) / 3;
    el('line', { x1: L, x2: W - R, y1: y(v), y2: y(v) }, grid);
    el('text', { x: L - 8, y: y(v) + 4, 'text-anchor': 'end' }, axis).textContent = Math.round(v);
  }
  el('text', { x: L, y: H - 4 }, axis).textContent = timeLabel(t0);
  el('text', { x: W - R, y: H - 4, 'text-anchor': 'end' }, axis).textContent = timeLabel(t1);

  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.time).toFixed(1)},${y(p[key]).toFixed(1)}`).join('');
  el('path', { class: 'area' + (firstDraw ? ' draw' : ''), fill: `url(#area-${key})`, d: `${line}L${x(t1)},${H - B}L${x(t0)},${H - B}Z` }, svg);
  el('path', { class: 'line' + (firstDraw ? ' draw' : ''), d: line, pathLength: 1 }, svg);

  const last = pts.at(-1);
  el('circle', { class: 'last-ring', cx: x(last.time), cy: y(last[key]), r: 5 }, svg);
  el('circle', { class: 'last', cx: x(last.time), cy: y(last[key]), r: 3.5 }, svg);

  // hover crosshair + tooltip
  const cross = el('line', { class: 'cross', y1: T, y2: H - B, visibility: 'hidden' }, svg);
  const marker = el('circle', { class: 'marker', r: 5, visibility: 'hidden' }, svg);
  const tip = document.createElement('div');
  tip.className = 'tooltip';
  tip.hidden = true;
  fig.appendChild(tip);

  const hit = el('rect', { x: L, y: 0, width: W - L - R, height: H, fill: 'transparent' }, svg);
  hit.addEventListener('pointermove', (e) => {
    const box = svg.getBoundingClientRect();
    const mx = ((e.clientX - box.left) / box.width) * W;
    let best = pts[0];
    for (const p of pts) if (Math.abs(x(p.time) - mx) < Math.abs(x(best.time) - mx)) best = p;
    const px = x(best.time), py = y(best[key]);
    cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
    marker.setAttribute('cx', px); marker.setAttribute('cy', py); marker.setAttribute('visibility', 'visible');
    tip.innerHTML = `<b>${best[key]}${unit}</b> · ${new Date(best.time * 1000).toLocaleTimeString()}`;
    tip.style.left = 20 + (px / W) * box.width + 'px';
    tip.style.top = svg.offsetTop + (py / H) * box.height + 'px';
    tip.hidden = false;
  });
  hit.addEventListener('pointerleave', () => {
    cross.setAttribute('visibility', 'hidden');
    marker.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  });
}

// ---------- decorations ----------
function buildScenes() {
  const drops = $('drops');
  for (let i = 0; i < 18; i++) {
    const d = document.createElement('span');
    d.className = 'drop';
    d.style.left = 22 + Math.random() * 56 + '%';
    d.style.setProperty('--delay', (Math.random() * 1.2).toFixed(2) + 's');
    d.style.setProperty('--d', (0.6 + Math.random() * 0.5).toFixed(2) + 's');
    drops.appendChild(d);
  }
  const stars = $('stars');
  for (let i = 0; i < 22; i++) {
    const s = document.createElement('span');
    s.className = 'star';
    s.style.left = Math.random() * 100 + '%';
    s.style.top = Math.random() * 100 + '%';
    s.style.setProperty('--delay', (Math.random() * 2.4).toFixed(2) + 's');
    stars.appendChild(s);
  }
  // drop the entrance animation once it's done so hover lifts work
  document.querySelectorAll('.reveal').forEach((r) => {
    r.addEventListener('animationend', (e) => { if (e.animationName === 'rise') r.classList.remove('reveal'); });
  });
  // spotlight that follows the mouse on each card
  document.querySelectorAll('.card').forEach((c) => {
    c.addEventListener('pointermove', (e) => {
      const b = c.getBoundingClientRect();
      c.style.setProperty('--mx', e.clientX - b.left + 'px');
      c.style.setProperty('--my', e.clientY - b.top + 'px');
    });
  });
}

let shownDate = '';
function tickClock() {
  const now = new Date();
  $('clock').textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  if (now.toDateString() !== shownDate) {  // first run, and again at midnight
    shownDate = now.toDateString();
    renderToday(now);
    cal.y = now.getFullYear(); cal.m = now.getMonth();
    renderCalendar();
  }
}

// ---------- date & mini calendar ----------
const cal = { y: 0, m: 0 };

function renderToday(d) {
  $('todayDay').textContent = d.getDate();
  $('todayWeekday').textContent = d.toLocaleDateString([], { weekday: 'long' });
  $('todayMonthYear').textContent = d.toLocaleDateString([], { month: 'long', year: 'numeric' });
}

function renderCalendar(dir) {
  const grid = $('calGrid');
  const first = new Date(cal.y, cal.m, 1);
  const daysInMonth = new Date(cal.y, cal.m + 1, 0).getDate();
  const daysInPrev = new Date(cal.y, cal.m, 0).getDate();
  const today = new Date();
  $('calTitle').textContent = first.toLocaleDateString([], { month: 'long', year: 'numeric' });

  let html = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((d) => `<span class="dow">${d}</span>`).join('');
  for (let i = 0; i < 42; i++) {  // always 6 rows so the card doesn't jump
    const n = i - first.getDay() + 1;
    let day = n, cls = 'd';
    if (n < 1) { day = daysInPrev + n; cls += ' muted'; }
    else if (n > daysInMonth) { day = n - daysInMonth; cls += ' muted'; }
    else {
      if (i % 7 === 0) cls += ' sunday';
      if (cal.y === today.getFullYear() && cal.m === today.getMonth() && n === today.getDate()) cls += ' is-today';
    }
    html += `<span class="${cls}">${day}</span>`;
  }
  grid.innerHTML = html;
  if (dir) {
    grid.classList.remove('slide-next', 'slide-prev');
    void grid.offsetWidth;
    grid.classList.add(dir > 0 ? 'slide-next' : 'slide-prev');
  }
}

function moveMonth(dir) {
  cal.m += dir;
  if (cal.m < 0) { cal.m = 11; cal.y--; }
  if (cal.m > 11) { cal.m = 0; cal.y++; }
  renderCalendar(dir);
}
$('calPrev').addEventListener('click', () => moveMonth(-1));
$('calNext').addEventListener('click', () => moveMonth(1));

// ---------- your location + outdoor weather (Open-Meteo, free, no key) ----------
const WX = {
  0: ['☀️', 'Clear sky'], 1: ['🌤️', 'Mainly clear'], 2: ['⛅', 'Partly cloudy'], 3: ['☁️', 'Overcast'],
  45: ['🌫️', 'Fog'], 48: ['🌫️', 'Fog'], 51: ['🌦️', 'Light drizzle'], 53: ['🌦️', 'Drizzle'], 55: ['🌧️', 'Heavy drizzle'],
  61: ['🌦️', 'Light rain'], 63: ['🌧️', 'Rain'], 65: ['🌧️', 'Heavy rain'], 80: ['🌦️', 'Rain showers'],
  81: ['🌧️', 'Rain showers'], 82: ['⛈️', 'Heavy showers'], 95: ['⛈️', 'Thunderstorm'], 96: ['⛈️', 'Thunderstorm, hail'], 99: ['⛈️', 'Thunderstorm, hail'],
};
let place = null;
let outside = null;   // { code, pm25 } for the humidity card's fog and smoke info

async function findPlace() {
  // Ask the browser for the exact location; if refused, BigDataCloud guesses the city from the internet connection
  const coords = await new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition((p) => resolve(p.coords), () => resolve(null), { timeout: 10000, maximumAge: 600000 });
  });
  const q = coords ? `latitude=${coords.latitude}&longitude=${coords.longitude}&` : '';
  let info = {};
  try { info = await (await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?${q}localityLanguage=en`)).json(); } catch (e) {}
  const lat = coords?.latitude ?? info.latitude, lon = coords?.longitude ?? info.longitude;
  const city = info.city || info.locality || info.principalSubdivision;
  const name = [city, info.countryName].filter(Boolean).join(', ') || 'Your location';
  return has(lat) && has(lon) ? { lat, lon, cc: info.countryCode, name: coords ? name : name + ' (approx.)' } : null;
}

async function updateWeather() {
  try {
    if (!place) place = await findPlace();
    if (!place) { $('locName').textContent = 'Location unavailable'; $('wxDesc').textContent = 'Allow location to see the weather'; return; }
    $('locName').textContent = place.name;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${place.lat.toFixed(3)}&longitude=${place.lon.toFixed(3)}`
      + '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,is_day,precipitation,cloud_cover'
      + '&hourly=uv_index&daily=temperature_2m_max,temperature_2m_min,sunrise,sunset&timezone=auto&forecast_days=1';
    const w = await (await fetch(url)).json();
    const c = w.current;
    let [icon, desc] = WX[c.weather_code] || ['🌡️', 'Weather'];
    if (!c.is_day && c.weather_code <= 1) icon = '🌙';
    $('wxIcon').textContent = icon;
    tween($('wxTemp'), c.temperature_2m, 1);
    $('wxDesc').textContent = `${desc} · feels like ${Math.round(c.apparent_temperature)}°`;
    $('wxHiLo').textContent = `High ${Math.round(w.daily.temperature_2m_max[0])}° · Low ${Math.round(w.daily.temperature_2m_min[0])}° · Humidity ${c.relative_humidity_2m}%`;

    // times come in the location's local time; turn them into real timestamps
    const toMs = (s) => Date.parse(s + 'Z') - w.utc_offset_seconds * 1000;
    const hourIdx = w.hourly.time.findIndex((h) => h.slice(0, 13) === c.time.slice(0, 13));
    outside = {
      code: c.weather_code, precip: c.precipitation, cloud: c.cloud_cover, pm25: null,
      temp: c.temperature_2m, rh: c.relative_humidity_2m,
      uv: hourIdx >= 0 ? w.hourly.uv_index[hourIdx] : null,
      sunrise: toMs(w.daily.sunrise[0]), sunset: toMs(w.daily.sunset[0]),
    };
    try {
      const aq = await (await fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${place.lat.toFixed(3)}&longitude=${place.lon.toFixed(3)}&current=pm2_5`)).json();
      outside.pm25 = aq.current?.pm2_5 ?? null;
    } catch (e) {}
    const last = history.at(-1);
    renderHumidityType(last?.temperature, last?.humidity);
    renderRain(!!last?.raining);
    renderLight(!!last?.dark);
    renderTempCompare(last?.temperature);
  } catch (err) {
    $('wxDesc').textContent = 'Weather unavailable right now';
    console.error(err);
  }
}

// ---------- demo data ----------
const demo = { mode: 'auto', list: [], clapUntil: 0 };
function demoData(withHistory) {
  const now = Math.floor(Date.now() / 1000);
  if (!demo.list.length) for (let i = 60; i > 0; i--) demo.list.push(fakeReading(now - i * 2));
  demo.list.push(fakeReading(now));
  if (demo.list.length > 400) demo.list.shift();
  return { latest: demo.list.at(-1), control: { buzzer: demo.mode }, serverTime: now, history: withHistory ? demo.list : undefined };
}
function fakeReading(t) {
  const s = t / 20;
  const raining = Math.sin(s / 3) > 0.7;
  const dark = Math.sin(s / 5) < -0.4;
  const distance = +(60 + 55 * Math.sin(s / 1.5) + Math.random() * 3).toFixed(1);
  const reason = demo.mode === 'on' ? 'Manual (website)' : demo.mode === 'off' ? ''
    : Date.now() < demo.clapUntil ? 'Clap detected'
    : raining ? 'Water detected' : dark ? 'Dark' : distance <= 10 ? 'Object too close' : '';
  return {
    temperature: +(31 + 3 * Math.sin(s / 4) + Math.random() * 0.4).toFixed(1),
    humidity: Math.round(68 + 10 * Math.cos(s / 3) + Math.random() * 2),
    distance, raining, dark,
    buzzer: reason !== '',
    reason,
    time: t,
  };
}

// ---------- live push (Server-Sent Events) with polling fallback ----------
let lastPush = 0;
function startStream() {
  if (DEMO || location.protocol === 'file:' || !window.EventSource) return;
  const es = new EventSource('events');
  es.onmessage = (e) => {
    lastPush = Date.now();
    $('transport').textContent = 'ESP32 → server → live push ⚡';
    try { handleData(JSON.parse(e.data)); } catch (err) { console.error(err); }
  };
  es.onerror = () => {
    // a PHP host has no /events: stop trying and rely on polling
    if (es.readyState === EventSource.CLOSED) $('transport').textContent = 'ESP32 → JSON → data.php → you';
  };
}

// ---------- start ----------
buildScenes();
tickClock();
setInterval(tickClock, 1000);
updateWeather();
setInterval(updateWeather, 10 * 60 * 1000);  // refresh outdoor weather every 10 minutes
poll(true).then(startStream);
let polling = false;
setInterval(async () => {
  if (document.hidden || polling || Date.now() - lastPush < 7000) return;  // skip hidden tabs and overlapping requests
  polling = true;
  try { await poll(false); } finally { polling = false; }
}, POLL_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(false); });
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(drawCharts, 150); });
