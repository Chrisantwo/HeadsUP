// ── Enumerations ──────────────────────────────────────────
export type LayerType =
  | 'wind' | 'rain' | 'temp' | 'heat' | 'cloud' | 'wave' | 'seasonal' | 'satellite'
  | 'hurricane' | 'thunder'

export type MapTheme  = 'satellite' | 'terrain' | 'dark'
export type AppMode   = 'idle' | 'historical' | 'forecast'
export type StormCategory = 0 | 1 | 2 | 3 | 4 | 5

// ── Weather Data ──────────────────────────────────────────
export interface GridPoint {
  lat: number
  lon: number
  temp: number | null
  heat: number | null        // apparent temperature / heat index
  cloud: number | null       // 0-100 %
  windSpeed: number | null   // km/h
  windDir: number | null     // degrees
  precip: number | null      // mm/h
  waveHeight: number | null  // metres
}

export interface WindGrid {
  u: number[][]   // west-east m/s  (GRID_N × GRID_N)
  v: number[][]   // south-north m/s
}

// ── Storm Track ───────────────────────────────────────────
export interface TrackPoint {
  lat: number
  lon: number
  time: string       // 'YYYY-MM-DD HH:mm'
  windSpeed: number  // knots
  pressure: number   // hPa
  category: StormCategory
}

export interface Storm {
  name: string
  year: number
  path: TrackPoint[]
  peakCategory: StormCategory
}

export interface ForecastStep {
  lat: number
  lon: number
  hour: number
  windSpeed: number
  pressure: number
}

// ── Seasonal Outlook ──────────────────────────────────────
export interface SeasonalTrack {
  name: string
  year: number
  peakCat: StormCategory
  points: Array<{ lat: number; lon: number; cat: StormCategory }>
}

export interface SeasonalOutlook {
  month: number
  monthName: string
  avgStorms: number
  maxStorms: number
  maxYear: number
  activityLevel: 'quiet' | 'below-normal' | 'normal' | 'above-normal' | 'very active'
  forecastText: string
  trackDensity: Array<{ lat: number; lon: number; density: number }>
  historicalTracks: SeasonalTrack[]
}

// ── Map Tooltip ───────────────────────────────────────────
export interface HoverInfo {
  x: number   // container pixel
  y: number
  lat: number
  lon: number
  label: string
  value: string
  unit: string
}

// ── Historical Storm Catalog ──────────────────────────────
export interface HistoricalStorm {
  id: string
  name: string
  year: number
  month: number          // 1–12
  category: 'TD' | 'TS' | 'TY' | 'STY3' | 'STY4' | 'STY5'
  coordinates: [number, number][]  // [lat, lon] track path
  maxWinds: number     // knots
  minPressure: number  // hPa
}

// ── App State ─────────────────────────────────────────────
export interface DashboardState {
  activeLayer: LayerType
  mapTheme: MapTheme
  forecastHour: number        // 0, 3, 6, … 168
  isPlaying: boolean
  appMode: AppMode
  selectedYear: number
  availableStorms: Array<{ name: string; points: number }>
  activeStorm: Storm | null
  forecastSteps: ForecastStep[]
  gridPoints: GridPoint[]
  windGrid: WindGrid | null
  seasonalData: SeasonalOutlook | null
  hoverInfo: HoverInfo | null
}

export type DashboardAction =
  | { type: 'SET_LAYER';         layer: LayerType }
  | { type: 'SET_MAP_THEME';     theme: MapTheme }
  | { type: 'SET_FORECAST_HOUR'; hour: number }
  | { type: 'SET_PLAYING';       playing: boolean }
  | { type: 'SET_YEAR';          year: number }
  | { type: 'SET_STORM_LIST';    storms: Array<{ name: string; points: number }> }
  | { type: 'SET_ACTIVE_STORM';  storm: Storm | null }
  | { type: 'SET_APP_MODE';      mode: AppMode }
  | { type: 'SET_FORECAST_STEPS';steps: ForecastStep[] }
  | { type: 'SET_GRID_POINTS';   points: GridPoint[] }
  | { type: 'SET_WIND_GRID';     grid: WindGrid }
  | { type: 'SET_SEASONAL_DATA'; data: SeasonalOutlook | null }
  | { type: 'SET_HOVER';         info: HoverInfo }
  | { type: 'CLEAR_HOVER' }
