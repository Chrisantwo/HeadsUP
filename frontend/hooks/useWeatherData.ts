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

/** Extract a single forecast hour's data from the pre-fetched full grid. */
function sliceHour(pts: FullPoint[], hour: number): GridPoint[] {
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
    waveHeight: null,
  }))
}

/**
 * Fetches the full 7-day hourly grid from Flask ONCE on mount (cached 30 min
 * server-side). All subsequent forecast-hour changes are handled client-side
 * by indexing into the cached arrays — no extra API calls, instant switching.
 *
 * Falls back to mock data if Flask is unreachable.
 */
export function useWeatherData() {
  const { state, setGridPoints, setWindGrid } = useDashboard()
  const { forecastHour } = state

  const fullGridRef  = useRef<FullPoint[] | null>(null)
  const loadedRef    = useRef(false)
  const hourRef      = useRef(forecastHour)
  hourRef.current    = forecastHour   // always fresh

  // ── One-time full-grid fetch on mount ──────────────────────────
  useEffect(() => {
    if (loadedRef.current) return
    loadedRef.current = true

    ;(async () => {
      try {
        const res = await fetch(
          `${API_BASE}/api/weather/fullgrid?region=par`,
          { cache: 'no-store' },
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = await res.json()

        if (json.status === 'success' && Array.isArray(json.points)) {
          fullGridRef.current = json.points as FullPoint[]
          // Seed whichever hour the user is currently at (not necessarily 0)
          setGridPoints(sliceHour(json.points as FullPoint[], hourRef.current))
        } else {
          throw new Error('unexpected response shape')
        }
      } catch {
        // Flask unavailable — fall through to mock data
        fullGridRef.current = null
      }
    })()
  }, [setGridPoints])

  // ── Re-slice on every forecastHour change (instant, no network) ─
  useEffect(() => {
    const timer = setTimeout(() => {
      if (fullGridRef.current) {
        setGridPoints(sliceHour(fullGridRef.current, forecastHour))
      } else {
        // Mock fallback (runs when Flask is not running)
        setGridPoints(generateWeatherGrid(forecastHour))
      }
      setWindGrid(generateWindGrid(forecastHour))
    }, 50)
    return () => clearTimeout(timer)
  }, [forecastHour, setGridPoints, setWindGrid])
}
