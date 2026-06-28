'use client'
import { useEffect, useRef, useState } from 'react'
import { useMapRef } from './MapWrapper'
import { useDashboard } from '@/hooks/useDashboardState'
import { API_BASE, CAT_COLOR, PAR } from '@/lib/constants'

interface StormPoint { lat: number; lon: number }
interface LiveStorm {
  name: string
  lat: number; lon: number
  wind_speed: number
  pressure?: number
  category: number
  path: StormPoint[]
}
interface ForecastStep { lat: number; lon: number; hour: number; wind_speed?: number }
interface TrackedStorm {
  info: LiveStorm
  forecast: ForecastStep[]
  entersParAt?: number
}

const PAR_POLY = [
  [PAR.latMax, PAR.lonMin], [PAR.latMax, PAR.lonMax],
  [PAR.latMin, PAR.lonMax], [PAR.latMin, PAR.lonMin],
  [PAR.latMax, PAR.lonMin],
] as [number, number][]

function inPar(lat: number, lon: number) {
  return lat >= PAR.latMin && lat <= PAR.latMax && lon >= PAR.lonMin && lon <= PAR.lonMax
}

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
  const [warning, setWarning] = useState<string | null>(null)
  const [fetchStatus, setFetchStatus] = useState<'idle'|'loading'|'ok'|'empty'|'error'>('idle')
  const [stormCount, setStormCount] = useState(0)

  const tracksRef  = useRef<import('leaflet').Layer[]>([])  // historical + forecast lines
  const markersRef = useRef<import('leaflet').Layer[]>([])  // animated position circle + label
  const [retryTick, setRetryTick] = useState(0)

  const active      = state.activeLayer === 'hurricane'
  const forecastHour = state.forecastHour   // 0–168

  // ── Fetch live storms ─────────────────────────────────────────
  // Depends only on [active, retryTick] — NOT on fetchStatus — so that
  // internal state changes (loading→ok) never cancel the in-flight Phase 2 fetch.
  useEffect(() => {
    void retryTick  // dependency — incrementing this re-triggers the effect
    if (!active) { setFetchStatus('idle'); return }
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
        if (!cancelled) setStorms(data.map(storm => ({ info: storm, forecast: [] })))

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
                if (inPar(step.lat, step.lon)) { entersParAt = step.hour; break }
              }
              return { info: storm, forecast, entersParAt }
            } catch {
              return { info: storm, forecast: [] }
            }
          })
        )

        if (!cancelled) {
          setStorms(tracked)
          const approaching = tracked.filter(s => s.entersParAt !== undefined)
          if (approaching.length) {
            setWarning(`Storms may enter PAR: ${approaching.map(s => `${s.info.name} (~${Math.round((s.entersParAt ?? 0) / 24)}d)`).join(', ')}`)
          } else {
            setWarning(null)
          }
        }
      } catch {
        if (!cancelled) {
          setFetchStatus('error')
          setTimeout(() => { if (!cancelled) setRetryTick(t => t + 1) }, 8000)
        }
      }
    }

    load()
    return () => { cancelled = true }
  }, [active, retryTick])

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
        // PAR boundary
        add(L.polyline(PAR_POLY, { color: '#4488ff', weight: 1.5, dashArray: '6 4', opacity: 0.6 }))

        // Pan to first storm once
        if (storms.length > 0) {
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

          // Forecast track — dashed, colored
          if (forecast.length > 1) {
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
  }, [active, storms, mapRef])

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

  if (!active) return null

  const statusMsg =
    fetchStatus === 'loading' ? 'Fetching storm data…' :
    fetchStatus === 'empty'   ? 'No active storms — retrying…' :
    fetchStatus === 'error'   ? 'Cannot reach backend — retrying…' :
    fetchStatus === 'ok'      ? `${stormCount} storm${stormCount !== 1 ? 's' : ''} tracked` :
    null

  const isForecasting = forecastHour > 0 && storms.some(s => s.forecast.length > 0)

  return (
    <>
      {statusMsg && (
        <div className="fixed z-[850] flex items-center gap-2 px-3 py-1.5 text-white text-xs font-semibold"
          style={{
            top: 58, left: '50%', transform: 'translateX(-50%)',
            background: fetchStatus === 'error' ? '#882200' : fetchStatus === 'ok' ? '#1a5c2a' : '#1a3acc',
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

      {warning && (
        <div className="fixed z-[850] flex items-center gap-2 px-4 py-2 text-white text-sm font-semibold"
          style={{
            top: statusMsg ? 92 : 58, left: '50%', transform: 'translateX(-50%)',
            background: 'linear-gradient(90deg,#cc2200,#ff4400)',
            borderRadius: 8, boxShadow: '0 4px 16px rgba(200,0,0,0.4)',
            maxWidth: 480,
          }}>
          <span style={{ fontSize: 16 }}>⚠</span>
          {warning}
        </div>
      )}
    </>
  )
}
