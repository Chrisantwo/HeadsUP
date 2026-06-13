// ============================================================================
// forecast_engine.js
// 7-day Typhoon AI Forecast — Leaflet + canvas wind particle engine
// ============================================================================

'use strict';

// ── Constants ──────────────────────────────────────────────────────────────
const PAR          = { latMin: 5.0, latMax: 25.0, lonMin: 115.0, lonMax: 135.0 };
const GRID_N       = 20;
const PARTICLE_COUNT = 1500;
const MAX_AGE      = 160;     // frames before particle respawns
const SPEED_SCALE  = 0.0075;  // base deg/frame per unit wind speed
const FADE_ALPHA   = 0.035;   // destination-out canvas fade per frame
const PLAY_INTERVAL= 600;     // ms between auto-advance steps when playing
const API_BASE     = '';

// Typhoon category thresholds (knots)
const CATEGORIES = [
    { min: 0,   max: 33,  label: 'TD',  name: 'Tropical Depression',   color: '#87ceeb' },
    { min: 34,  max: 63,  label: 'TS',  name: 'Tropical Storm',        color: '#64ee64' },
    { min: 64,  max: 95,  label: 'TY',  name: 'Typhoon (Cat 1-2)',     color: '#e1e100' },
    { min: 96,  max: 113, label: 'STY', name: 'Severe Typhoon Cat 3',  color: '#ff8200' },
    { min: 114, max: 149, label: 'STY', name: 'Super Typhoon Cat 4',   color: '#ff0000' },
    { min: 150, max: 999, label: 'STY', name: 'Super Typhoon Cat 5',   color: '#ff00ff' },
];

function getCategory(windKt) {
    return CATEGORIES.find(c => windKt >= c.min && windKt <= c.max) || CATEGORIES[0];
}

// Sample track for the Manual tab (Typhoon EWINIAR 2024, 3-hourly)
const SAMPLE_HISTORY = [
    {"lat":11.2,"lon":125.5,"pressure":1004,"wind_speed":25},
    {"lat":11.8,"lon":124.8,"pressure":1004,"wind_speed":27},
    {"lat":12.3,"lon":124.1,"pressure":1003,"wind_speed":29},
    {"lat":12.6,"lon":123.5,"pressure":1003,"wind_speed":29},
    {"lat":12.8,"lon":123.0,"pressure":1003,"wind_speed":29},
    {"lat":13.2,"lon":122.5,"pressure":1001,"wind_speed":32},
    {"lat":13.5,"lon":122.2,"pressure":998, "wind_speed":35},
    {"lat":13.9,"lon":121.8,"pressure":995, "wind_speed":40},
    {"lat":14.3,"lon":121.4,"pressure":992, "wind_speed":45},
    {"lat":14.7,"lon":120.9,"pressure":988, "wind_speed":52},
    {"lat":15.1,"lon":120.4,"pressure":984, "wind_speed":58},
    {"lat":15.5,"lon":119.8,"pressure":980, "wind_speed":63},
    {"lat":15.9,"lon":119.3,"pressure":975, "wind_speed":70},
    {"lat":16.3,"lon":118.8,"pressure":969, "wind_speed":78},
    {"lat":16.8,"lon":118.2,"pressure":962, "wind_speed":88},
    {"lat":17.2,"lon":117.6,"pressure":955, "wind_speed":95},
];

// ── Application state ──────────────────────────────────────────────────────
const state = {
    forecast:        null,
    currentStep:     0,
    trackHistory:    [],
    fullObsTrack:    [],
    isPlaying:       false,
    playTimer:       null,
    stormMarker:     null,
    pathLayer:       null,
    trackLayer:      null,
    obsTrackLayer:   null,
};

// ── Map ────────────────────────────────────────────────────────────────────
let map;

function initMap() {
    map = L.map('map', { center: [12.5, 122.0], zoom: 5, preferCanvas: true });
    L.tileLayer(
        'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
        {
            attribution:
                '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> ' +
                '&copy; <a href="https://carto.com/attributions">CARTO</a>',
            subdomains: 'abcd', maxZoom: 19,
        }
    ).addTo(map);

    // PAR bounding box
    L.rectangle(
        [[PAR.latMin, PAR.lonMin], [PAR.latMax, PAR.lonMax]],
        { color: '#00ffff', weight: 1, opacity: 0.3, fill: false, dashArray: '5,8' }
    ).addTo(map);
}

