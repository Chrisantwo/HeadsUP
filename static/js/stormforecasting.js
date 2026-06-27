// Lightweight Storm Forecasting Web App - optimized to prevent crashes.

const API_BASE = "";
const BASIN_BOUNDARIES = {
    western_pacific: [100, 180, 0, 60],
    par: [115, 135, 5, 25]
};
const PH_ZOOM_CENTER = { lat: 12.5, lon: 122.5 };
const PH_ZOOM_LON_SPAN = 38;
const CATEGORY_COLORS = {
    0: [135, 206, 235],
    1: [100, 238, 100],
    2: [225, 225, 0],
    3: [255, 130, 0],
    4: [255, 0, 0],
    5: [255, 0, 255]
};
const PLAYBACK_SECONDS_PER_HOUR = 0.15;
const MAX_PATH_POINTS = 120;
const WEATHER_SAMPLE_STEP = 7;
const WIND_PARTICLE_COUNT = 420;
const WIND_PARTICLE_FADE = 0.62;
const PREDICTION_HOURS = 120;
const PREDICTION_STEP_HOURS = 6;
const CONE_BASE_RADIUS_PX = 10;
const CONE_MAX_RADIUS_PX = 74;

const state = {
    mapImage: new Image(),
    currentZoom: "full",
    allTyphoons: [],
    activeStorm: null,
    playheadSec: 0,
    isPlaying: false,
    showHeat: true,
    showWind: true,
    showPrediction: true,
    realtimeHeatEnabled: false,
    realtimeWindEnabled: false,
    realtimePreset: "temperature",
    weatherGrid: null,
    weatherGridLoading: false,
    weatherGridFetchedAt: 0,
    lastGridRefreshCheck: 0,
    forecastHour: 0,
    fixedRealtimeCandidates: null,
    windParticles: [],
    rafId: null,
    lastTs: 0,
    fpsCounterTs: 0,
    fpsFrames: 0,
    currentFps: 0
};

let canvas;
let ctx;
let appRoot;
let yearInput;
let submitBtn;
let stormSelect;
let zoomBtn;
let heatToggle;
let windToggle;
let predictionToggleBtn;
let layerHeatBtn;
let layerWindBtn;
let layerOffBtn;
let realtimeForecastBtn;
let forecastNowBtn;
let forecast3hBtn;
let forecast6hBtn;
let forecast12hBtn;
let playPauseBtn;
let skipBtn;
let backBtn;
let timelineSlider;
let loadingMessage;
let errorMessage;
let timeDisplay;
let fpsDisplay;
let weatherLatLon;
let weatherCurrent;
let weatherHourly;
let overlayScale;
let scaleModelPrimary;
let scaleLabel;
let scaleBar;
let scaleTicks;
let layerMenu;
let layerMenuButtons = [];

function parsePathTime(timeStr) {
    if (!timeStr || typeof timeStr !== "string") return NaN;
    const parts = timeStr.split(" ");
    const datePart = parts[0];
    const clockPart = parts[1] || "00:00";
    const dateBits = datePart.split("-").map(Number);
    const timeBits = clockPart.split(":").map(Number);
    if (dateBits.length !== 3 || isNaN(dateBits[0]) || isNaN(dateBits[1]) || isNaN(dateBits[2])) return NaN;
    return new Date(dateBits[0], dateBits[1] - 1, dateBits[2], timeBits[0] || 0, timeBits[1] || 0).getTime();
}

function numOrDefault(v, d) {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
}

function showError(message) {
    if (!errorMessage) return;
    errorMessage.textContent = message || "An error occurred.";
    errorMessage.classList.remove("hidden");
}

function clearError() {
    if (!errorMessage) return;
    errorMessage.classList.add("hidden");
    errorMessage.textContent = "";
}

function setLoading(loading, text) {
    if (!loadingMessage) return;
    if (loading) {
        loadingMessage.textContent = text || "Loading typhoon data...";
        loadingMessage.classList.remove("hidden");
    } else {
        loadingMessage.classList.add("hidden");
    }
}

function resizeCanvas() {
    const width = Math.max(1, window.innerWidth || 800);
    const height = Math.max(1, window.innerHeight || 600);
    canvas.width = width;
    canvas.height = height;
    if (state.realtimeWindEnabled) reseedWindParticles();
}

function getViewBounds() {
    const full = BASIN_BOUNDARIES.western_pacific;
    if (state.currentZoom !== "par") {
        return { minLon: full[0], maxLon: full[1], minLat: full[2], maxLat: full[3] };
    }

    const aspect = Math.max(0.6, canvas.width / Math.max(1, canvas.height));
    const lonSpan = PH_ZOOM_LON_SPAN;
    const latSpan = Math.max(12, Math.min(26, lonSpan / aspect));
    let minLon = PH_ZOOM_CENTER.lon - lonSpan / 2;
    let maxLon = PH_ZOOM_CENTER.lon + lonSpan / 2;
    let minLat = PH_ZOOM_CENTER.lat - latSpan / 2;
    let maxLat = PH_ZOOM_CENTER.lat + latSpan / 2;

    if (minLon < full[0]) {
        maxLon += (full[0] - minLon);
        minLon = full[0];
    }
    if (maxLon > full[1]) {
        minLon -= (maxLon - full[1]);
        maxLon = full[1];
    }
    if (minLat < full[2]) {
        maxLat += (full[2] - minLat);
        minLat = full[2];
    }
    if (maxLat > full[3]) {
        minLat -= (maxLat - full[3]);
        maxLat = full[3];
    }

    return { minLon, maxLon, minLat, maxLat };
}

function toScreen(lat, lon) {
    const view = getViewBounds();
    const x = ((lon - view.minLon) / (view.maxLon - view.minLon)) * canvas.width;
    const y = ((view.maxLat - lat) / (view.maxLat - view.minLat)) * canvas.height;
    return [x, y];
}

function toLatLon(screenX, screenY) {
    const view = getViewBounds();
    const lon = view.minLon + (screenX / canvas.width) * (view.maxLon - view.minLon);
    const lat = view.maxLat - (screenY / canvas.height) * (view.maxLat - view.minLat);
    return {
        lat: Math.max(-90, Math.min(90, lat)),
        lon: Math.max(-180, Math.min(180, lon))
    };
}

function downsamplePath(path, maxPoints) {
    if (path.length <= maxPoints) return path.slice();
    const sampled = [];
    const step = (path.length - 1) / (maxPoints - 1);
    for (let i = 0; i < maxPoints; i++) {
        sampled.push(path[Math.round(i * step)]);
    }
    return sampled;
}

