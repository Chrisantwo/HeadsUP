'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useMapRef } from './MapWrapper'
import { useDashboard } from '@/hooks/useDashboardState'
import { API_BASE, CAT_COLOR } from '@/lib/constants'
import { generateEnsembleSpaghettiPlot, type ModelTrack, type MultiModelResponse } from '@/lib/forecastModels'
import { PAR_BOUNDARY, isInPar } from '@/lib/par'
import { ParAlerts, computeParAlerts } from '../alerts/ParAlerts'
import { NotificationCenter } from '../alerts/NotificationCenter'
import { useParBroadcastEngine } from '@/hooks/useParBroadcastEngine'
import { useDemoScenario } from '@/hooks/useDemoScenario'
import { ModelLegend } from './ModelLegend'

interface StormPoint { lat: number; lon: number }
interface LiveStorm {
  name: string
  lat: number; lon: number
  wind_speed: number
  pressure?: number
  category: number
  path: StormPoint[]
  freshness?: 'live' | 'delayed' | 'archive' | 'none'
  age_hours?: number | null
}
interface ForecastStep { lat: number; lon: number; hour: number; wind_speed?: number }
interface TrackedStorm {
  info: LiveStorm
  forecast: ForecastStep[]
  entersParAt?: number
}

const LIVE_POLL_MS = 600_000        // matches backend live_storms_cache refresh loop
const MODEL_TRACK_TTL_MS = 600_000  // matches backend multi-model track cache TTL

function windToCategory(kt: number) {
  if (kt < 34) return 0
  if (kt < 64) return 1
  if (kt < 96) return 2
  if (kt < 113) return 3
  if (kt < 137) return 4
  return 5
}

/** Linear interpolation of storm position + intensity at a given forecast hour. */
function interpolateAtHour(storm: TrackedStorm, hour: number) {
  const { info, forecast } = storm
  if (hour <= 0 || !forecast.length) {
    return { lat: info.lat, lon: info.lon, wind_speed: info.wind_speed, category: info.category }
  }

  const steps = [...forecast].sort((a, b) => a.hour - b.hour)

  // Before first step — interpolate from real current pos
  if (hour <= steps[0].hour) {
    const t = hour / steps[0].hour
    return {
      lat: info.lat + (steps[0].lat - info.lat) * t,
      lon: info.lon + (steps[0].lon - info.lon) * t,
      wind_speed: info.wind_speed,
      category: info.category,
    }
  }
  // After last step — clamp
  if (hour >= steps[steps.length - 1].hour) {
    const last = steps[steps.length - 1]
    const ws = last.wind_speed ?? info.wind_speed
    return { lat: last.lat, lon: last.lon, wind_speed: ws, category: windToCategory(ws) }
  }
  // Between two steps
  for (let i = 0; i < steps.length - 1; i++) {
    if (hour >= steps[i].hour && hour < steps[i + 1].hour) {
      const t = (hour - steps[i].hour) / (steps[i + 1].hour - steps[i].hour)
      const lat = steps[i].lat + (steps[i + 1].lat - steps[i].lat) * t
      const lon = steps[i].lon + (steps[i + 1].lon - steps[i].lon) * t
      const ws =
        steps[i].wind_speed != null && steps[i + 1].wind_speed != null
          ? steps[i].wind_speed! + (steps[i + 1].wind_speed! - steps[i].wind_speed!) * t
          : info.wind_speed
      return { lat, lon, wind_speed: ws, category: windToCategory(ws) }
    }
  }
  return { lat: info.lat, lon: info.lon, wind_speed: info.wind_speed, category: info.category }
}