// ── Wind canvas ────────────────────────────────────────────────────────────
let windCanvas, windEngine;

function initWindCanvas() {
    windCanvas = document.getElementById('wind-canvas');
    const container = map.getContainer();
    container.appendChild(windCanvas);
    Object.assign(windCanvas.style, {
        position: 'absolute', top: '0', left: '0',
        width: '100%', height: '100%',
        pointerEvents: 'none', zIndex: '201',
    });
    _resizeWind();
    window.addEventListener('resize', _resizeWind);
    windEngine = new WindParticleEngine(map, windCanvas);
    map.on('movestart zoomstart', () => windEngine.clearTrails());
}

function _resizeWind() {
    if (!windCanvas) return;
    const c = map.getContainer();
    windCanvas.width  = c.clientWidth;
    windCanvas.height = c.clientHeight;
}

// ── Wind Particle Engine ───────────────────────────────────────────────────
class WindParticleEngine {
    constructor(mapRef, canvas) {
        this.map    = mapRef;
        this.canvas = canvas;
        this.ctx    = canvas.getContext('2d');
        this.grid   = null;
        this.active = false;
        this.animId = null;
        this.particles = [];
        this._initParticles();
    }

    _initParticles() {
        this.particles = Array.from({ length: PARTICLE_COUNT }, () => this._newP(true));
    }

    _newP(randomAge) {
        return {
            lat: PAR.latMin + Math.random() * (PAR.latMax - PAR.latMin),
            lon: PAR.lonMin + Math.random() * (PAR.lonMax - PAR.lonMin),
            age: randomAge ? Math.floor(Math.random() * MAX_AGE) : 0,
        };
    }

    setGrid(grid) { this.grid = grid; }
    clearTrails()  { this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); }

    // Bilinear interpolation of a 2-D field at geographic (lat, lon)
    _bilinear(lat, lon, field) {
        const ty = (lat - PAR.latMin) / (PAR.latMax - PAR.latMin) * (GRID_N - 1);
        const tx = (lon - PAR.lonMin) / (PAR.lonMax - PAR.lonMin) * (GRID_N - 1);
        const i  = Math.floor(ty), j = Math.floor(tx);
        if (i < 0 || i >= GRID_N - 1 || j < 0 || j >= GRID_N - 1) return 0;
        const fy = ty - i, fx = tx - j;
        return (1-fy) * ((1-fx)*field[i][j]   + fx*field[i][j+1]) +
                  fy  * ((1-fx)*field[i+1][j]  + fx*field[i+1][j+1]);
    }

    // Wind speed (m/s, 0–45) → [r, g, b] color spectrum
    _color(speed) {
        const t = Math.min(Math.max(speed / 45, 0), 1);
        const stops = [
            [0.00, [3, 80, 200]], [0.15, [0, 200, 255]], [0.35, [0, 230, 70]],
            [0.55, [255, 230, 0]], [0.75, [255, 120, 0]], [1.00, [255, 30, 30]],
        ];
        for (let s = 0; s < stops.length - 1; s++) {
            const [t0, c0] = stops[s], [t1, c1] = stops[s + 1];
            if (t >= t0 && t <= t1) {
                const f = (t - t0) / (t1 - t0);
                return stops[s + 1][1].map((v, i) => Math.round(c0[i] + f * (v - c0[i])));
            }
        }
        return [255, 30, 30];
    }

    _animate() {
        if (!this.active) return;
        const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;

        // Fade trails (destination-out keeps canvas transparent over the map)
        ctx.globalCompositeOperation = 'destination-out';
        ctx.fillStyle = `rgba(0,0,0,${FADE_ALPHA})`;
        ctx.fillRect(0, 0, W, H);
        ctx.globalCompositeOperation = 'source-over';

        if (!this.grid) { this.animId = requestAnimationFrame(() => this._animate()); return; }

        const cosLat = Math.cos(((PAR.latMin + PAR.latMax) / 2) * Math.PI / 180);

        for (const p of this.particles) {
            p.age++;
            if (p.age > MAX_AGE) { Object.assign(p, this._newP(false)); continue; }

            const u = this._bilinear(p.lat, p.lon, this.grid.u);
            const v = this._bilinear(p.lat, p.lon, this.grid.v);
            const spd = Math.sqrt(u * u + v * v);

            const pt0 = this.map.latLngToContainerPoint([p.lat, p.lon]);

            if (spd > 0.05) {
                const scale = SPEED_SCALE * (0.25 + 0.75 * Math.min(spd / 20, 1));
                p.lon += (u / spd) * scale / cosLat;
                p.lat += (v / spd) * scale;
            }

            if (p.lat < PAR.latMin || p.lat > PAR.latMax ||
                p.lon < PAR.lonMin || p.lon > PAR.lonMax) {
                Object.assign(p, this._newP(false)); continue;
            }

            const pt1 = this.map.latLngToContainerPoint([p.lat, p.lon]);
            const dx = pt1.x - pt0.x, dy = pt1.y - pt0.y;
            if (dx * dx + dy * dy < 0.04) continue;

            const alpha = Math.max(0.05, 0.85 * (1 - p.age / MAX_AGE));
            const [r, g, b] = this._color(spd);
            ctx.beginPath();
            ctx.moveTo(pt0.x, pt0.y);
            ctx.lineTo(pt1.x, pt1.y);
            ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
            ctx.lineWidth   = 1.3;
            ctx.stroke();
        }
        this.animId = requestAnimationFrame(() => this._animate());
    }

    start() {
        if (this.active) return;
        this.active = true;
        this._initParticles();
        this.animId = requestAnimationFrame(() => this._animate());
    }

    stop() {
        this.active = false;
        if (this.animId) { cancelAnimationFrame(this.animId); this.animId = null; }
        this.clearTrails();
    }
}

