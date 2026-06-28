import type { LayerType, MapTheme, StormCategory } from './types'

export const PAR        = { latMin: 5, latMax: 25, lonMin: 115, lonMax: 135 }

// Weather data grid covers the full Western Pacific / Asia-Pacific region
export const WEATHER_BOUNDS = { latMin: -8, latMax: 45, lonMin: 88, lonMax: 168 }
export const GRID_N     = 28   // 28×28 = 784 points — wide coverage, stays smooth
export const PLAY_MS    = 450
export const FCST_STEPS = 56
export const STEP_HRS   = 3   // hours per timeline step

export const CAT_COLOR: Record<StormCategory, string> = {
  0: '#87ceeb', 1: '#64ee64', 2: '#e1e100',
  3: '#ff8200', 4: '#ff0000', 5: '#ff00ff',
}
export const CAT_LABEL: Record<StormCategory, string> = {
  0: 'TD', 1: 'TS', 2: 'TY', 3: 'STY3', 4: 'STY4', 5: 'STY5',
}
export const CAT_NAME: Record<StormCategory, string> = {
  0: 'Tropical Depression',    1: 'Tropical Storm',
  2: 'Typhoon (Cat 1-2)',       3: 'Severe Typhoon (Cat 3)',
  4: 'Super Typhoon (Cat 4)',  5: 'Super Typhoon (Cat 5)',
}

export const LAYER_META: Record<LayerType, {
  label: string; dot: string; description: string; unit: string
}> = {
  wind:     { label: 'Wind',           dot: '#0066cc', description: 'Wind particle flow field', unit: 'kt' },
  rain:     { label: 'Rain Radar',     dot: '#2299ff', description: 'Precipitation intensity',  unit: 'mm/h' },
  temp:     { label: 'Temperature',    dot: '#ff7800', description: '2 m air temperature',       unit: '°C' },
  heat:     { label: 'Heat Index',     dot: '#cc4400', description: 'Apparent / feels-like temp',unit: '°C' },
  cloud:    { label: 'Cloud Cover',    dot: '#8aaabb', description: 'Total cloud cover',          unit: '%' },
  wave:     { label: 'Waves',          dot: '#0077bb', description: 'Significant wave height',    unit: 'm' },
  seasonal: { label: 'Season Outlook', dot: '#9933cc', description: 'Historical track climatology',unit: '' },
  satellite:{ label: 'Satellite Only',    dot: '#33aa33', description: 'Esri World Imagery',                           unit: '' },
  hurricane:{ label: 'Hurricane Tracker', dot: '#ff4400', description: 'Active typhoon tracks & 7-day forecast paths',  unit: '' },
  thunder:  { label: 'Thunderstorm',      dot: '#ffcc00', description: 'Thunderstorm probability from cloud & rainfall', unit: '%' },
}

export const MAP_TILES: Record<MapTheme, { url: string; attr: string; maxZoom: number; sub?: string }> = {
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attr: '© Esri, Maxar, GeoEye', maxZoom: 17,
  },
  terrain: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
    attr: '© Esri', maxZoom: 17,
  },
  dark: {
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attr: '© CARTO', maxZoom: 19, sub: 'abcd',
  },
}

// Empty in production (same-origin Vercel deployment).
// Set NEXT_PUBLIC_API_URL=http://localhost:5000 in .env.local for local dev
// when the Next.js dev proxy (next.config.mjs rewrites) is not used.
export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? ''
