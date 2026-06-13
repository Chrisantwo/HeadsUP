/**
 * Mock weather data generators.
 * Time-variation is designed to be clearly visible step-by-step:
 *  – A typhoon-like cloud system drifts NW over 7 days
 *  – A warm/humid front sweeps northward
 *  – Temperature oscillates with a clear diurnal cycle
 * Replace fetch calls in useWeatherData.ts when connecting to a real API.
 */
import type { GridPoint, WindGrid, Storm, TrackPoint, StormCategory, SeasonalOutlook } from './types'
import { GRID_N, PAR, WEATHER_BOUNDS as WB } from './constants'

// Deterministic smooth noise
function n(x: number, y: number, s = 0) {
  const r = Math.sin(x * 127.1 + y * 311.7 + s * 74.1) * 43758.5453123
  return r - Math.floor(r)
}
function smooth(x: number, y: number, s = 0) {
  const ix = Math.floor(x), iy = Math.floor(y)
  const fx = x - ix, fy = y - iy
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy)
  return n(ix,iy,s)*(1-ux)*(1-uy) + n(ix+1,iy,s)*ux*(1-uy) +
         n(ix,iy+1,s)*(1-ux)*uy   + n(ix+1,iy+1,s)*ux*uy
}

export function generateWeatherGrid(forecastHour: number): GridPoint[] {
  const day  = forecastHour / 24          // 0–7 days
  const hrs  = forecastHour % 24          // hour of day 0–23
  const t    = forecastHour / 168         // 0–1 normalised

  // ── Moving typhoon-like cloud/rain system ──────────────────
  // Starts near SE corner, drifts NW at ~2° lat / 2.5° lon per day
  const typhLat = 8  + day * 1.8
  const typhLon = 134 - day * 2.2

  // ── Warm + humid front marching northward ─────────────────
  const frontLat = 7 + day * 2.0   // starts at 7°N, reaches 21°N by day 7

  // ── Diurnal temperature cycle (°C amplitude ±2.5) ─────────
  const diurnal = 2.5 * Math.sin(((hrs - 14) / 24) * 2 * Math.PI)   // peak ~14:00

  const pts: GridPoint[] = []

  for (let i = 0; i < GRID_N; i++) {
    for (let j = 0; j < GRID_N; j++) {
      const lat = WB.latMin + (i / (GRID_N - 1)) * (WB.latMax - WB.latMin)
      const lon = WB.lonMin + (j / (GRID_N - 1)) * (WB.lonMax - WB.lonMin)

      // ── Temperature ─────────────────────────────────────────
      const baseTemp = 33 - (lat - 5) * 0.40            // ~33°C at 5°N, ~25°C at 25°N
      const frontBoost = 4 * Math.exp(-0.5 * ((lat - frontLat) / 2.5) ** 2)  // +4°C near front
      const localNoise = (smooth(j * 0.3, i * 0.3, 0) - 0.5) * 2.5
      const temp = Math.max(22, Math.min(37, baseTemp + frontBoost + diurnal + localNoise))

      // ── Humidity & Heat index ────────────────────────────────
      const humidity = 65 + frontBoost * 4 + smooth(j * 0.4, i * 0.4 + t * 2, 1) * 20
      const heat = Math.min(48, temp + (humidity - 40) * 0.12)

      // ── Cloud cover ──────────────────────────────────────────
      // 1. Typhoon spiral band (0–100)
      const distTyph = Math.hypot((lat - typhLat) * 1.1, (lon - typhLon) * 0.85)
      const typhCloud = Math.max(0, 100 - distTyph * 12)
      // 2. ITCZ band (lat 8–14°N)
      const itczCloud = Math.max(0, 50 - Math.abs(lat - 11) * 8) * (0.6 + smooth(j * 0.5 + t * 4, i * 0.3, 2) * 0.8)
      // 3. Random background
      const bgCloud = smooth(j * 0.6 + t * 5, i * 0.5, 3) * 35
      const cloud = Math.min(100, Math.max(0, typhCloud + itczCloud + bgCloud))

      // ── Precipitation: only where cloud > 55 ────────────────
      const precip = cloud > 55 ? (cloud - 55) * 0.55 * smooth(j * 0.8, i * 0.7 + t * 3, 4) : 0

      // ── Wind (NE trade + typhoon circulation) ────────────────
      const typhAngle = Math.atan2(lat - typhLat, lon - typhLon)  // angle from typhoon centre
      const typhInfluence = Math.max(0, 1 - distTyph / 10)
      const windSpeed = 8 + typhInfluence * 25 + smooth(j * 0.5, i * 0.4 + t * 4, 5) * 8
      const windDir = 50 + (typhInfluence > 0.2 ? ((typhAngle * 180 / Math.PI + 90) % 360) : 0)
                      + smooth(j * 0.3, i * 0.5, 6) * 20

      // ── Wave height: ocean only, stronger near typhoon ──────
      const oceanFactor = Math.min(1, Math.max(0, (lon - 118) / 8))
      const waveHeight = (0.6 + typhInfluence * 4 + smooth(j * 0.4 + t, i * 0.3, 7) * 1.5) * oceanFactor

      pts.push({ lat, lon, temp, heat, cloud, windSpeed, windDir, precip, waveHeight })
    }
  }
  return pts
}