// ── Storm pulse marker ─────────────────────────────────────────────────────
function makePulseIcon(color) {
    return L.divIcon({
        className: '',
        html: `<div class="storm-pulse-wrapper">
          <div class="pulse-ring"  style="border-color:${color};"></div>
          <div class="pulse-ring2" style="border-color:${color};"></div>
          <div class="pulse-dot"   style="background:${color};box-shadow:0 0 8px 3px ${color};"></div>
        </div>`,
        iconSize:   [44, 44],
        iconAnchor: [22, 22],
    });
}

// ── Map drawing helpers ────────────────────────────────────────────────────
function drawObservedTrack(fullTrack) {
    if (state.obsTrackLayer) { map.removeLayer(state.obsTrackLayer); state.obsTrackLayer = null; }
    if (!fullTrack || fullTrack.length < 2) return;
    const lls = fullTrack.map(p => [p.lat, p.lon]);
    state.obsTrackLayer = L.polyline(lls, {
        color: '#888', weight: 2, opacity: 0.6, dashArray: '4,6',
    }).addTo(map);
}

function drawForecastPath(forecastSteps) {
    if (state.pathLayer) { map.removeLayer(state.pathLayer); state.pathLayer = null; }
    if (!forecastSteps || forecastSteps.length === 0) return;
    const lls = forecastSteps.map(s => [s.lat, s.lon]);
    state.pathLayer = L.polyline(lls, {
        color: '#00ffff', weight: 2, opacity: 0.85, dashArray: '5,8',
    }).addTo(map);

    // Circle marker every 24 h (every 8 steps)
    forecastSteps.forEach((s, i) => {
        if ((i + 1) % 8 !== 0) return;
        const cat = getCategory(s.wind_speed);
        L.circleMarker([s.lat, s.lon], {
            radius: 5, color: cat.color, fillColor: cat.color, fillOpacity: 0.85, weight: 1,
        }).bindTooltip(`+${s.hour}h | ${s.wind_speed.toFixed(0)} kt`, {
            direction: 'top', offset: [0, -6],
        }).addTo(map);
    });
}