export function HurricaneTracker() {
  const mapRef = useMapRef()
  const { state } = useDashboard()
  const [storms, setStorms] = useState<TrackedStorm[]>([])
  const [fetchStatus, setFetchStatus] = useState<'idle'|'loading'|'ok'|'empty'|'error'>('idle')
  const [stormCount, setStormCount] = useState(0)
  const [dataFreshness, setDataFreshness] = useState<{ level: string; ageH: number | null }>({ level: 'live', ageH: null })

  const tracksRef  = useRef<import('leaflet').Layer[]>([])  // historical + forecast lines
  const markersRef = useRef<import('leaflet').Layer[]>([])  // animated position circle + label
  const spaghettiRef = useRef<import('leaflet').Layer[]>([]) // multi-model ensemble polylines
  const [retryTick, setRetryTick] = useState(0)

  // Multi-model ensemble tracks per storm name (10 agencies).
  // Refetched once per TTL so consensus-change detection sees fresh data.
  const [modelTracks, setModelTracks] = useState<Record<string, ModelTrack[]>>({})
  const modelFetchAt = useRef<Record<string, number>>({})   // storm → epoch ms of last fetch

  const active      = state.activeLayer === 'hurricane'
  const forecastHour = state.forecastHour   // 0–168
  const enabledModels = state.enabledModels
  const showAiLine = enabledModels.includes('AI_ENSEMBLE')

  // Demo Scenario (defense replay). While active, we suppress the live feed and
  // inject the replayed storm into `storms`, so all the alert/broadcast/track
  // logic below runs on it unchanged.
  const demo = useDemoScenario()

  // ── Fetch live storms ─────────────────────────────────────────
  // Depends only on [active, retryTick] — NOT on fetchStatus — so that
  // internal state changes (loading→ok) never cancel the in-flight Phase 2 fetch.
  useEffect(() => {
    void retryTick  // dependency — incrementing this re-triggers the effect
    if (!active) { setFetchStatus('idle'); return }
    if (demo.active) return   // demo replay drives `storms` instead of the live feed
    let cancelled = false

    async function load() {
      setFetchStatus('loading')
      try {
        const res = await fetch(`${API_BASE}/api/realtime-storms`, { cache: 'no-store' })
        if (!res.ok) throw new Error(`fetch failed: ${res.status}`)
        const json = await res.json()
        const data: LiveStorm[] = json.storms ?? []
        if (cancelled) return

        if (!data.length) {
          setFetchStatus('empty')
          // Bump retryTick after 5 s — re-triggers this effect cleanly
          setTimeout(() => { if (!cancelled) setRetryTick(t => t + 1) }, 5000)
          return
        }

        setFetchStatus('ok')
        setStormCount(data.length)
        // Surface honest data freshness — never imply "live" for lagged best-track.
        const ages = data.map(s => s.age_hours).filter((a): a is number => typeof a === 'number')
        setDataFreshness({ level: json.freshness ?? 'live', ageH: ages.length ? Math.max(...ages) : null })
        // Phase-1 quick render only on the first load — on 10-min refreshes,
        // keep the existing forecasts on screen until Phase 2 replaces them.
        if (!cancelled) setStorms(prev => prev.length ? prev : data.map(storm => ({ info: storm, forecast: [] })))

        const tracked: TrackedStorm[] = await Promise.all(
          data.map(async (storm) => {
            try {
              const path = storm.path?.length ? storm.path.slice(-16) : [{ lat: storm.lat, lon: storm.lon }]
              const fcRes = await fetch(`${API_BASE}/api/forecast/smart`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ storm_name: storm.name, track_history: path, use_live: false }),
              })
              const fcData = fcRes.ok ? await fcRes.json() : null
              const forecast: ForecastStep[] = (fcData?.forecast_steps ?? fcData?.track ?? []).map(
                (s: { lat: number; lon: number; hour: number; wind_speed?: number; windSpeed?: number }) => ({
                  lat: s.lat, lon: s.lon, hour: s.hour, wind_speed: s.wind_speed ?? s.windSpeed,
                })
              )
              let entersParAt: number | undefined
              for (const step of forecast) {
                if (isInPar(step.lat, step.lon)) { entersParAt = step.hour; break }
              }
              return { info: storm, forecast, entersParAt }
            } catch {
              return { info: storm, forecast: [] }
            }
          })
        )

        if (!cancelled) setStorms(tracked)
      } catch {
        if (!cancelled) {
          setFetchStatus('error')
          setTimeout(() => { if (!cancelled) setRetryTick(t => t + 1) }, 8000)
        }
      }
    }

    load()
    return () => { cancelled = true }
  }, [active, retryTick, demo.active])

  // ── Demo replay → inject the replayed storm into `storms` ─────────────────
  // While the demo is active, mirror its current state into the same TrackedStorm
  // shape the live feed produces, so PAR alerts, TCWS, and the broadcast engine
  // all react to it. When it turns off, clear and re-fetch the live feed.
  useEffect(() => {
    if (!demo.active) return
    if (!demo.current) return
    const c = demo.current
    const entersParAt = demo.forecast.find(s => isInPar(s.lat, s.lon))?.hour
    const injected: TrackedStorm = {
      info: {
        name: c.name, lat: c.lat, lon: c.lon, wind_speed: c.wind_speed,
        pressure: c.pressure, category: c.category, path: c.path, freshness: 'live',
      },
      forecast: demo.forecast,
      entersParAt,
    }
    setStorms([injected])
  }, [demo.active, demo.current, demo.forecast])

  useEffect(() => {
    if (demo.active) return
    // Demo just ended (or never started): clear injected storm and refresh live.
    setStorms([])
    setModelTracks({})
    modelFetchAt.current = {}
    setRetryTick(t => t + 1)
  }, [demo.active])

  const hasPannedRef = useRef(false)
  useEffect(() => { if (!active) hasPannedRef.current = false }, [active])

  // ── Poll live positions every 10 min while active ─────────────
  // Matches the backend's live_storms_cache refresh cadence; keeps the
  // 3-hour broadcast packets carrying fresh fixes instead of stale ones.
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setRetryTick(t => t + 1), LIVE_POLL_MS)
    return () => clearInterval(id)
  }, [active])

  // ── Fetch multi-model ensemble tracks (10 agencies) per storm ─────
  // Refetched once per MODEL_TRACK_TTL_MS (matches the backend's cache) so
  // the spaghetti plot and consensus-change detection track feed updates.
  // If the backend (or the live agency servers) are unreachable, fall back
  // to the local deterministic mock injector so the UI still works offline.
  useEffect(() => {
    if (!active) return
    for (const storm of storms) {
      const name = storm.info.name
      const fetchedAt = modelFetchAt.current[name]
      if (fetchedAt && Date.now() - fetchedAt < MODEL_TRACK_TTL_MS) continue
      const history = storm.info.path?.length > 1 ? storm.info.path.slice(-16) : null
      const localBase = storm.forecast
        .filter(s => s.hour % 6 === 0 && s.hour <= 120)
        .map(s => ({ lat: s.lat, lon: s.lon, hour: s.hour, wind_kt: s.wind_speed ?? null }))
      if (!history && localBase.length < 2) continue  // nothing to work with yet — retry on next storms update
      modelFetchAt.current[name] = Date.now()
      ;(async () => {
        try {
          if (!history) throw new Error('insufficient track history')
          const res = await fetch(`${API_BASE}/api/multi-model-tracks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ storm_name: name, track_history: history }),
          })
          if (!res.ok) throw new Error(`multi-model fetch failed: ${res.status}`)
          const data: MultiModelResponse = await res.json()
          setModelTracks(prev => ({ ...prev, [name]: data.models }))
        } catch (err) {
          console.warn('[HurricaneTracker] multi-model fetch failed, using local mock ensemble:', err)
          if (localBase.length > 1) {
            setModelTracks(prev => ({ ...prev, [name]: generateEnsembleSpaghettiPlot(localBase, name) }))
          } else {
            delete modelFetchAt.current[name]  // allow retry once the AI forecast arrives
          }
        }
      })()
    }
  }, [active, storms])

  // ── Effect 1: Static tracks — historical path, forecast line, day markers ──
  // Only redraws when the storm list changes, NOT on every timeline scrub.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    tracksRef.current.forEach(l => { try { map.removeLayer(l) } catch {} })
    tracksRef.current = []

    if (!active) return

    import('leaflet').then((L) => {
      const m = mapRef.current
      if (!m) return
      const layers: import('leaflet').Layer[] = []
      const add = (l: import('leaflet').Layer) => { l.addTo(m!); layers.push(l) }

      try {
        // Official PAR boundary polygon
        add(L.polyline(PAR_BOUNDARY, { color: '#4488ff', weight: 1.5, dashArray: '6 4', opacity: 0.6 }))

        // Pan to first storm once per layer activation — not on every
        // 10-min position refresh, which would yank the map from the user.
        if (storms.length > 0 && !hasPannedRef.current) {
          hasPannedRef.current = true
          const first = storms[0].info
          m.setView([first.lat, first.lon], Math.max(m.getZoom(), 5), { animate: true })
        }

        for (const { info, forecast, entersParAt } of storms) {
          const catColor = (CAT_COLOR as Record<number, string>)[info.category] ?? '#87ceeb'

          // Historical track — grey solid line + small dots
          if (info.path?.length > 1) {
            const pathLL = info.path.map((p: StormPoint) => [p.lat, p.lon] as [number, number])
            add(L.polyline(pathLL, { color: '#888', weight: 2, opacity: 0.7 }))
            for (const pt of info.path.slice(0, -1)) {
              add(L.circleMarker([pt.lat, pt.lon], {
                radius: 3, color: '#aaa', weight: 1, fillColor: '#666', fillOpacity: 0.85,
              }))
            }
          }

          // Forecast track (our AI model) — dashed, colored; toggled via the
          // AI Ensemble entry in the model legend
          if (forecast.length > 1 && showAiLine) {
            const fcLL = [
              [info.lat, info.lon] as [number, number],
              ...forecast.map(s => [s.lat, s.lon] as [number, number]),
            ]
            add(L.polyline(fcLL, { color: catColor, weight: 2, dashArray: '8 5', opacity: 0.8 }))

            // Day markers: numbered circles every 24h
            forecast.filter(s => s.hour > 0 && s.hour % 24 === 0).forEach(step => {
              const day = Math.round(step.hour / 24)
              const ws = step.wind_speed ?? info.wind_speed
              const stepCat = windToCategory(ws)
              const stepColor = (CAT_COLOR as Record<number, string>)[stepCat] ?? catColor
              const icon = L.divIcon({
                html: `<div style="background:${stepColor};border:2px solid rgba(255,255,255,0.9);border-radius:50%;width:20px;height:20px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:bold;color:white;box-shadow:0 1px 4px rgba(0,0,0,0.4)">${day}</div>`,
                className: '', iconSize: [20, 20], iconAnchor: [10, 10],
              })
              add(L.marker([step.lat, step.lon], { icon })
                .bindTooltip(`+${step.hour}h · ${Math.round(ws)} kt`, { sticky: true, className: 'storm-tip' }))
            })

            // PAR entry marker
            if (entersParAt !== undefined) {
              const entry = forecast.find(s => s.hour === entersParAt) ?? forecast[0]
              add(L.circleMarker([entry.lat, entry.lon], {
                radius: 8, color: '#ff2200', weight: 2, fillColor: '#ff4400', fillOpacity: 0.85,
              }).bindTooltip(`⚠ ${info.name} enters PAR ~${Math.round(entersParAt / 24)}d`, { sticky: true }))
            }
          }
        }
      } catch (err) {
        console.error('[HurricaneTracker] tracks draw error:', err)
      }

      tracksRef.current = layers
    })

    return () => {
      tracksRef.current.forEach(l => { try { map.removeLayer(l) } catch {} })
      tracksRef.current = []
    }
  }, [active, storms, mapRef, showAiLine])

  // ── Effect 1.5: Multi-model spaghetti polylines ────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    spaghettiRef.current.forEach(l => { try { map.removeLayer(l) } catch {} })
    spaghettiRef.current = []

    if (!active || !storms.length) return

    import('leaflet').then((L) => {
      const m = mapRef.current
      if (!m) return
      const layers: import('leaflet').Layer[] = []

      try {
        for (const storm of storms) {
          const tracks = modelTracks[storm.info.name]
          if (!tracks) continue
          for (const track of tracks) {
            // AI_ENSEMBLE is already drawn as the main category-colored forecast line
            if (track.model === 'AI_ENSEMBLE') continue
            if (!enabledModels.includes(track.model)) continue
            if (track.points.length < 2) continue

            const latlngs = [
              [storm.info.lat, storm.info.lon] as [number, number],
              ...track.points.map(p => [p.lat, p.lon] as [number, number]),
            ]
            const line = L.polyline(latlngs, {
              color: track.color,
              weight: track.model === 'PAGASA' ? 2.5 : 1.8,
              opacity: track.source === 'live' ? 0.9 : 0.55,
              dashArray: track.source === 'live' ? undefined : '4 6',
            }).bindTooltip(
              `<b>${track.label}</b> · ${track.source === 'live' ? 'LIVE' : 'SIMULATED'}<br/>${storm.info.name} forecast track`,
              { sticky: true, className: 'storm-tip' },
            )
            line.addTo(m)
            layers.push(line)
          }
        }
      } catch (err) {
        console.error('[HurricaneTracker] spaghetti draw error:', err)
      }

      spaghettiRef.current = layers
    })

    return () => {
      spaghettiRef.current.forEach(l => { try { map.removeLayer(l) } catch {} })
      spaghettiRef.current = []
    }
  }, [active, storms, modelTracks, enabledModels, mapRef])

  // ── Effect 2: Animated marker — updates on every timeline scrub ──
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    markersRef.current.forEach(l => { try { map.removeLayer(l) } catch {} })
    markersRef.current = []

    if (!active || !storms.length) return

    import('leaflet').then((L) => {
      const m = mapRef.current
      if (!m) return
      const layers: import('leaflet').Layer[] = []
      const add = (l: import('leaflet').Layer) => { l.addTo(m!); layers.push(l) }

      try {
        for (const storm of storms) {
          const pos = interpolateAtHour(storm, forecastHour)
          const catColor = (CAT_COLOR as Record<number, string>)[pos.category] ?? '#87ceeb'

          const isForecast = forecastHour > 0 && storm.forecast.length > 0

          // Storm circle with category number — glows when in forecast mode
          const glowStyle = isForecast
            ? 'box-shadow:0 0 0 5px rgba(255,255,255,0.25),0 2px 12px rgba(0,0,0,0.6);'
            : 'box-shadow:0 2px 10px rgba(0,0,0,0.55);'
          const stormIcon = L.divIcon({
            html: `<div style="
              background:${catColor};
              border:3px solid white;
              border-radius:50%;
              width:36px;height:36px;
              display:flex;align-items:center;justify-content:center;
              font-size:13px;font-weight:bold;color:white;
              ${glowStyle}
              cursor:pointer;
            ">${pos.category}</div>`,
            className: '', iconSize: [36, 36], iconAnchor: [18, 18],
          })

          const tooltipLabel = isForecast
            ? `<b>${storm.info.name}</b> <span style="opacity:0.7">+${forecastHour}h</span><br/>Cat ${pos.category} · ${Math.round(pos.wind_speed)} kt`
            : `<b>${storm.info.name}</b><br/>Cat ${pos.category} · ${Math.round(pos.wind_speed)} kt${storm.info.pressure ? `<br/>${storm.info.pressure} hPa` : ''}`

          add(L.marker([pos.lat, pos.lon], { icon: stormIcon })
            .bindTooltip(tooltipLabel, { sticky: true, className: 'storm-tip', offset: [0, -20] }))

          // Name + wind label beside the circle
          const labelIcon = L.divIcon({
            html: `<div style="
              color:white;font-size:11px;font-weight:700;
              white-space:nowrap;
              text-shadow:1px 1px 3px rgba(0,0,0,0.9),0 0 6px rgba(0,0,0,0.7);
              pointer-events:none;line-height:1.35;
            ">${storm.info.name}${isForecast ? ` <span style="font-size:9px;opacity:0.75">+${forecastHour}h</span>` : ''}<br/><span style="font-weight:400;opacity:0.9">${Math.round(pos.wind_speed)} kt</span></div>`,
            className: '', iconSize: [140, 30], iconAnchor: [-22, 15],
          })
          add(L.marker([pos.lat, pos.lon], { icon: labelIcon, interactive: false }))
        }
      } catch (err) {
        console.error('[HurricaneTracker] marker draw error:', err)
      }

      markersRef.current = layers
    })

    return () => {
      markersRef.current.forEach(l => { try { map.removeLayer(l) } catch {} })
      markersRef.current = []
    }
  }, [active, storms, forecastHour, mapRef])

  // ── PAR geo-fence alerts — current positions + all 10 model trajectories ──
  const parAlerts = useMemo(() => computeParAlerts(storms, modelTracks), [storms, modelTracks])

  // ── 3-hour broadcast loop for storms inside the PAR ──
  const { log: broadcastLog, toast: broadcastToast, dismissToast, clearLog, latestHeadlines } =
    useParBroadcastEngine(storms, modelTracks, parAlerts)

  // The crimson banner text follows the newest 3-hour snapshot
  const alertsWithHeadlines = useMemo(
    () => parAlerts.map(a =>
      a.status === 'inside' && latestHeadlines[a.storm]
        ? { ...a, headline: latestHeadlines[a.storm] }
        : a),
    [parAlerts, latestHeadlines],
  )

  // ── Auto-archive every storm that approaches or enters the PAR ──
  // Any storm the geo-fence flags 'approaching' or 'inside' is saved to the
  // backend dataset (POST /api/par-archive), which upserts by name+season so a
  // storm keeps one evolving record. We re-save only when a storm's snapshot
  // meaningfully changes (status / intensity / position / ETA), so polling
  // doesn't spam the backend.
  const savedSigRef = useRef<Map<string, string>>(new Map())

  useEffect(() => {
    const targets = parAlerts.filter(a => a.status === 'approaching' || a.status === 'inside')
    if (!targets.length) return

    for (const a of targets) {
      const storm = storms.find(s => s.info.name === a.storm)
      if (!storm) continue

      const sig = [
        a.status, a.category, a.windKt,
        Math.round(storm.info.lat * 2) / 2, Math.round(storm.info.lon * 2) / 2,
        a.etaHours ?? '-', storm.forecast.length,
      ].join('|')
      if (savedSigRef.current.get(a.storm) === sig) continue
      savedSigRef.current.set(a.storm, sig)

      const record = {
        name: a.storm,
        category: a.category,
        wind_kt: a.windKt,
        lat: storm.info.lat,
        lon: storm.info.lon,
        pressure: storm.info.pressure ?? null,
        par_status: a.status,
        eta_hours: a.etaHours,
        distance_km: a.distanceKm,
        consensus: a.consensus,
        track_history: storm.info.path ?? [],
        forecast: storm.forecast,
        models: (modelTracks[a.storm] ?? []).map(t => ({
          model: t.model, agency: t.agency, source: t.source, points: t.points,
        })),
      }

      fetch(`${API_BASE}/api/par-archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(record),
      }).catch(err => {
        console.error('[HurricaneTracker] PAR archive save failed:', err)
        savedSigRef.current.delete(a.storm)   // allow a retry on next update
      })
    }
  }, [parAlerts, storms, modelTracks])

  if (!active) return null

  const stale = fetchStatus === 'ok' && dataFreshness.level !== 'live'
  const freshnessNote =
    dataFreshness.level === 'delayed'
      ? ` · best track${dataFreshness.ageH != null ? ` ${Math.round(dataFreshness.ageH)}h old` : ''}`
      : dataFreshness.level === 'archive' ? ' · archive (no live feed)' : ''
  const statusMsg =
    fetchStatus === 'loading' ? 'Fetching storm data…' :
    fetchStatus === 'empty'   ? 'No active storms — retrying…' :
    fetchStatus === 'error'   ? 'Cannot reach backend — retrying…' :
    fetchStatus === 'ok'      ? `${stormCount} storm${stormCount !== 1 ? 's' : ''} tracked${freshnessNote}` :
    null

  const isForecasting = forecastHour > 0 && storms.some(s => s.forecast.length > 0)

  return (
    <>
      {statusMsg && (
        <div className="fixed z-[850] flex items-center gap-2 px-3 py-1.5 text-white text-xs font-semibold"
          style={{
            top: 58, left: '50%', transform: 'translateX(-50%)',
            background: fetchStatus === 'error' ? '#882200' : stale ? '#8a5a00' : fetchStatus === 'ok' ? '#1a5c2a' : '#1a3acc',
            borderRadius: 6, boxShadow: '0 2px 10px rgba(0,0,0,0.35)',
          }}>
          {statusMsg}
        </div>
      )}

      {/* Forecast hour pill — shown when scrubbing the timeline */}
      {isForecasting && (
        <div className="fixed z-[850] px-3 py-1 text-white text-xs font-bold"
          style={{
            bottom: 90, left: '50%', transform: 'translateX(-50%)',
            background: 'rgba(0,0,0,0.65)', borderRadius: 20,
            boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
            backdropFilter: 'blur(4px)',
          }}>
          Showing storm position at +{forecastHour}h ({Math.round(forecastHour / 24)}d {forecastHour % 24}h)
        </div>
      )}

      {/* Multi-model ensemble legend — toggle the 10 agency tracks */}
      {storms.length > 0 && (
        <ModelLegend tracks={Object.values(modelTracks).flat()} />
      )}

      {/* PAR geo-fence alerts — entered / approaching / watch, with browser notifications.
          Inside-PAR banner text follows the latest 3-hour broadcast snapshot. */}
      <ParAlerts alerts={alertsWithHeadlines} top={statusMsg ? 92 : 58} />

      {/* 3-hour broadcast log, slide-out timeline, and update toast */}
      <NotificationCenter
        log={broadcastLog}
        toast={broadcastToast}
        onDismissToast={dismissToast}
        onClearLog={clearLog}
      />

    </>
  )
}
