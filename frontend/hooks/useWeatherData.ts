import { useEffect, useRef } from 'react'
import { useDashboard } from './useDashboardState'
import { generateWeatherGrid, generateWindGrid } from '@/lib/mockData'
import { API_BASE } from '@/lib/constants'
import type { GridPoint } from '@/lib/types'

// Shape of one point in the /api/weather/fullgrid response
interface FullPoint {
  lat:        number
  lon:        number
  temp:       (number | null)[]  // 168 hourly values
  heat:       (number | null)[]
  precip:     (number | null)[]
  wind_speed: (number | null)[]
  wind_dir:   (number | null)[]
  cloud:      (number | null)[]
}

// Shape of one point in the /api/weather/marine/fullgrid response
interface MarineFullPoint {
  lat:         number
  lon:         number
  wave_height: (number | null)[]  // 168 hourly values, empty [] for land points
}

/** IDW wave height from the coarser marine grid to any lat/lon at a given hour index. */
function idwWave(lat: number, lon: number, pts: MarineFullPoint[], i: number): number | null {
  const k = 4
  const candidates = pts
    .map(p => ({ p, d2: (p.lat - lat) ** 2 + (p.lon - lon) ** 2 }))
    .sort((a, b) => a.d2 - b.d2)
    .slice(0, k)
  const valid = candidates.filter(c => {
    const v = c.p.wave_height[i]
    return v !== null && v !== undefined
  })
  if (!valid.length) return null
  if (valid[0].d2 < 0.001) return valid[0].p.wave_height[i] ?? null
  let wSum = 0, vSum = 0
  for (const { p, d2 } of valid) {
    const v = p.wave_height[i]
    if (v === null || v === undefined) continue
    const w = 1 / d2; wSum += w; vSum += w * v
  }
  return wSum > 0 ? vSum / wSum : null
}

/** Extract a single forecast hour's data from the pre-fetched full grids. */
function sliceHour(
  pts: FullPoint[],
  hour: number,
  marinePts: MarineFullPoint[] | null,
): GridPoint[] {
  const maxIdx = (pts[0]?.temp.length ?? 1) - 1
  const i = Math.min(Math.max(0, hour), maxIdx)
  return pts.map(p => ({
    lat:        p.lat,
    lon:        p.lon,
    temp:       p.temp[i]       ?? null,
    heat:       p.heat[i]       ?? null,
    precip:     p.precip[i]     ?? null,
    windSpeed:  p.wind_speed[i] ?? null,
    windDir:    p.wind_dir[i]   ?? null,
    cloud:      p.cloud[i]      ?? null,
    waveHeight: marinePts ? idwWave(p.lat, p.lon, marinePts, i) : null,
  }))
}

/**
 * Fetches the full 7-day hourly weather + wave grids from Flask ONCE on mount.
 * All subsequent forecast-hour changes are handled client-side by indexing into
 * the cached arrays — no extra API calls, instant switching.
 *
 * Falls back to mock data if Flask is unreachable.
 */
export function useWeatherData() {
  const { state, setGridPoints, setWindGrid } = useDashboard()
  const { forecastHour } = state

  const fullGridRef    = useRef<FullPoint[] | null>(null)
  const marineGridRef  = useRef<MarineFullPoint[] | null>(null)
  const loadedRef      = useRef(false)
  const marineLoadedRef = useRef(false)
  const hourRef        = useRef(forecastHour)
  hourRef.current      = forecastHour   // always fresh

  // ── Full-grid fetch — retries until Flask responds ────────────
  useEffect(() => {
    if (loadedRef.current) return
    let cancelled = false

    async function tryFetch() {
      try {
        const res = await fetch(
          `${API_BASE}/api/weather/fullgrid?region=par`,
          { cache: 'no-store' },
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = await res.json()

        if (json.status === 'success' && Array.isArray(json.points)) {
          if (cancelled) return
          fullGridRef.current = json.points as FullPoint[]
          loadedRef.current = true
          setGridPoints(sliceHour(json.points as FullPoint[], hourRef.current, marineGridRef.current))
        } else {
          throw new Error('unexpected response shape')
        }
      } catch {
        // Flask not ready yet — retry in 4 s
        if (!cancelled) setTimeout(tryFetch, 4000)
      }
    }

    tryFetch()
    return () => { cancelled = true }
  }, [setGridPoints])

  // ── Marine fullgrid fetch — retries until Flask responds ──────
  useEffect(() => {
    if (marineLoadedRef.current) return
    let cancelled = false

    async function tryMarineFetch() {
      try {
        const res = await fetch(
          `${API_BASE}/api/weather/marine/fullgrid?region=par`,
          { cache: 'no-store' },
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = await res.json()

        if (json.status === 'success' && Array.isArray(json.points)) {
          if (cancelled) return
          marineGridRef.current = json.points as MarineFullPoint[]
          marineLoadedRef.current = true
          // Re-slice current hour now that we have wave data
          if (fullGridRef.current) {
            setGridPoints(sliceHour(fullGridRef.current, hourRef.current, json.points as MarineFullPoint[]))
          }
        } else {
          throw new Error('unexpected marine response shape')
        }
      } catch {
        // Marine endpoint not ready yet — retry in 8 s (lower priority than weather)
        if (!cancelled) setTimeout(tryMarineFetch, 8000)
      }
    }

    tryMarineFetch()
    return () => { cancelled = true }
  }, [setGridPoints])

  // ── Re-slice on every forecastHour change (instant, no network) ─
  useEffect(() => {
    const timer = setTimeout(() => {
      if (fullGridRef.current) {
        setGridPoints(sliceHour(fullGridRef.current, forecastHour, marineGridRef.current))
      } else {
        // Mock fallback (runs when Flask is not running)
        setGridPoints(generateWeatherGrid(forecastHour))
      }
      setWindGrid(generateWindGrid(forecastHour))
    }, 50)
    return () => clearTimeout(timer)
  }, [forecastHour, setGridPoints, setWindGrid])
}