function updateStormMarker(step) {
    const cat = getCategory(step.wind_speed);
    if (state.stormMarker) {
        state.stormMarker.setLatLng([step.lat, step.lon]);
        state.stormMarker.setIcon(makePulseIcon(cat.color));
    } else {
        state.stormMarker = L.marker([step.lat, step.lon], {
            icon: makePulseIcon(cat.color), zIndexOffset: 1000,
        }).addTo(map);
    }
}

// ── Info panel ─────────────────────────────────────────────────────────────
function updateStormPanel(step) {
    const cat = getCategory(step.wind_speed);
    const badge = document.getElementById('storm-category-badge');
    badge.textContent  = cat.label;
    badge.style.background = cat.color;
    badge.style.color  = (cat.color === '#e1e100' || cat.color === '#64ee64') ? '#111' : '#fff';
    document.getElementById('storm-name-display').textContent = state.forecast.storm_name || 'UNNAMED';
    document.getElementById('stat-time').textContent     = `+${step.hour} h`;
    document.getElementById('stat-position').textContent = `${step.lat.toFixed(2)}°N  ${step.lon.toFixed(2)}°E`;
    document.getElementById('stat-pressure').textContent = `${step.pressure.toFixed(0)} hPa`;
    document.getElementById('stat-wind').textContent     = `${step.wind_speed.toFixed(0)} kt`;
    const method = step.method || state.forecast.method || 'physics';
    document.getElementById('stat-method').textContent   = method === 'ml' ? 'LSTM + RF (ML)' : 'Physics engine';
}

function updateMethodTag(method) {
    const tag = document.getElementById('topbar-method-tag');
    tag.textContent = method === 'ml' ? 'LSTM + RF' : 'PHYSICS ENGINE';
    tag.style.background = method === 'ml' ? 'rgba(0,180,100,0.2)' : 'rgba(0,160,255,0.15)';
    tag.style.borderColor = method === 'ml' ? 'rgba(0,180,100,0.4)' : 'rgba(0,200,255,0.3)';
    tag.style.color       = method === 'ml' ? '#40ff90' : '#00e5ff';
}

// ── Timeline ───────────────────────────────────────────────────────────────
function buildTicks(totalSteps) {
    const container = document.getElementById('tl-ticks');
    container.innerHTML = '';
    for (let i = 0; i <= totalSteps; i += 8) {
        const tick = document.createElement('span');
        tick.className  = 'tl-tick';
        tick.style.left = `${(i / (totalSteps - 1)) * 100}%`;
        tick.textContent = `${i * 3}h`;
        container.appendChild(tick);
    }
}

function goToStep(idx) {
    if (!state.forecast) return;
    const steps = state.forecast.forecast_steps;
    idx = Math.max(0, Math.min(idx, steps.length - 1));
    state.currentStep = idx;
    const step = steps[idx];
    updateStormMarker(step);
    updateStormPanel(step);
    document.getElementById('tl-hour-value').textContent = `+${step.hour} h`;
    document.getElementById('timeline-slider').value = idx;
    windEngine.setGrid({ u: step.u, v: step.v });
    if (!windEngine.active) windEngine.start();
}

// ── Playback ───────────────────────────────────────────────────────────────
function togglePlay() {
    state.isPlaying = !state.isPlaying;
    const btn = document.getElementById('btn-play');
    if (state.isPlaying) {
        btn.textContent = '⏸';
        state.playTimer = setInterval(() => {
            const next = state.currentStep + 1;
            goToStep(next >= state.forecast.forecast_steps.length ? 0 : next);
        }, PLAY_INTERVAL);
    } else {
        btn.textContent = '▶';
        clearInterval(state.playTimer);
        state.playTimer = null;
    }
}

function stopPlayback() {
    if (!state.isPlaying) return;
    state.isPlaying = false;
    document.getElementById('btn-play').textContent = '▶';
    clearInterval(state.playTimer);
    state.playTimer = null;
}