// ── Wind grid (u/v m/s) ──────────────────────────────────────
export function generateWindGrid(forecastHour: number): WindGrid {
  const day = forecastHour / 24
  const typhLat = 8 + day * 1.8
  const typhLon = 134 - day * 2.2
  const u: number[][] = [], v: number[][] = []

  for (let i = 0; i < GRID_N; i++) {
    u.push([]); v.push([])
    for (let j = 0; j < GRID_N; j++) {
      const lat = WB.latMin + (i / (GRID_N-1)) * (WB.latMax - WB.latMin)
      const lon = WB.lonMin + (j / (GRID_N-1)) * (WB.lonMax - WB.lonMin)
      const dist = Math.hypot(lat - typhLat, lon - typhLon)
      const infl = Math.max(0, 1 - dist / 10)
      // NE trade wind base
      const tradeU = -7 - smooth(j*0.3, i*0.3, 8) * 3
      const tradeV = -2 + smooth(j*0.4, i*0.4, 9) * 2
      // CCW typhoon circulation
      const angle = Math.atan2(lat - typhLat, lon - typhLon)
      const typhU = -infl * 15 * Math.sin(angle)
      const typhV =  infl * 15 * Math.cos(angle)
      u[i].push(tradeU + typhU)
      v[i].push(tradeV + typhV)
    }
  }
  return { u, v }
}

// ── Historical storm tracks (mock) ────────────────────────────
const NAMES = ['AGHON','BUTCHOY','CARINA','DOMENG','ESTER','FLORITA']

export function generateMockStorms(year: number): Storm[] {
  return NAMES.map((name, i) => {
    const path: TrackPoint[] = []
    let lat = 8 + i * 1.2, lon = 132 - i * 0.8
    let ws = 30 + i * 10, p = 1005 - i * 12
    for (let s = 0; s < 35 + i * 4; s++) {
      lat += 0.18 + smooth(s*0.5, i*0.3, i) * 0.15
      lon -= 0.12 + smooth(s*0.4, i*0.2, i+1) * 0.10
      if (lat > 18) lon += 0.08 * (lat - 18)
      ws = Math.max(18, ws - 0.2 + (smooth(s*0.7, i*0.4, i+2) - 0.45))
      p  = Math.min(1013, p + 0.5)
      const mo = String(((4 + i) % 12) + 1).padStart(2,'0')
      const dy = String((s % 28) + 1).padStart(2,'0')
      path.push({ lat: Math.min(30,lat), lon: Math.max(100,Math.min(180,lon)),
        time: `${year}-${mo}-${dy} 00:00`, windSpeed: ws, pressure: p, category: wsCat(ws) })
    }
    return { name, year, path, peakCategory: Math.max(...path.map(p=>p.category)) as StormCategory }
  })
}

// ── Seasonal outlook (mock) ───────────────────────────────────
const MONTHS = ['','January','February','March','April','May','June',
                'July','August','September','October','November','December']
const AVG_BY_MONTH = [0.4,0.3,0.5,0.8,1.2,2.2,3.8,5.1,5.8,4.2,2.8,1.4]

export function generateSeasonalOutlook(month: number, year: number): SeasonalOutlook {
  const avg = AVG_BY_MONTH[month - 1]
  const level =
    avg < 0.5 ? 'quiet' : avg < 1.5 ? 'below-normal' :
    avg < 3.0 ? 'normal' : avg < 4.5 ? 'above-normal' : 'very active'
  const trackDensity = []
  for (let i = 0; i < GRID_N; i++) {
    for (let j = 0; j < GRID_N; j++) {
      const lat = PAR.latMin+(i/(GRID_N-1))*(PAR.latMax-PAR.latMin)
      const lon = PAR.lonMin+(j/(GRID_N-1))*(PAR.lonMax-PAR.lonMin)
      const c = Math.exp(-0.5*((lat-15)/5)**2)*Math.exp(-0.5*((lon-127)/6)**2)
      trackDensity.push({ lat, lon, density: Math.min(1, c*avg/3+smooth(j*0.4,i*0.4,month)*0.08) })
    }
  }
  const mon = MONTHS[month]
  const note = month>=6&&month<=10 ? `${mon} is peak typhoon season.`
    : month>=11||month<=2 ? `${mon} is off-season — late storms possible.`
    : `${mon} is the pre-season build-up.`
  const historicalTracks = Array.from({ length: Math.ceil(avg*5) }, (_,k) => ({
    name: `${mon.slice(0,3).toUpperCase()}${k+1}`, year: 2013+(k%12),
    peakCat: Math.min(5,Math.round(avg*0.8+smooth(k*0.3,month*0.2,99))) as StormCategory,
    points: Array.from({length:28},(_,s)=>({
      lat:8+s*0.32+(smooth(s*0.5,k*0.3,k)-0.5)*1.5,
      lon:133-s*0.22+(smooth(s*0.4,k*0.2,k+1)-0.5)*1.5,
      cat:Math.min(5,Math.round(smooth(s*0.3,k*0.4,k+2)*4)) as StormCategory,
    })).filter(p=>p.lat>=PAR.latMin&&p.lat<=PAR.latMax&&p.lon>=PAR.lonMin&&p.lon<=PAR.lonMax),
  }))
  return { month, monthName:mon, avgStorms:avg, maxStorms:Math.ceil(avg*1.9), maxYear:2016,
    activityLevel:level, forecastText:`${mon} ${year} Seasonal Outlook\nBased on 12 years (2013–2024): avg ${avg.toFixed(1)} storms. ${level.toUpperCase()}. ${note}`,
    trackDensity, historicalTracks }
}

function wsCat(ws: number): StormCategory {
  if (ws<34) return 0; if (ws<64) return 1; if (ws<96) return 2
  if (ws<113) return 3; if (ws<137) return 4; return 5
}
