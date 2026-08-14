'use client'
// ── Demo Scenario (historical replay for the defense) ──────────────────────
// Replays a real historical typhoon (GONI / Rolly 2020) through the app's REAL
// alert pipeline: it steps the storm along its actual track (approach → enter
// PAR → landfall near Naga). While active, HurricaneTracker injects the current
// storm state into the same `storms` list the live feed uses, so the existing
// PAR alerts, TCWS, and notifications fire on their own. Clearly labelled as a
// DEMO — it never pretends to be live.
import {
  createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode,
} from 'react'
import { API_BASE } from '@/lib/constants'
import { isInPar } from '@/lib/par'

const NAGA = { lat: 13.62, lon: 123.18 }
const NEAR_NAGA_KM = 150

function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number) {
  const R = 6371, r = Math.PI / 180
  const dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

interface DemoPoint { lat: number; lon: number; pressure: number; wind_speed: number }
interface DemoForecastStep { lat: number; lon: number; hour: number; wind_speed?: number }
interface DemoStorm {
  name: string; lat: number; lon: number; wind_speed: number
  pressure: number; category: number; path: { lat: number; lon: number }[]
}

interface DemoScenarioValue {
  active: boolean
  loading: boolean
  error: string | null
  displayName: string
  index: number
  total: number
  playing: boolean
  speed: number
  current: DemoStorm | null
  forecast: DemoForecastStep[]
  statusLabel: string
  start: () => void
  stop: () => void
  play: () => void
  pause: () => void
  step: () => void
  setSpeed: (s: number) => void
}

const Ctx = createContext<DemoScenarioValue | null>(null)

export function DemoScenarioProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [displayName, setDisplayName] = useState('GONI (Rolly) 2020')
  const [points, setPoints] = useState<DemoPoint[]>([])
  const [categories, setCategories] = useState<number[]>([])
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(2)          // steps per second baseline ×1
  const [forecast, setForecast] = useState<DemoForecastStep[]>([])

  const startIdxRef = useRef(0)
  const endIdxRef = useRef(0)
  const wasInParRef = useRef(false)
  const notifiedNagaRef = useRef(false)
  const fetchingRef = useRef(false)

  const notify = useCallback((title: string, body: string) => {
    if (typeof window === 'undefined' || !('Notification' in window)) return
    if (Notification.permission === 'granted') {
      try { new Notification(title, { body }) } catch { /* ignore */ }
    }
  }, [])

  // ── Load the scenario track from the backend, then begin ──────────────────
  const start = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      if (typeof window !== 'undefined' && 'Notification' in window &&
          Notification.permission === 'default') {
        try { await Notification.requestPermission() } catch { /* ignore */ }
      }
      const res = await fetch(`${API_BASE}/api/scenario?name=goni`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const j = await res.json()
      if (j.status !== 'success' || !Array.isArray(j.points)) throw new Error('bad scenario response')

      const pts: DemoPoint[] = j.points
      const cats: number[] = j.categories ?? []
      // Playback window: start ~12 steps before PAR entry, end a few steps past
      // the closest approach to Naga, so the panel sees approach → entry → landfall.
      const entry = pts.findIndex(p => isInPar(p.lat, p.lon))
      let nagaIdx = 0, best = Infinity
      pts.forEach((p, i) => {
        const d = haversineKm(NAGA.lat, NAGA.lon, p.lat, p.lon)
        if (d < best) { best = d; nagaIdx = i }
      })
      const startIdx = Math.max(0, (entry < 0 ? 0 : entry) - 12)
      const endIdx = Math.min(pts.length - 1, nagaIdx + 8)
      startIdxRef.current = startIdx
      endIdxRef.current = endIdx
      wasInParRef.current = false
      notifiedNagaRef.current = false

      setDisplayName(j.display_name ?? 'GONI (Rolly) 2020')
      setPoints(pts); setCategories(cats)
      setIndex(startIdx)
      setForecast([])
      setActive(true)
      setPlaying(false)   // start paused at the approach point; user presses Play
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  const stop = useCallback(() => {
    setActive(false); setPlaying(false); setPoints([]); setCategories([])
    setForecast([]); setIndex(0); setError(null)
  }, [])

  const play = useCallback(() => {
    // If we're at the end, restart from the approach point (and re-arm the
    // one-shot notifications) so the scenario can be replayed.
    setIndex(i => {
      if (i >= endIdxRef.current) {
        wasInParRef.current = false
        notifiedNagaRef.current = false
        return startIdxRef.current
      }
      return i
    })
    setPlaying(true)
  }, [])
  const pause = useCallback(() => setPlaying(false), [])
  const step = useCallback(() => {
    setPlaying(false)
    setIndex(i => (i >= endIdxRef.current ? startIdxRef.current : i + 1))
  }, [])

  // ── Auto-advance while playing ────────────────────────────────────────────
  useEffect(() => {
    if (!active || !playing) return
    const interval = Math.max(150, 900 / speed)
    const id = setInterval(() => {
      setIndex(i => {
        if (i >= endIdxRef.current) { setPlaying(false); return i }
        return i + 1
      })
    }, interval)
    return () => clearInterval(id)
  }, [active, playing, speed])

  // ── Fire notifications on PAR entry and near-Naga ─────────────────────────
  useEffect(() => {
    if (!active || !points.length) return
    const p = points[Math.min(index, points.length - 1)]
    const inside = isInPar(p.lat, p.lon)
    if (inside && !wasInParRef.current) {
      notify('⚠ Typhoon entered the PAR',
        `${displayName} is now inside the PAR — tracking toward Bicol / Naga.`)
    }
    wasInParRef.current = inside
    const dNaga = haversineKm(NAGA.lat, NAGA.lon, p.lat, p.lon)
    if (dNaga <= NEAR_NAGA_KM && !notifiedNagaRef.current) {
      notifiedNagaRef.current = true
      notify('🌀 Landfall threat — Naga City',
        `${displayName} is ~${Math.round(dNaga)} km from Naga. Take precautions.`)
    }
  }, [active, index, points, displayName, notify])

  // ── Fetch the LSTM forecast for the partial track (throttled) ─────────────
  useEffect(() => {
    if (!active || !points.length) return
    if (fetchingRef.current) return
    const partial = points.slice(0, index + 1).slice(-16)
    if (partial.length < 2) { setForecast([]); return }
    fetchingRef.current = true
    const ctrl = new AbortController()
    ;(async () => {
      try {
        const res = await fetch(`${API_BASE}/api/forecast/smart`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ storm_name: 'GONI-DEMO', track_history: partial, use_live: false }),
          signal: ctrl.signal,
        })
        const j = res.ok ? await res.json() : null
        const steps: DemoForecastStep[] = (j?.forecast_steps ?? []).map(
          (s: { lat: number; lon: number; hour: number; wind_speed?: number }) =>
            ({ lat: s.lat, lon: s.lon, hour: s.hour, wind_speed: s.wind_speed }))
        setForecast(steps)
      } catch { /* keep previous forecast */ } finally {
        fetchingRef.current = false
      }
    })()
    return () => ctrl.abort()
  }, [active, index, points])

  const current: DemoStorm | null = active && points.length
    ? {
        name: 'GONI (Rolly) · DEMO',
        lat: points[Math.min(index, points.length - 1)].lat,
        lon: points[Math.min(index, points.length - 1)].lon,
        wind_speed: points[Math.min(index, points.length - 1)].wind_speed,
        pressure: points[Math.min(index, points.length - 1)].pressure,
        category: categories[Math.min(index, categories.length - 1)] ?? 0,
        path: points.slice(0, index + 1).map(p => ({ lat: p.lat, lon: p.lon })),
      }
    : null

  const statusLabel = (() => {
    if (!current) return ''
    const d = haversineKm(NAGA.lat, NAGA.lon, current.lat, current.lon)
    if (d <= NEAR_NAGA_KM) return `LANDFALL THREAT — ~${Math.round(d)} km from Naga`
    if (isInPar(current.lat, current.lon)) return 'INSIDE PAR — heading toward Bicol'
    return 'Approaching the PAR'
  })()

  return (
    <Ctx.Provider value={{
      active, loading, error, displayName,
      index: index - startIdxRef.current, total: endIdxRef.current - startIdxRef.current,
      playing, speed, current, forecast, statusLabel,
      start, stop, play, pause, step, setSpeed,
    }}>
      {children}
    </Ctx.Provider>
  )
}

export function useDemoScenario() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useDemoScenario must be inside DemoScenarioProvider')
  return ctx
}