// ── Called when API responds ───────────────────────────────────────────────
function onForecastLoaded(data) {
    state.forecast     = data;
    state.currentStep  = 0;

    document.getElementById('input-panel').classList.add('hidden');
    document.getElementById('storm-panel').classList.remove('hidden');
    document.getElementById('timeline-bar').classList.remove('hidden');
    document.getElementById('par-label').classList.remove('hidden');

    updateMethodTag(data.method || 'physics');
    drawObservedTrack(data.full_observed_track || []);
    drawForecastPath(data.forecast_steps);
    buildTicks(data.forecast_steps.length);
    goToStep(0);

    // Fit map to the full track + forecast extent
    const allLLs = [
        ...(data.full_observed_track || []).map(p => [p.lat, p.lon]),
        ...data.forecast_steps.map(s => [s.lat, s.lon]),
    ];
    if (allLLs.length > 0) map.fitBounds(L.latLngBounds(allLLs).pad(0.1));
}

// ── Reset ──────────────────────────────────────────────────────────────────
function resetToInput() {
    stopPlayback();
    windEngine.stop();
    ['stormMarker', 'pathLayer', 'obsTrackLayer', 'trackLayer'].forEach(k => {
        if (state[k]) { map.removeLayer(state[k]); state[k] = null; }
    });
    state.forecast = null;
    document.getElementById('storm-panel').classList.add('hidden');
    document.getElementById('timeline-bar').classList.add('hidden');
    document.getElementById('par-label').classList.add('hidden');
    document.getElementById('input-panel').classList.remove('hidden');
    document.getElementById('inp-error').classList.add('hidden');
    map.setView([12.5, 122.0], 5);
}

// ── Shared request helpers ─────────────────────────────────────────────────
function setLoading(on) {
    document.getElementById('inp-loading').classList.toggle('hidden', !on);
    // Only clear the error banner when a NEW request is starting, not when stopping
    if (on) document.getElementById('inp-error').classList.add('hidden');
    document.getElementById('btn-run-historical').disabled = on;
    document.getElementById('btn-run-manual').disabled = on;
}

function showError(msg) {
    // Stop spinner + re-enable buttons first, then show error (order matters)
    document.getElementById('inp-loading').classList.add('hidden');
    document.getElementById('btn-run-historical').disabled = false;
    document.getElementById('btn-run-manual').disabled = false;
    const el = document.getElementById('inp-error');
    el.textContent = msg;
    el.classList.remove('hidden');
    console.error('[Forecast]', msg);
}

// ── API: load storm list ───────────────────────────────────────────────────
async function loadStormList() {
    const year = parseInt(document.getElementById('inp-year').value, 10);
    if (!year || year < 2013 || year > 2030) { showError('Enter a valid year (2013–2026)'); return; }

    const select = document.getElementById('inp-storm-select');
    const runBtn = document.getElementById('btn-run-historical');
    select.disabled = true;
    runBtn.disabled = true;
    select.innerHTML = '<option>Loading…</option>';

    try {
        const resp = await fetch(`${API_BASE}/api/storms/list?year=${year}`);
        const data = await resp.json();
        if (!resp.ok) { showError(data.error || `HTTP ${resp.status}`); return; }

        select.innerHTML = '<option value="">— Select a storm —</option>';
        data.storms.forEach(s => {
            const opt = document.createElement('option');
            opt.value       = s.name;
            opt.textContent = `${s.name}  (${s.points} obs)`;
            select.appendChild(opt);
        });
        select.disabled = false;
        document.getElementById('inp-error').classList.add('hidden');
    } catch (err) {
        showError(`Could not load storms: ${err.message}`);
    }
}

// ── API: forecast from IBTrACS storm ──────────────────────────────────────
async function runHistoricalForecast() {
    const year    = parseInt(document.getElementById('inp-year').value, 10);
    const name    = document.getElementById('inp-storm-select').value;
    const histHrs = parseInt(document.getElementById('inp-history-hrs').value, 10);

    if (!name) { showError('Please select a storm first.'); return; }

    console.log('[Forecast] Historical request →', { year, storm_name: name, history_hours: histHrs });
    setLoading(true);
    try {
        const resp = await fetch(`${API_BASE}/api/forecast/from-storm`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ year, storm_name: name, history_hours: histHrs }),
        });
        const data = await resp.json();
        console.log('[Forecast] Response status:', resp.status, '| method:', data.method, '| steps:', data.forecast_steps?.length);
        if (!resp.ok) { showError(data.error || `HTTP ${resp.status}`); return; }
        setLoading(false);
        onForecastLoaded(data);
    } catch (err) {
        showError(`Request failed: ${err.message}`);
    }
}

