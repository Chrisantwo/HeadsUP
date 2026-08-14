// ── Shared live-storm data provider ─────────────────────────────────
// One source of truth for active storms, their forecast tracks, and the
// derived PAR alerts — consumed by the Storms, Map and Alerts tabs. Polls
// every 10 min (matching the backend cache) and fires a local notification
// when a storm newly escalates toward the PAR.
//
// It also hosts the DEMO SCENARIO (defense replay): while the demo is active it
// suppresses the live poll and steps a real historical typhoon (GONI/Rolly 2020)
// through this same pipeline, so PAR alerts + local notifications fire for real.
import { createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode } from 'react'
import { fetchStorms, fetchForecast, fetchScenario } from '../lib/api'
import {
  getNotificationPermission, requestNotificationPermission, scheduleLocalNotification,
} from '../lib/notifications'
import { computeParAlerts, alertHeadline, type ParAlert } from '../lib/alerts'
import { isInPar } from '../lib/par'
import type { LiveStorm, ForecastStep, TrackPoint } from '../lib/types'

const POLL_MS = 10 * 60 * 1000
const NAGA = { lat: 13.62, lon: 123.18 }
const NEAR_NAGA_KM = 150
const DEMO_STORM = 'GONI (Rolly) · DEMO'

function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number) {
  const R = 6371, r = Math.PI / 180
  const dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

interface StormData {
  storms: LiveStorm[]
  forecasts: Record<string, ForecastStep[]>
  alerts: ParAlert[]
  source: string | null
  loading: boolean
  refreshing: boolean
  error: string | null
  lastUpdated: Date | null
  refresh: () => Promise<void>
  // ── Demo scenario ──
  demoActive: boolean
  demoLoading: boolean
  demoPlaying: boolean
  demoSpeed: number
  demoIndex: number
  demoTotal: number
  demoName: string
  demoStatus: string
  demoStart: () => void
  demoStop: () => void
  demoPlay: () => void
  demoPause: () => void
  demoStep: () => void
  demoSetSpeed: (s: number) => void
}

const Ctx = createContext<StormData | null>(null)

export function StormDataProvider({ children }: { children: ReactNode }) {
  const [storms, setStorms] = useState<LiveStorm[]>([])
  const [forecasts, setForecasts] = useState<Record<string, ForecastStep[]>>({})
  const [alerts, setAlerts] = useState<ParAlert[]>([])
  const [source, setSource] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const notifiedRef = useRef<Set<string>>(new Set())

  // ── Demo scenario state ───────────────────────────────────────────────────
  const [demoActive, setDemoActive] = useState(false)
  const [demoLoading, setDemoLoading] = useState(false)
  const [demoPlaying, setDemoPlaying] = useState(false)
  const [demoSpeed, setDemoSpeed] = useState(2)
  const [demoIndex, setDemoIndex] = useState(0)
  const [demoName, setDemoName] = useState('GONI (Rolly) 2020')
  const demoActiveRef = useRef(false); demoActiveRef.current = demoActive
  const demoPointsRef = useRef<{ lat: number; lon: number; pressure: number; wind_speed: number }[]>([])
  const demoCatsRef = useRef<number[]>([])
  const demoStartIdxRef = useRef(0)
  const demoEndIdxRef = useRef(0)
  const demoWasInParRef = useRef(false)
  const demoNagaRef = useRef(false)
  const demoFetchingRef = useRef(false)

  const load = useCallback(async (isManual: boolean) => {
    if (demoActiveRef.current) return   // demo drives the data while active
    isManual ? setRefreshing(true) : setLoading(true)
    setError(null)
    try {
      const res = await fetchStorms()
      const list = res.storms ?? []
      setStorms(list)
      setSource(res.source ?? null)

      const fcEntries = await Promise.all(list.map(async (s): Promise<[string, ForecastStep[]]> => {
        try {
          const history: TrackPoint[] = s.path?.length ? s.path.slice(-16) : [{ lat: s.lat, lon: s.lon }]
          if (history.length < 2) return [s.name, []]
          const fc = await fetchForecast(s.name, history)
          return [s.name, fc.forecast_steps ?? []]
        } catch {
          return [s.name, []]
        }
      }))
      const fcMap = Object.fromEntries(fcEntries)
      setForecasts(fcMap)

      const nextAlerts = computeParAlerts(list, fcMap)
      setAlerts(nextAlerts)
      setLastUpdated(new Date())
      void fireNotifications(nextAlerts, notifiedRef.current)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    load(false)
    const id = setInterval(() => load(false), POLL_MS)
    return () => clearInterval(id)
  }, [load])

  // ── Demo controls ─────────────────────────────────────────────────────────
  const demoStart = useCallback(async () => {
    setDemoLoading(true); setError(null)
    try {
      try { await requestNotificationPermission() } catch { /* ignore */ }
      const j = await fetchScenario('goni')
      const pts = j.points ?? []
      const cats = j.categories ?? []
      const entry = pts.findIndex(p => isInPar(p.lat, p.lon))
      let nagaIdx = 0, best = Infinity
      pts.forEach((p, i) => {
        const d = haversineKm(NAGA.lat, NAGA.lon, p.lat, p.lon)
        if (d < best) { best = d; nagaIdx = i }
      })
      demoStartIdxRef.current = Math.max(0, (entry < 0 ? 0 : entry) - 12)
      demoEndIdxRef.current = Math.min(pts.length - 1, nagaIdx + 8)
      demoPointsRef.current = pts
      demoCatsRef.current = cats
      demoWasInParRef.current = false
      demoNagaRef.current = false
      setDemoName(j.display_name || 'GONI (Rolly) 2020')
      setDemoIndex(demoStartIdxRef.current)
      setStorms([]); setForecasts({}); setAlerts([])
      setDemoActive(true); setDemoPlaying(false)   // start paused; user presses Play
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the demo scenario.')
    } finally {
      setDemoLoading(false)
    }
  }, [])

  const demoStop = useCallback(() => {
    setDemoActive(false); setDemoPlaying(false)
    demoPointsRef.current = []; demoCatsRef.current = []
    setStorms([]); setForecasts({}); setAlerts([]); setSource(null)
    // Restore the live feed on the next tick (after demoActiveRef clears).
    setTimeout(() => load(false), 0)
  }, [load])

  const demoPlay = useCallback(() => {
    // Restart from the approach point when at the end (re-arm notifications).
    setDemoIndex(i => {
      if (i >= demoEndIdxRef.current) {
        demoWasInParRef.current = false
        demoNagaRef.current = false
        return demoStartIdxRef.current
      }
      return i
    })
    setDemoPlaying(true)
  }, [])
  const demoPause = useCallback(() => setDemoPlaying(false), [])
  const demoStep = useCallback(() => {
    setDemoPlaying(false)
    setDemoIndex(i => (i >= demoEndIdxRef.current ? demoStartIdxRef.current : i + 1))
  }, [])

  // Auto-advance while playing
  useEffect(() => {
    if (!demoActive || !demoPlaying) return
    const iv = Math.max(150, 900 / demoSpeed)
    const id = setInterval(() => {
      setDemoIndex(i => {
        if (i >= demoEndIdxRef.current) { setDemoPlaying(false); return i }
        return i + 1
      })
    }, iv)
    return () => clearInterval(id)
  }, [demoActive, demoPlaying, demoSpeed])

  // Drive storms/forecast/alerts/notifications from the demo storm
  useEffect(() => {
    if (!demoActive) return
    const pts = demoPointsRef.current
    if (!pts.length) return
    const i = Math.min(demoIndex, pts.length - 1)
    const p = pts[i]
    const path: TrackPoint[] = pts.slice(0, i + 1).map(q => ({
      lat: q.lat, lon: q.lon, pressure: q.pressure, wind_speed: q.wind_speed,
    }))
    const storm: LiveStorm = {
      name: DEMO_STORM, lat: p.lat, lon: p.lon, wind_speed: p.wind_speed,
      pressure: p.pressure, category: demoCatsRef.current[i] ?? 0,
      source: 'DEMO', freshness: 'live', path,
    }
    setStorms([storm]); setSource('DEMO'); setLastUpdated(new Date())

    // LSTM forecast for the partial track (throttled) → alerts
    if (!demoFetchingRef.current && path.length >= 2) {
      demoFetchingRef.current = true
      fetchForecast('GONI-DEMO', path.slice(-16))
        .then(fc => {
          const steps = fc.forecast_steps ?? []
          setForecasts({ [DEMO_STORM]: steps })
          setAlerts(computeParAlerts([storm], { [DEMO_STORM]: steps }))
        })
        .catch(() => setAlerts(computeParAlerts([storm], {})))
        .finally(() => { demoFetchingRef.current = false })
    } else {
      setAlerts(computeParAlerts([storm], forecasts))
    }

    // Local notifications on PAR entry and near-Naga landfall
    const inside = isInPar(p.lat, p.lon)
    if (inside && !demoWasInParRef.current) {
      void scheduleLocalNotification('⚠️ Typhoon entered PAR',
        `${demoName} is now inside the PAR — heading toward Bicol / Naga.`)
    }
    demoWasInParRef.current = inside
    const dNaga = haversineKm(NAGA.lat, NAGA.lon, p.lat, p.lon)
    if (dNaga <= NEAR_NAGA_KM && !demoNagaRef.current) {
      demoNagaRef.current = true
      void scheduleLocalNotification('🌀 Landfall threat — Naga City',
        `${demoName} is ~${Math.round(dNaga)} km from Naga. Take precautions.`)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demoActive, demoIndex, demoName])

  const demoCurrent = demoActive && demoPointsRef.current.length
    ? demoPointsRef.current[Math.min(demoIndex, demoPointsRef.current.length - 1)]
    : null
  const demoStatus = (() => {
    if (!demoCurrent) return ''
    const d = haversineKm(NAGA.lat, NAGA.lon, demoCurrent.lat, demoCurrent.lon)
    if (d <= NEAR_NAGA_KM) return `LANDFALL THREAT — ~${Math.round(d)} km from Naga`
    if (isInPar(demoCurrent.lat, demoCurrent.lon)) return 'INSIDE PAR — heading toward Bicol'
    return 'Approaching the PAR'
  })()

  const value: StormData = {
    storms, forecasts, alerts, source, loading, refreshing, error, lastUpdated,
    refresh: () => load(true),
    demoActive, demoLoading, demoPlaying, demoSpeed,
    demoIndex: Math.max(0, demoIndex - demoStartIdxRef.current),
    demoTotal: Math.max(0, demoEndIdxRef.current - demoStartIdxRef.current),
    demoName, demoStatus,
    demoStart, demoStop, demoPlay, demoPause, demoStep, demoSetSpeed: setDemoSpeed,
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useStormData(): StormData {
  const v = useContext(Ctx)
  if (!v) throw new Error('useStormData must be used within StormDataProvider')
  return v
}

/** Fire one local notification per new storm+status escalation (if permitted). */
async function fireNotifications(alerts: ParAlert[], fired: Set<string>) {
  const actionable = alerts.filter(a => a.status === 'inside' || a.status === 'approaching')
  if (!actionable.length) return
  const perm = await getNotificationPermission()
  if (!perm.granted) return
  for (const a of actionable) {
    const key = `${a.storm}:${a.status}`
    if (fired.has(key)) continue
    fired.add(key)
    await scheduleLocalNotification(
      a.status === 'inside' ? '🌀 Typhoon inside PAR' : '⚠️ Typhoon approaching PAR',
      alertHeadline(a),
    )
  }
}