function buildStormModel(raw) {
    if (!raw || !Array.isArray(raw.path) || raw.path.length < 2) return null;
    const cleaned = raw.path
        .map(p => ({
            time: p.time,
            lat: numOrDefault(p.lat, NaN),
            long: numOrDefault(p.long, NaN),
            speed: numOrDefault(p.speed, 0),
            class: numOrDefault(p.class, 0)
        }))
        .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.long) && !Number.isNaN(parsePathTime(p.time)));
    if (cleaned.length < 2) return null;
    const path = downsamplePath(cleaned, MAX_PATH_POINTS);
    const times = path.map(p => parsePathTime(p.time));
    const segDurSec = [];
    let totalDurationSec = 0;
    for (let i = 0; i < path.length - 1; i++) {
        const hours = Math.max(0, (times[i + 1] - times[i]) / (1000 * 3600));
        const sec = Math.max(0.03, hours * PLAYBACK_SECONDS_PER_HOUR);
        segDurSec.push(sec);
        totalDurationSec += sec;
    }
    const maxSpeed = path.reduce((m, p) => Math.max(m, p.speed || 0), 0);
    const maxClass = path.reduce((m, p) => Math.max(m, p.class || 0), 0);
    return {
        name: raw.name || "UNNAMED",
        path,
        times,
        segDurSec,
        totalDurationSec: Math.max(totalDurationSec, 0.1),
        maxSpeed,
        maxClass
    };
}