// ── API: forecast from manual JSON ────────────────────────────────────────
async function runManualForecast() {
    const rawText = document.getElementById('inp-track-json').value.trim();
    const name    = document.getElementById('inp-storm-name').value.trim() || 'UNNAMED';

    let history;
    try {
        const parsed = JSON.parse(rawText);
        if (!Array.isArray(parsed) || parsed.length < 2)
            throw new Error('Must be a JSON array with at least 2 points.');
        history = parsed.map((p, i) => {
            ['lat','lon','pressure','wind_speed'].forEach(k => {
                if (p[k] == null || isNaN(parseFloat(p[k])))
                    throw new Error(`Point [${i}] missing or invalid "${k}".`);
            });
            return { lat: +p.lat, lon: +p.lon, pressure: +p.pressure, wind_speed: +p.wind_speed };
        });
    } catch (e) { showError(e.message); return; }

    console.log('[Forecast] Manual request →', name, `(${history.length} pts)`);
    setLoading(true);
    try {
        const resp = await fetch(`${API_BASE}/api/forecast`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ storm_name: name, track_history: history }),
        });
        const data = await resp.json();
        console.log('[Forecast] Response status:', resp.status, '| method:', data.method, '| steps:', data.forecast_steps?.length);
        if (!resp.ok) { showError(data.error || `HTTP ${resp.status}`); return; }
        setLoading(false);
        onForecastLoaded(data);
    } catch (err) {
        showError(`Request failed: ${err.message}`);
    }
}

// ── Tab switching ──────────────────────────────────────────────────────────
function initTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
            btn.classList.add('active');
            document.getElementById(`tab-${btn.dataset.tab}`).classList.remove('hidden');
        });
    });
}

// ── Storm dropdown enables Run button ─────────────────────────────────────
function initStormSelectWatcher() {
    document.getElementById('inp-storm-select').addEventListener('change', function () {
        document.getElementById('btn-run-historical').disabled = !this.value;
    });
}

// ── Event wiring ───────────────────────────────────────────────────────────
function wireEvents() {
    document.getElementById('btn-load-storms').addEventListener('click', loadStormList);
    document.getElementById('btn-run-historical').addEventListener('click', runHistoricalForecast);
    document.getElementById('btn-run-manual').addEventListener('click', runManualForecast);
    document.getElementById('btn-load-sample').addEventListener('click', () => {
        document.getElementById('inp-storm-name').value  = 'EWINIAR';
        document.getElementById('inp-track-json').value  = JSON.stringify(SAMPLE_HISTORY, null, 2);
        document.getElementById('inp-error').classList.add('hidden');
    });
    document.getElementById('btn-new-forecast').addEventListener('click', resetToInput);
    document.getElementById('btn-play').addEventListener('click', togglePlay);
    document.getElementById('timeline-slider').addEventListener('input', function () {
        stopPlayback();
        goToStep(parseInt(this.value, 10));
    });
    document.addEventListener('keydown', e => {
        if (!state.forecast) return;
        if (e.key === 'ArrowRight') { stopPlayback(); goToStep(state.currentStep + 1); }
        if (e.key === 'ArrowLeft')  { stopPlayback(); goToStep(state.currentStep - 1); }
        if (e.key === ' ')          { e.preventDefault(); togglePlay(); }
    });
}

// ── Bootstrap ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    try {
        initMap();
        initWindCanvas();
        initTabs();
        initStormSelectWatcher();
        wireEvents();
        console.log('[Forecast] Initialised OK');
    } catch (err) {
        console.error('[Forecast] Init error:', err);
        // Show a visible error so the user knows what went wrong
        const errEl = document.getElementById('inp-error');
        if (errEl) {
            errEl.textContent = 'Page failed to initialise: ' + err.message +
                '. Open browser console (F12) for details.';
            errEl.classList.remove('hidden');
        }
    }
});