function chooseDefaultStorm(rawTyphoons) {
    if (!rawTyphoons.length) return null;
    const scored = rawTyphoons.map(t => {
        const path = Array.isArray(t.path) ? t.path : [];
        let maxClass = 0;
        let maxSpeed = 0;
        for (let i = 0; i < path.length; i++) {
            maxClass = Math.max(maxClass, numOrDefault(path[i].class, 0));
            maxSpeed = Math.max(maxSpeed, numOrDefault(path[i].speed, 0));
        }
        return { t, score: maxClass * 1000 + maxSpeed };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored[0].t;
}

function getPose(storm, sec) {
    let remain = Math.max(0, sec);
    for (let i = 0; i < storm.segDurSec.length; i++) {
        const seg = storm.segDurSec[i];
        if (remain <= seg) {
            const t = seg > 0 ? remain / seg : 0;
            const p1 = storm.path[i];
            const p2 = storm.path[i + 1];
            return {
                index: i,
                point: {
                    lat: p1.lat + (p2.lat - p1.lat) * t,
                    long: p1.long + (p2.long - p1.long) * t
                },
                class: p2.class,
                speed: p2.speed,
                timeMs: storm.times[i] + (storm.times[i + 1] - storm.times[i]) * t
            };
        }
        remain -= seg;
    }
    const last = storm.path[storm.path.length - 1];
    return {
        index: storm.path.length - 1,
        point: { lat: last.lat, long: last.long },
        class: last.class,
        speed: last.speed,
        timeMs: storm.times[storm.times.length - 1]
    };
}

function drawMap() {
    ctx.fillStyle = "#004466";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const img = state.mapImage;
    if (!img.complete || img.naturalWidth <= 0 || img.naturalHeight <= 0) return;
    const full = BASIN_BOUNDARIES.western_pacific;
    const view = getViewBounds();
    const lonRange = full[1] - full[0];
    const latRange = full[3] - full[2];
    const sx = ((view.minLon - full[0]) / lonRange) * img.naturalWidth;
    const sy = ((full[3] - view.maxLat) / latRange) * img.naturalHeight;
    const sw = ((view.maxLon - view.minLon) / lonRange) * img.naturalWidth;
    const sh = ((view.maxLat - view.minLat) / latRange) * img.naturalHeight;
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
}

function interpolateColor(stops, t) {
    const clamped = Math.max(0, Math.min(1, t));
    for (let i = 1; i < stops.length; i++) {
        if (clamped <= stops[i][0]) {
            const [t0, c0] = stops[i - 1];
            const [t1, c1] = stops[i];
            const span = Math.max(0.0001, t1 - t0);
            const r = (clamped - t0) / span;
            return [
                Math.round(c0[0] + (c1[0] - c0[0]) * r),
                Math.round(c0[1] + (c1[1] - c0[1]) * r),
                Math.round(c0[2] + (c1[2] - c0[2]) * r)
            ];
        }
    }
    return stops[stops.length - 1][1];
}

function getTempColor(temp) {
    // Windy-like warm palette for tropical temperature fields.
    const t = Math.max(14, Math.min(36, numOrDefault(temp, 26)));
    const ratio = (t - 14) / (36 - 14);
    const stops = [
        [0.0, [36, 128, 86]],
        [0.2, [57, 186, 88]],
        [0.45, [194, 190, 88]],
        [0.66, [214, 154, 92]],
        [0.85, [186, 100, 133]],
        [1.0, [152, 62, 156]]
    ];
    return interpolateColor(stops, ratio);
}

function getRainColor(rain) {
    // Rain intensity in mm: 0..20
    const r = Math.max(0, Math.min(20, numOrDefault(rain, 0)));
    const ratio = r / 20;
    const red = Math.round(255 * ratio);
    const green = Math.round(220 * (1 - ratio * 0.6));
    const blue = Math.round(120 * (1 - ratio));
    return [red, green, blue];
}

function getCloudColor(v) {
    const ratio = Math.max(0, Math.min(1, numOrDefault(v, 0) / 20));
    return [
        Math.round(140 + ratio * 90),
        Math.round(155 + ratio * 80),
        Math.round(170 + ratio * 70)
    ];
}

function getWavesColor(v) {
    const ratio = Math.max(0, Math.min(1, numOrDefault(v, 0) / 35));
    return interpolateColor([
        [0.0, [58, 132, 177]],
        [0.5, [67, 109, 199]],
        [1.0, [118, 87, 206]]
    ], ratio);
}

function getThunderColor(v) {
    const ratio = Math.max(0, Math.min(1, numOrDefault(v, 0) / 20));
    return interpolateColor([
        [0.0, [119, 203, 79]],
        [0.4, [224, 202, 70]],
        [0.75, [232, 113, 64]],
        [1.0, [173, 44, 135]]
    ], ratio);
}

function getPresetHeatAlpha() {
    switch (state.realtimePreset) {
        case "satellite":
        case "clouds":
            return 0.28;
        case "weather-radar":
        case "rain-thunder":
        case "rain-accumulation":
        case "thunderstorms":
            return 0.34;
        case "waves":
            return 0.30;
        default:
            return 0.36;
    }
}

function setOverlayScale(label, primaryModel, stops) {
    if (!overlayScale || !scaleLabel || !scaleBar || !scaleTicks || !scaleModelPrimary) return;
    scaleLabel.textContent = label;
    scaleModelPrimary.textContent = primaryModel;
    const gradient = stops.map(s => `${s.color} ${s.pos}%`).join(", ");
    scaleBar.style.background = `linear-gradient(90deg, ${gradient})`;
    scaleTicks.innerHTML = stops.map(s => `<span>${s.tick}</span>`).join("");
}

function updateOverlayScale() {
    if (!overlayScale) return;
    if (!hasRealtimeLayer()) {
        overlayScale.classList.add("hidden");
        return;
    }
    overlayScale.classList.remove("hidden");

    if (state.realtimeWindEnabled && !state.realtimeHeatEnabled) {
        setOverlayScale("WIND SPEED (KM/H)", "Open-Meteo", [
            { pos: 0, color: "#213f6f", tick: "0" },
            { pos: 30, color: "#2f79b6", tick: "20" },
            { pos: 60, color: "#6ec7ff", tick: "40" },
            { pos: 80, color: "#e7f8ff", tick: "60" },
            { pos: 100, color: "#ffffff", tick: "80+" }
        ]);
        return;
    }

    switch (state.realtimePreset) {
        case "rain-thunder":
        case "rain-accumulation":
        case "weather-radar":
        case "thunderstorms":
            setOverlayScale("PRECIPITATION (MM/H)", "Open-Meteo", [
                { pos: 0, color: "#5bc84e", tick: "0" },
                { pos: 30, color: "#d6d14b", tick: "5" },
                { pos: 55, color: "#e89a42", tick: "10" },
                { pos: 80, color: "#d75d4f", tick: "20" },
                { pos: 100, color: "#ad2f86", tick: "35+" }
            ]);
            break;
        case "clouds":
        case "satellite":
            setOverlayScale("CLOUD COVER (%)", "Open-Meteo", [
                { pos: 0, color: "#44596f", tick: "0" },
                { pos: 35, color: "#65829f", tick: "25" },
                { pos: 70, color: "#a2b7cd", tick: "60" },
                { pos: 100, color: "#dbe8f4", tick: "100" }
            ]);
            break;
        case "waves":
            setOverlayScale("WAVE POTENTIAL", "Open-Meteo", [
                { pos: 0, color: "#3f8fbf", tick: "Low" },
                { pos: 35, color: "#3d77c8", tick: "Moderate" },
                { pos: 70, color: "#675ec8", tick: "High" },
                { pos: 100, color: "#8b58c8", tick: "Extreme" }
            ]);
            break;
        default:
            setOverlayScale("TEMPERATURE (°C)", "Open-Meteo", [
                { pos: 0, color: "#248456", tick: "14" },
                { pos: 28, color: "#59ba58", tick: "20" },
                { pos: 52, color: "#d0bf57", tick: "26" },
                { pos: 76, color: "#d88761", tick: "31" },
                { pos: 100, color: "#95429e", tick: "36" }
            ]);
    }
}

function gridPoint(grid, xi, yi) {
    const nx = grid.nx || 0;
    const idx = yi * nx + xi;
    return grid.points[idx] || null;
}

function bilinearSample(grid, lat, lon, key) {
    if (!grid || !grid.bounds || !grid.nx || !grid.ny) return null;
    const b = grid.bounds;
    const nx = grid.nx, ny = grid.ny;
    const u = (lon - b.min_lon) / (b.max_lon - b.min_lon);
    const v = (lat - b.min_lat) / (b.max_lat - b.min_lat);
    const gx = Math.max(0, Math.min(nx - 1.0001, u * (nx - 1)));
    const gy = Math.max(0, Math.min(ny - 1.0001, v * (ny - 1)));
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const x1 = Math.min(nx - 1, x0 + 1), y1 = Math.min(ny - 1, y0 + 1);
    const tx = gx - x0, ty = gy - y0;
    const p00 = gridPoint(grid, x0, y0), p10 = gridPoint(grid, x1, y0);
    const p01 = gridPoint(grid, x0, y1), p11 = gridPoint(grid, x1, y1);
    if (!p00 || !p10 || !p01 || !p11) return null;
    const q00 = numOrDefault(p00[key], NaN), q10 = numOrDefault(p10[key], NaN);
    const q01 = numOrDefault(p01[key], NaN), q11 = numOrDefault(p11[key], NaN);
    if (!Number.isFinite(q00) || !Number.isFinite(q10) || !Number.isFinite(q01) || !Number.isFinite(q11)) return null;
    const a = q00 * (1 - tx) + q10 * tx;
    const b2 = q01 * (1 - tx) + q11 * tx;
    return a * (1 - ty) + b2 * ty;
}

function computeUpcomingCandidates(grid) {
    if (!grid || !Array.isArray(grid.points)) return [];
    const raw = [];
    for (let i = 0; i < grid.points.length; i++) {
        const p = grid.points[i];
        if (!p) continue;
        const rain = Math.max(0, numOrDefault(p.rain, 0));
        const wind = Math.max(0, numOrDefault(p.wind_speed, 0));
        const temp = numOrDefault(p.temp, 27);
        const score = rain * 1.8 + Math.max(0, wind - 18) * 0.95 + Math.max(0, temp - 27) * 0.3;
        if (score < 12) continue;
        raw.push({ lat: p.lat, lon: p.lon, wind, windDir: numOrDefault(p.wind_dir, 0), score });
    }
    raw.sort((a, b) => b.score - a.score);

    // Keep only separated hotspots so one cluster does not produce many markers.
    const picked = [];
    for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        let near = false;
        for (let j = 0; j < picked.length; j++) {
            const dLat = c.lat - picked[j].lat;
            const dLon = c.lon - picked[j].lon;
            if ((dLat * dLat + dLon * dLon) < (3.2 * 3.2)) {
                near = true;
                break;
            }
        }
        if (!near) picked.push(c);
        if (picked.length >= 3) break;
    }
    return picked;
}

function getStableRealtimeCandidates() {
    if (state.activeStorm) return [];
    if (state.fixedRealtimeCandidates !== null) return state.fixedRealtimeCandidates;
    if (!state.weatherGrid || !Array.isArray(state.weatherGrid.points) || state.weatherGrid.points.length === 0) return [];
    const computed = computeUpcomingCandidates(state.weatherGrid);
    // Lock first predictive output for this realtime session.
    state.fixedRealtimeCandidates = computed.map(c => ({ ...c }));
    return state.fixedRealtimeCandidates;
}

function projectByHours(lat, lon, windSpeed, windDir, hours) {
    let nLat = lat;
    let nLon = lon;
    const h = Math.max(0, numOrDefault(hours, 0));
    if (h <= 0) return { lat: nLat, lon: nLon };
    const toDeg = (numOrDefault(windDir, 0) + 180) % 360;
    const rad = toDeg * (Math.PI / 180);
    const distanceKm = Math.max(10, numOrDefault(windSpeed, 0) * h);
    const dLat = (Math.cos(rad) * distanceKm) / 111;
    const lonDiv = Math.max(20, 111 * Math.cos(nLat * (Math.PI / 180)));
    const dLon = (Math.sin(rad) * distanceKm) / lonDiv;
    nLat += dLat;
    nLon += dLon;
    nLat = Math.max(-89.9, Math.min(89.9, nLat));
    nLon = Math.max(-179.9, Math.min(179.9, nLon));
    return { lat: nLat, lon: nLon };
}

function drawRealtimeCandidateForecast(ts) {
    if (!state.showPrediction) return;
    if (state.activeStorm) return;
    if (!hasRealtimeLayer()) return;
    const cands = getStableRealtimeCandidates();
    if (!cands.length) return;

    for (let i = 0; i < cands.length; i++) {
        const c = cands[i];
        const shifted = projectByHours(c.lat, c.lon, c.wind, c.windDir, state.forecastHour);
        const start = toScreen(shifted.lat, shifted.lon);
        const conf = Math.max(35, Math.min(92, Math.round(32 + c.score * 2.2)));
        const rankColor = i === 0 ? "rgba(255, 184, 88, 0.95)" : "rgba(255, 226, 120, 0.92)";

        // Marker
        ctx.save();
        ctx.fillStyle = rankColor;
        ctx.beginPath();
        ctx.arc(start[0], start[1], 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(0,0,0,0.55)";
        ctx.lineWidth = 1.2;
        ctx.stroke();

        // Forecast drift line (next 48h)
        const proj = [{ lat: shifted.lat, lon: shifted.lon }];
        let lat = shifted.lat;
        let lon = shifted.lon;
        let spd = c.wind;
        for (let h = 12; h <= 48; h += 12) {
            spd *= 0.96;
            const toDeg = (c.windDir + 180) % 360;
            const rad = toDeg * (Math.PI / 180);
            const distanceKm = Math.max(20, spd * 12); // approx km over 12h
            const dLat = (Math.cos(rad) * distanceKm) / 111;
            const lonDiv = Math.max(20, 111 * Math.cos(lat * (Math.PI / 180)));
            const dLon = (Math.sin(rad) * distanceKm) / lonDiv;
            lat += dLat;
            lon += dLon;
            proj.push({ lat, lon });
        }

        ctx.setLineDash([5, 6]);
        ctx.strokeStyle = "rgba(255, 230, 150, 0.9)";
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        const p0 = toScreen(proj[0].lat, proj[0].lon);
        ctx.moveTo(p0[0], p0[1]);
        for (let k = 1; k < proj.length; k++) {
            const pk = toScreen(proj[k].lat, proj[k].lon);
            ctx.lineTo(pk[0], pk[1]);
        }
        ctx.stroke();
        ctx.setLineDash([]);

        const phase = ((ts + i * 1700) % 10000) / 10000;
        const moving = sampleProjectedPoint(proj, phase);
        if (moving) {
            const mxy = toScreen(moving.lat, moving.lon);
            ctx.fillStyle = "rgba(255, 234, 146, 0.95)";
            ctx.strokeStyle = "rgba(0,0,0,0.62)";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(mxy[0], mxy[1], 4.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }

        // Confidence label
        ctx.fillStyle = "#fff";
        ctx.font = "bold 10px Arial";
        ctx.textAlign = "left";
        ctx.strokeStyle = "rgba(0,0,0,0.75)";
        ctx.lineWidth = 2.6;
        const label = `Potential TD ${conf}% (+${state.forecastHour}H)`;
        ctx.strokeText(label, start[0] + 8, start[1] - 8 + Math.sin(ts * 0.003 + i) * 2);
        ctx.fillText(label, start[0] + 8, start[1] - 8 + Math.sin(ts * 0.003 + i) * 2);
        ctx.restore();
    }
}

function reseedWindParticles() {
    state.windParticles = [];
    for (let i = 0; i < WIND_PARTICLE_COUNT; i++) {
        state.windParticles.push({
            x: Math.random() * canvas.width,
            y: Math.random() * canvas.height,
            life: Math.random()
        });
    }
}

function hasRealtimeLayer() {
    return !!(state.realtimeHeatEnabled || state.realtimeWindEnabled);
}

function realtimeLayerLabel() {
    if (state.realtimeHeatEnabled && state.realtimeWindEnabled) return "HEAT+WIND";
    if (state.realtimeHeatEnabled) return "HEAT";
    if (state.realtimeWindEnabled) return "WIND";
    return "OFF";
}

function currentHeatFieldKey() {
    const preset = state.realtimePreset;
    if (preset === "temperature" || preset === "satellite" || preset === "hurricane-tracker") return "temp";
    if (preset === "waves") return "wind_speed";
    return "rain";
}

function getHeatFieldColor(fieldKey, value, preset) {
    if (preset === "clouds" || preset === "satellite") return getCloudColor(value);
    if (preset === "waves") return getWavesColor(value);
    if (preset === "thunderstorms" || preset === "rain-thunder") return getThunderColor(value);
    if (preset === "rain-accumulation" || preset === "weather-radar") return getRainColor(value);
    if (fieldKey === "temp") return getTempColor(value);
    return getRainColor(value);
}

function syncRealtimeLayerButtons() {
    if (layerHeatBtn) layerHeatBtn.classList.toggle("active", state.realtimeHeatEnabled);
    if (layerWindBtn) layerWindBtn.classList.toggle("active", state.realtimeWindEnabled);
    if (layerOffBtn) layerOffBtn.classList.toggle("active", !hasRealtimeLayer());
}

function syncLayerMenuButtons() {
    for (let i = 0; i < layerMenuButtons.length; i++) {
        const btn = layerMenuButtons[i];
        btn.classList.toggle("active", btn.dataset.layer === state.realtimePreset);
    }
}

function applyLayerPreset(layerId) {
    state.realtimePreset = layerId;
    if (layerId === "wind") {
        state.realtimeHeatEnabled = false;
        state.realtimeWindEnabled = true;
        reseedWindParticles();
    } else if (layerId === "temperature") {
        state.realtimeHeatEnabled = true;
        state.realtimeWindEnabled = false;
    } else if (layerId === "hurricane-tracker") {
        state.realtimeHeatEnabled = false;
        state.realtimeWindEnabled = false;
        state.windParticles = [];
        syncRealtimeLayerButtons();
        syncLayerMenuButtons();
        formatWeatherPanel();
        return;
    } else {
        state.realtimeHeatEnabled = true;
        state.realtimeWindEnabled = (layerId === "weather-radar" || layerId === "rain-thunder" || layerId === "thunderstorms" || layerId === "waves");
        if (state.realtimeWindEnabled) reseedWindParticles();
    }
    syncRealtimeLayerButtons();
    syncLayerMenuButtons();
    fetchWeatherGrid(true);
    formatWeatherPanel();
}

function drawWeatherGridLayer() {
    const grid = state.weatherGrid;
    if (!grid || !Array.isArray(grid.points) || grid.points.length === 0) return;
    if (!hasRealtimeLayer()) return;
    const nx = grid.nx || 0;
    const ny = grid.ny || 0;
    if (!nx || !ny) return;

    if (state.realtimeHeatEnabled) {
        // Windy-like smooth color field by sampling many small tiles and bilinear interpolation.
        const step = WEATHER_SAMPLE_STEP;
        ctx.save();
        ctx.globalAlpha = getPresetHeatAlpha();
        ctx.globalCompositeOperation = "source-over";
        for (let y = 0; y < canvas.height; y += step) {
            for (let x = 0; x < canvas.width; x += step) {
                const ll = toLatLon(x + step * 0.5, y + step * 0.5);
                const heatKey = currentHeatFieldKey();
                const value = bilinearSample(grid, ll.lat, ll.lon, heatKey);
                if (!Number.isFinite(value)) continue;
                const col = getHeatFieldColor(heatKey, value, state.realtimePreset);
                ctx.fillStyle = `rgb(${col[0]}, ${col[1]}, ${col[2]})`;
                // Keep map details visible by avoiding overdraw beyond each sample tile.
                ctx.fillRect(x, y, step, step);
            }
        }
        ctx.restore();
    }

    if (state.realtimeWindEnabled) {
        if (!state.windParticles.length) reseedWindParticles();
        ctx.save();
        ctx.strokeStyle = `rgba(232, 248, 255, ${WIND_PARTICLE_FADE})`;
        ctx.lineWidth = 1.15;
        for (let i = 0; i < state.windParticles.length; i++) {
            const p = state.windParticles[i];
            const ll = toLatLon(p.x, p.y);
            const speed = bilinearSample(grid, ll.lat, ll.lon, "wind_speed");
            const dir = bilinearSample(grid, ll.lat, ll.lon, "wind_dir");
            if (!Number.isFinite(speed) || !Number.isFinite(dir)) {
                p.x = Math.random() * canvas.width;
                p.y = Math.random() * canvas.height;
                p.life = 0;
                continue;
            }
            const flowDir = (dir + 180) * (Math.PI / 180); // convert from "coming from" to "going to"
            const move = Math.max(0.35, Math.min(2.4, speed * 0.055));
            const trailLen = move * 2.1;
            const nx2 = p.x + Math.cos(flowDir) * trailLen;
            const ny2 = p.y + Math.sin(flowDir) * trailLen;
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(nx2, ny2);
            ctx.stroke();
            p.x += Math.cos(flowDir) * move;
            p.y += Math.sin(flowDir) * move;
            p.life += 0.01;
            if (p.x < 0 || p.x > canvas.width || p.y < 0 || p.y > canvas.height || p.life > 1.5) {
                p.x = Math.random() * canvas.width;
                p.y = Math.random() * canvas.height;
                p.life = 0;
            }
        }
        ctx.restore();
    }
}

function drawTrack(storm, pose) {
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.45)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i <= pose.index && i < storm.path.length; i++) {
        const p = storm.path[i];
        const xy = toScreen(p.lat, p.long);
        if (i === 0) ctx.moveTo(xy[0], xy[1]);
        else ctx.lineTo(xy[0], xy[1]);
    }
    const curr = toScreen(pose.point.lat, pose.point.long);
    ctx.lineTo(curr[0], curr[1]);
    ctx.stroke();
    ctx.restore();
}

function buildProjectedPath(storm, pose) {
    if (!storm || !pose || !Array.isArray(storm.path) || storm.path.length < 2) return [];
    const i0 = Math.max(0, Math.min(storm.path.length - 1, pose.index));
    const prevIdx = Math.max(0, i0 - 1);
    const prev = storm.path[prevIdx];
    const curr = pose.point;
    const prevMs = storm.times[prevIdx];
    const currMs = pose.timeMs;
    const dtHours = Math.max(0.1, (currMs - prevMs) / 3600000);
    let vLat = (curr.lat - prev.lat) / dtHours;
    let vLon = (curr.long - prev.long) / dtHours;
    if (!Number.isFinite(vLat) || !Number.isFinite(vLon)) return [];

    const projected = [];
    let lat = curr.lat;
    let lon = curr.long;
    let ts = currMs;
    for (let h = PREDICTION_STEP_HOURS; h <= PREDICTION_HOURS; h += PREDICTION_STEP_HOURS) {
        const drag = 0.992;
        vLat *= drag;
        vLon *= drag;
        lat += vLat * PREDICTION_STEP_HOURS;
        lon += vLon * PREDICTION_STEP_HOURS;
        ts += PREDICTION_STEP_HOURS * 3600000;
        lat = Math.max(-89.9, Math.min(89.9, lat));
        lon = Math.max(-179.9, Math.min(179.9, lon));
        projected.push({ lat, lon, timeMs: ts, hoursAhead: h });
    }
    return projected;
}

function sampleProjectedPoint(projected, phase) {
    if (!Array.isArray(projected) || projected.length === 0) return null;
    if (projected.length === 1) return projected[0];
    const t = Math.max(0, Math.min(0.9999, phase));
    const scaled = t * (projected.length - 1);
    const i0 = Math.floor(scaled);
    const i1 = Math.min(projected.length - 1, i0 + 1);
    const r = scaled - i0;
    const p0 = projected[i0];
    const p1 = projected[i1];
    return {
        lat: p0.lat + (p1.lat - p0.lat) * r,
        lon: p0.lon + (p1.lon - p0.lon) * r
    };
}

function drawProjectedTrack(storm, pose) {
    if (!state.showPrediction) return;
    const projected = buildProjectedPath(storm, pose);
    if (!projected.length) return;
    drawForecastCone(pose, projected);
    const start = toScreen(pose.point.lat, pose.point.long);
    ctx.save();
    ctx.setLineDash([7, 7]);
    ctx.strokeStyle = "rgba(255, 225, 120, 0.92)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(start[0], start[1]);
    for (let i = 0; i < projected.length; i++) {
        const xy = toScreen(projected[i].lat, projected[i].lon);
        ctx.lineTo(xy[0], xy[1]);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    for (let i = 0; i < projected.length; i++) {
        const p = projected[i];
        if (p.hoursAhead % 24 !== 0) continue;
        const xy = toScreen(p.lat, p.lon);
        ctx.fillStyle = "rgba(255, 225, 120, 0.95)";
        ctx.beginPath();
        ctx.arc(xy[0], xy[1], 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.font = "bold 10px Arial";
        ctx.textAlign = "left";
        ctx.strokeStyle = "rgba(0,0,0,0.75)";
        ctx.lineWidth = 2;
        const dayLabel = `+${Math.round(p.hoursAhead / 24)}D`;
        ctx.strokeText(dayLabel, xy[0] + 6, xy[1] - 6);
        ctx.fillText(dayLabel, xy[0] + 6, xy[1] - 6);
    }

    // Animate a forecast marker moving along projected path.
    const phase = ((state.lastTs || 0) % 11000) / 11000;
    const moving = sampleProjectedPoint(projected, phase);
    if (moving) {
        const mxy = toScreen(moving.lat, moving.lon);
        ctx.fillStyle = "rgba(255, 241, 160, 0.97)";
        ctx.strokeStyle = "rgba(0,0,0,0.65)";
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.arc(mxy[0], mxy[1], 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
    }
    ctx.restore();
}

function drawForecastCone(pose, projected) {
    if (!pose || !projected.length) return;
    const points = [{ lat: pose.point.lat, lon: pose.point.long, hoursAhead: 0 }].concat(projected);
    const left = [];
    const right = [];
    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const curr = toScreen(p.lat, p.lon);
        const prev = toScreen(points[Math.max(0, i - 1)].lat, points[Math.max(0, i - 1)].lon);
        const next = toScreen(points[Math.min(points.length - 1, i + 1)].lat, points[Math.min(points.length - 1, i + 1)].lon);
        const tx = next[0] - prev[0];
        const ty = next[1] - prev[1];
        const len = Math.max(1, Math.hypot(tx, ty));
        const nx = -ty / len;
        const ny = tx / len;
        const frac = i / Math.max(1, points.length - 1);
        const rad = CONE_BASE_RADIUS_PX + frac * (CONE_MAX_RADIUS_PX - CONE_BASE_RADIUS_PX);
        left.push([curr[0] + nx * rad, curr[1] + ny * rad]);
        right.push([curr[0] - nx * rad, curr[1] - ny * rad]);
    }

    ctx.save();
    ctx.fillStyle = "rgba(255, 226, 124, 0.14)";
    ctx.strokeStyle = "rgba(255, 226, 124, 0.42)";
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(left[0][0], left[0][1]);
    for (let i = 1; i < left.length; i++) ctx.lineTo(left[i][0], left[i][1]);
    for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i][0], right[i][1]);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
}

function drawHeatOverlay(screenX, screenY, cls) {
    if (!state.showHeat) return;
    const col = CATEGORY_COLORS[cls] || [255, 180, 0];
    const radius = 80 + cls * 18;
    const grad = ctx.createRadialGradient(screenX, screenY, 8, screenX, screenY, radius);
    grad.addColorStop(0, `rgba(${col[0]},${col[1]},${col[2]},0.42)`);
    grad.addColorStop(0.5, `rgba(${col[0]},${col[1]},${col[2]},0.22)`);
    grad.addColorStop(1, `rgba(${col[0]},${col[1]},${col[2]},0.0)`);
    ctx.save();
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(screenX, screenY, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}

function drawWindOverlay(screenX, screenY, speed, frameTs) {
    if (!state.showWind) return;
    const lineCount = 24;
    const baseR = 26;
    const spread = Math.min(120, 30 + speed * 1.2);
    const spin = frameTs * 0.0013;
    ctx.save();
    ctx.strokeStyle = "rgba(165,220,255,0.33)";
    ctx.lineWidth = 1.4;
    for (let i = 0; i < lineCount; i++) {
        const a = (i / lineCount) * Math.PI * 2 + spin;
        const r1 = baseR + (i % 4) * 6;
        const r2 = r1 + spread * 0.35;
        const x1 = screenX + Math.cos(a) * r1;
        const y1 = screenY + Math.sin(a) * r1;
        const cx = screenX + Math.cos(a + 0.45) * (r1 + spread * 0.2);
        const cy = screenY + Math.sin(a + 0.45) * (r1 + spread * 0.2);
        const x2 = screenX + Math.cos(a + 0.7) * r2;
        const y2 = screenY + Math.sin(a + 0.7) * r2;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.quadraticCurveTo(cx, cy, x2, y2);
        ctx.stroke();
    }
    ctx.restore();
}

function drawStormIcon(screenX, screenY, cls, speed, name) {
    const col = CATEGORY_COLORS[cls] || [255, 255, 255];
    ctx.save();
    ctx.strokeStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
    ctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},0.22)`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(screenX, screenY, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    for (let i = 0; i < 3; i++) {
        const a = i * (Math.PI * 2 / 3);
        ctx.beginPath();
        ctx.moveTo(screenX + Math.cos(a) * 5, screenY + Math.sin(a) * 5);
        ctx.lineTo(screenX + Math.cos(a) * 20, screenY + Math.sin(a) * 20);
        ctx.stroke();
    }
    ctx.fillStyle = "#fff";
    ctx.font = "bold 12px Arial";
    ctx.textAlign = "center";
    ctx.strokeStyle = "rgba(0,0,0,0.8)";
    ctx.lineWidth = 3;
    const label = `${name}  ${Math.round(speed)} kts`;
    ctx.strokeText(label, screenX, screenY + 30);
    ctx.fillText(label, screenX, screenY + 30);
    ctx.restore();
}

function updateUiFromPlayhead(storm, pose) {
    const fraction = storm.totalDurationSec > 0 ? state.playheadSec / storm.totalDurationSec : 0;
    timelineSlider.value = String(Math.round(Math.max(0, Math.min(1, fraction)) * 100));
    const dt = new Date(pose.timeMs);
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, "0");
    const d = String(dt.getDate()).padStart(2, "0");
    const h = String(dt.getHours()).padStart(2, "0");
    const min = String(dt.getMinutes()).padStart(2, "0");
    timeDisplay.textContent = `Current Time: ${y}-${m}-${d} ${h}:${min}`;
}

function formatWeatherPanel() {
    if (!weatherLatLon || !weatherCurrent || !weatherHourly) return;
    updateOverlayScale();
    if (state.weatherGridLoading) {
        weatherLatLon.textContent = `Layer: ${realtimeLayerLabel()} | Forecast: +${state.forecastHour}H`;
        weatherCurrent.textContent = "Updating realtime grid weather...";
        weatherHourly.textContent = "Please wait...";
        return;
    }
    weatherLatLon.textContent = `Layer: ${realtimeLayerLabel()} | Forecast: +${state.forecastHour}H`;
    if (!hasRealtimeLayer()) {
        weatherCurrent.textContent = "Realtime weather layer is OFF.";
        weatherHourly.textContent = "Click REALTIME FORECAST or layer update buttons.";
        return;
    }
    if (!state.weatherGrid || !Array.isArray(state.weatherGrid.points) || state.weatherGrid.points.length === 0) {
        weatherCurrent.textContent = "No grid data loaded yet.";
        weatherHourly.textContent = "Click update button to fetch weather grid.";
        return;
    }
    weatherCurrent.textContent = `Grid points loaded: ${state.weatherGrid.points.length}. Region: ${String(state.weatherGrid.region || "unknown").toUpperCase()}.`;
    if (!state.activeStorm && state.showPrediction) {
        const cands = getStableRealtimeCandidates();
        if (cands.length) {
            weatherCurrent.textContent += ` Upcoming disturbance candidates: ${cands.length}.`;
        } else {
            weatherCurrent.textContent += " No strong disturbance candidate right now.";
        }
    }
    if (state.weatherGridFetchedAt) {
        const provider = String(state.weatherGrid.provider || "open-meteo");
        const fh = Number.isFinite(state.weatherGrid.forecast_hour) ? state.weatherGrid.forecast_hour : state.forecastHour;
        const lockText = (!state.activeStorm && state.showPrediction && state.fixedRealtimeCandidates !== null) ? " | Prediction: LOCKED" : "";
        weatherHourly.textContent = `Last update: ${new Date(state.weatherGridFetchedAt).toLocaleTimeString()} | Provider: ${provider} | Horizon: +${fh}H | Preset: ${String(state.realtimePreset).toUpperCase()}${lockText}`;
    } else {
        weatherHourly.textContent = "Last update: --";
    }
}

async function fetchWeatherGrid(force) {
    if (state.weatherGridLoading) return;
    const now = Date.now();
    if (!force && state.weatherGrid && (now - state.weatherGridFetchedAt) < 10 * 60 * 1000) return;
    state.weatherGridLoading = true;
    try {
        const region = state.currentZoom === "par" ? "par" : "full";
        const response = await fetch(`${API_BASE}/api/weather/grid?region=${encodeURIComponent(region)}&forecast_hour=${encodeURIComponent(state.forecastHour)}`);
        const data = await response.json();
        if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
        state.weatherGrid = data;
        state.weatherGridFetchedAt = now;
        if (state.realtimeWindEnabled) reseedWindParticles();
    } catch (e) {
        // Keep app stable even if provider fails.
        state.weatherGrid = null;
    } finally {
        state.weatherGridLoading = false;
        formatWeatherPanel();
    }
}

function render(ts) {
    drawMap();
    drawWeatherGridLayer();
    drawRealtimeCandidateForecast(ts);
    const storm = state.activeStorm;
    if (!storm) return;
    const pose = getPose(storm, state.playheadSec);
    const xy = toScreen(pose.point.lat, pose.point.long);
    drawTrack(storm, pose);
    drawProjectedTrack(storm, pose);
    drawHeatOverlay(xy[0], xy[1], pose.class);
    drawWindOverlay(xy[0], xy[1], pose.speed, ts);
    drawStormIcon(xy[0], xy[1], pose.class, pose.speed, storm.name);
    updateUiFromPlayhead(storm, pose);
}

function tick(ts) {
    try {
        if (!state.lastTs) state.lastTs = ts;
        const dt = Math.min(0.05, Math.max(0, (ts - state.lastTs) / 1000));
        state.lastTs = ts;
        if (state.isPlaying && state.activeStorm) {
            state.playheadSec += dt;
            if (state.playheadSec >= state.activeStorm.totalDurationSec) {
                state.playheadSec = state.activeStorm.totalDurationSec;
                state.isPlaying = false;
                playPauseBtn.textContent = "PLAY";
            }
        }
        if (hasRealtimeLayer()) {
            const nowMs = Date.now();
            if (nowMs - state.lastGridRefreshCheck > 30000) {
                state.lastGridRefreshCheck = nowMs;
                fetchWeatherGrid(false);
            }
        }
        render(ts);
        state.fpsFrames += 1;
        if (!state.fpsCounterTs) state.fpsCounterTs = ts;
        if (ts - state.fpsCounterTs >= 1000) {
            state.currentFps = state.fpsFrames;
            state.fpsFrames = 0;
            state.fpsCounterTs = ts;
            fpsDisplay.textContent = `FPS: ${state.currentFps}`;
        }
    } catch (e) {
        // Keep loop alive even on rendering errors.
    } finally {
        state.rafId = requestAnimationFrame(tick);
    }
}

function rebuildStormSelect() {
    stormSelect.innerHTML = "";
    if (!state.allTyphoons.length) {
        const option = document.createElement("option");
        option.textContent = "No storms found";
        option.value = "";
        stormSelect.appendChild(option);
        stormSelect.disabled = true;
        return;
    }
    for (let i = 0; i < state.allTyphoons.length; i++) {
        const t = state.allTyphoons[i];
        const option = document.createElement("option");
        option.value = String(i);
        option.textContent = t.name || `Storm ${i + 1}`;
        stormSelect.appendChild(option);
    }
    stormSelect.disabled = false;
}

function activateStormByIndex(index) {
    if (!state.allTyphoons.length) return;
    const raw = state.allTyphoons[Math.max(0, Math.min(index, state.allTyphoons.length - 1))];
    const model = buildStormModel(raw);
    if (!model) {
        showError("Selected storm has invalid path data.");
        return;
    }
    state.activeStorm = model;
    state.playheadSec = 0;
    state.isPlaying = true;
    playPauseBtn.textContent = "PAUSE";
    timelineSlider.value = "0";
}

async function pollForData(year) {
    const maxAttempts = 120;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const response = await fetch(`${API_BASE}/api/typhoons/status?year=${year}&month=1&day=1`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (data.status === "ready") return data;
        if (data.status === "error") throw new Error(data.error || "Server error");
        if (data.status === "not_found") throw new Error("No typhoons found for this year.");
        setLoading(true, `Loading typhoon data... (${attempt}/${maxAttempts})`);
        await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error("Timeout while loading data.");
}

async function onSubmit() {
    clearError();
    const year = parseInt(yearInput.value, 10);
    if (!Number.isFinite(year) || year < 1951) {
        showError("Please enter a valid year (1951 or later).");
        return;
    }
    if (year > new Date().getFullYear()) {
        showError("Year cannot be in the future.");
        return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Loading...";
    setLoading(true, "Loading typhoon data...");
    try {
        const response = await fetch(`${API_BASE}/api/typhoons`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ year, month: 1, day: 1 })
        });
        let data;
        if (response.status === 202) {
            data = await pollForData(year);
        } else if (response.ok) {
            data = await response.json();
            if (data.status !== "success") throw new Error(data.error || "Failed to load data");
        } else {
            throw new Error(`HTTP ${response.status}`);
        }

        state.allTyphoons = Array.isArray(data.typhoons) ? data.typhoons : [];
        state.fixedRealtimeCandidates = null;
        rebuildStormSelect();
        const defaultRaw = chooseDefaultStorm(state.allTyphoons);
        if (!defaultRaw) throw new Error("No storms found.");
        const idx = state.allTyphoons.indexOf(defaultRaw);
        stormSelect.value = String(Math.max(0, idx));
        activateStormByIndex(Math.max(0, idx));
        setLoading(false);
    } catch (e) {
        state.allTyphoons = [];
        state.activeStorm = null;
        state.fixedRealtimeCandidates = null;
        setLoading(false);
        showError(`Load failed: ${e.message}`);
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = "Load";
    }
}

function onStormSelectChange() {
    clearError();
    const idx = parseInt(stormSelect.value, 10);
    if (!Number.isFinite(idx)) return;
    activateStormByIndex(idx);
}

function onPlayPause() {
    if (!state.activeStorm) return;
    state.isPlaying = !state.isPlaying;
    playPauseBtn.textContent = state.isPlaying ? "PAUSE" : "PLAY";
}

function onSkipWeek() {
    if (!state.activeStorm) return;
    const skipSec = 7 * 24 * PLAYBACK_SECONDS_PER_HOUR;
    state.playheadSec = Math.min(state.activeStorm.totalDurationSec, state.playheadSec + skipSec);
}

function onTimelineInput() {
    if (!state.activeStorm) return;
    state.isPlaying = false;
    playPauseBtn.textContent = "PLAY";
    const frac = Math.max(0, Math.min(1, numOrDefault(timelineSlider.value, 0) / 100));
    state.playheadSec = state.activeStorm.totalDurationSec * frac;
}

function onBack() {
    state.activeStorm = null;
    state.allTyphoons = [];
    state.fixedRealtimeCandidates = null;
    state.playheadSec = 0;
    state.isPlaying = false;
    stormSelect.innerHTML = '<option value="">Load a year first</option>';
    stormSelect.disabled = true;
    timelineSlider.value = "0";
    playPauseBtn.textContent = "PLAY";
    timeDisplay.textContent = "Current Time: --";
    clearError();
    formatWeatherPanel();
}

function onZoomToggle() {
    state.currentZoom = state.currentZoom === "par" ? "full" : "par";
    zoomBtn.textContent = state.currentZoom === "par" ? "ZOOM OUT" : "ZOOM PAR";
    if (hasRealtimeLayer()) fetchWeatherGrid(true);
}

function onHeatToggle() {
    state.showHeat = !state.showHeat;
    heatToggle.textContent = state.showHeat ? "HEAT MAP ON" : "HEAT MAP OFF";
    heatToggle.classList.toggle("active", state.showHeat);
}

function onWindToggle() {
    state.showWind = !state.showWind;
    windToggle.textContent = state.showWind ? "WIND MAP ON" : "WIND MAP OFF";
    windToggle.classList.toggle("active", state.showWind);
}

function onPredictionToggle() {
    state.showPrediction = !state.showPrediction;
    if (!predictionToggleBtn) return;
    predictionToggleBtn.textContent = state.showPrediction ? "FORECAST CONE ON" : "FORECAST CONE OFF";
    predictionToggleBtn.classList.toggle("active", state.showPrediction);
}

function setRealtimeLayer(layerName) {
    if (layerName === "temperature") {
        state.realtimeHeatEnabled = !state.realtimeHeatEnabled;
    } else if (layerName === "wind") {
        state.realtimeWindEnabled = !state.realtimeWindEnabled;
        if (state.realtimeWindEnabled) reseedWindParticles();
    } else if (layerName === "off") {
        state.realtimeHeatEnabled = false;
        state.realtimeWindEnabled = false;
        state.windParticles = [];
        state.fixedRealtimeCandidates = null;
    }
    syncRealtimeLayerButtons();
    if (hasRealtimeLayer()) fetchWeatherGrid(true);
    formatWeatherPanel();
}

function setForecastHour(hours, shouldRefresh) {
    state.forecastHour = Math.max(0, Math.min(12, numOrDefault(hours, 0)));
    if (forecastNowBtn) forecastNowBtn.classList.toggle("active", state.forecastHour === 0);
    if (forecast3hBtn) forecast3hBtn.classList.toggle("active", state.forecastHour === 3);
    if (forecast6hBtn) forecast6hBtn.classList.toggle("active", state.forecastHour === 6);
    if (forecast12hBtn) forecast12hBtn.classList.toggle("active", state.forecastHour === 12);
    if (shouldRefresh && hasRealtimeLayer()) fetchWeatherGrid(true);
    formatWeatherPanel();
}

function onLayerHeatClick() {
    state.realtimePreset = "temperature";
    syncLayerMenuButtons();
    setRealtimeLayer("temperature");
}

function onLayerWindClick() {
    state.realtimePreset = "wind";
    syncLayerMenuButtons();
    setRealtimeLayer("wind");
}

function onLayerOffClick() {
    setRealtimeLayer("off");
}

function clearActiveTyphoonView() {
    state.activeStorm = null;
    state.playheadSec = 0;
    state.isPlaying = false;
    if (stormSelect) stormSelect.value = "";
    timelineSlider.value = "0";
    playPauseBtn.textContent = "PLAY";
    timeDisplay.textContent = "Current Time: --";
}

function onRealtimeForecastClick() {
    if (realtimeForecastBtn) {
        realtimeForecastBtn.disabled = true;
        realtimeForecastBtn.textContent = "UPDATING...";
    }
    try {
        clearActiveTyphoonView();
        if (!hasRealtimeLayer()) {
            state.realtimePreset = "temperature";
            state.realtimeHeatEnabled = true;
            syncRealtimeLayerButtons();
            syncLayerMenuButtons();
        }
        fetchWeatherGrid(true);
        formatWeatherPanel();
    } finally {
        setTimeout(() => {
            if (realtimeForecastBtn) {
                realtimeForecastBtn.disabled = false;
                realtimeForecastBtn.textContent = "REALTIME FORECAST";
            }
        }, 600);
    }
}

function onForecastNowClick() {
    setForecastHour(0, true);
}

function onForecast3hClick() {
    setForecastHour(3, true);
}

function onForecast6hClick() {
    setForecastHour(6, true);
}

function onForecast12hClick() {
    setForecastHour(12, true);
}

function onLayerMenuClick(e) {
    const btn = e.target && e.target.closest ? e.target.closest(".layer-pill") : null;
    if (!btn) return;
    const layerId = btn.dataset.layer;
    if (!layerId) return;
    applyLayerPreset(layerId);
}

function init() {
    appRoot = document.getElementById("app-root");
    canvas = document.getElementById("storm-canvas");
    ctx = canvas.getContext("2d");
    yearInput = document.getElementById("year-input");
    submitBtn = document.getElementById("submit-btn");
    stormSelect = document.getElementById("storm-select");
    zoomBtn = document.getElementById("zoom-btn");
    heatToggle = document.getElementById("heat-toggle");
    windToggle = document.getElementById("wind-toggle");
    predictionToggleBtn = document.getElementById("prediction-toggle-btn");
    layerHeatBtn = document.getElementById("layer-heat-btn");
    layerWindBtn = document.getElementById("layer-wind-btn");
    layerOffBtn = document.getElementById("layer-off-btn");
    realtimeForecastBtn = document.getElementById("realtime-forecast-btn");
    forecastNowBtn = document.getElementById("forecast-now-btn");
    forecast3hBtn = document.getElementById("forecast-3h-btn");
    forecast6hBtn = document.getElementById("forecast-6h-btn");
    forecast12hBtn = document.getElementById("forecast-12h-btn");
    playPauseBtn = document.getElementById("play-pause-btn");
    skipBtn = document.getElementById("skip-btn");
    backBtn = document.getElementById("back-btn");
    timelineSlider = document.getElementById("timeline-slider");
    loadingMessage = document.getElementById("loading-message");
    errorMessage = document.getElementById("error-message");
    timeDisplay = document.getElementById("time-display");
    fpsDisplay = document.getElementById("fps-display");
    weatherLatLon = document.getElementById("weather-latlon");
    weatherCurrent = document.getElementById("weather-current");
    weatherHourly = document.getElementById("weather-hourly");
    overlayScale = document.getElementById("overlay-scale");
    scaleModelPrimary = document.getElementById("scale-model-primary");
    scaleLabel = document.getElementById("scale-label");
    scaleBar = document.getElementById("scale-bar");
    scaleTicks = document.getElementById("scale-ticks");
    layerMenu = document.getElementById("layer-menu");
    layerMenuButtons = Array.from(document.querySelectorAll(".layer-pill"));

    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);
    submitBtn.addEventListener("click", onSubmit);
    stormSelect.addEventListener("change", onStormSelectChange);
    yearInput.addEventListener("keypress", e => { if (e.key === "Enter") onSubmit(); });
    playPauseBtn.addEventListener("click", onPlayPause);
    skipBtn.addEventListener("click", onSkipWeek);
    timelineSlider.addEventListener("input", onTimelineInput);
    backBtn.addEventListener("click", onBack);
    zoomBtn.addEventListener("click", onZoomToggle);
    heatToggle.addEventListener("click", onHeatToggle);
    windToggle.addEventListener("click", onWindToggle);
    predictionToggleBtn.addEventListener("click", onPredictionToggle);
    layerHeatBtn.addEventListener("click", onLayerHeatClick);
    layerWindBtn.addEventListener("click", onLayerWindClick);
    layerOffBtn.addEventListener("click", onLayerOffClick);
    realtimeForecastBtn.addEventListener("click", onRealtimeForecastClick);
    forecastNowBtn.addEventListener("click", onForecastNowClick);
    forecast3hBtn.addEventListener("click", onForecast3hClick);
    forecast6hBtn.addEventListener("click", onForecast6hClick);
    forecast12hBtn.addEventListener("click", onForecast12hClick);
    if (layerMenu) layerMenu.addEventListener("click", onLayerMenuClick);
    heatToggle.classList.add("active");
    windToggle.classList.add("active");
    predictionToggleBtn.classList.add("active");
    syncRealtimeLayerButtons();
    syncLayerMenuButtons();
    setForecastHour(0, false);
    formatWeatherPanel();

    state.mapImage.crossOrigin = "anonymous";
    state.mapImage.src = "/api/map";
    state.mapImage.onerror = () => {};

    state.rafId = requestAnimationFrame(tick);
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
} else {
    init();
}

