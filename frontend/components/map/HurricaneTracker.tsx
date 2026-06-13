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
  entersParAt?: number   // forecast hour when it enters PAR
}

const PAR_POLY = [
  [PAR.latMax, PAR.lonMin], [PAR.latMax, PAR.lonMax],
  [PAR.latMin, PAR.lonMax], [PAR.latMin, PAR.lonMin],
  [PAR.latMax, PAR.lonMin],
] as [number, number][]

function inPar(lat: number, lon: number) {
  return lat >= PAR.latMin && lat <= PAR.latMax && lon >= PAR.lonMin && lon <= PAR.lonMax
}

function windToCategory(kt: number): number {
  if (kt < 34)  return 0
  if (kt < 64)  return 1
  if (kt < 96)  return 2
  if (kt < 113) return 3
  if (kt < 137) return 4
  return 5
}

export function HurricaneTracker() {
  const mapRef = useMapRef()
  const { state } = useDashboard()
  const [storms, setStorms] = useState<TrackedStorm[]>([])
  const [warning, setWarning] = useState<string | null>(null)
  const layerGroupRef = useRef<import('leaflet').LayerGroup | null>(null)
  const active = state.activeLayer === 'hurricane'

  // ── Fetch live storms + forecast tracks ──────────────────────
  useEffect(() => {
    if (!active) return
    let cancelled = false

    async function load() {
      try {
        const res = await fetch(`${API_BASE}/api/realtime-storms`)
        if (!res.ok) throw new Error('storms fetch failed')
        const data: LiveStorm[] = await res.json()
        if (cancelled || !data.length) return

        const tracked: TrackedStorm[] = await Promise.all(
          data.map(async (storm) => {
            try {
              const path = storm.path?.length
                ? storm.path.slice(-16)
                : [{ lat: storm.lat, lon: storm.lon }]
              const fcRes = await fetch(`${API_BASE}/api/forecast/smart`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  storm_name: storm.name,
                  track_history: path,
                  use_live: false,
                }),
              })
              const fcData = fcRes.ok ? await fcRes.json() : null
              const forecast: ForecastStep[] = fcData?.track?.map(
                (s: { lat: number; lon: number; hour: number; wind_speed?: number; windSpeed?: number }) => ({
                  lat: s.lat,
                  lon: s.lon,
                  hour: s.hour,
                  wind_speed: s.wind_speed ?? s.windSpeed,
                })
              ) ?? []

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
            const names = approaching.map(s =>
              `${s.info.name} (~${Math.round((s.entersParAt ?? 0) / 24)}d)`
            ).join(', ')
            setWarning(`Storms may enter PAR: ${names}`)
          } else {
            setWarning(null)
          }
        }
      } catch {
        // Flask may be offline — silently skip
      }
    }

    load()
    return () => { cancelled = true }
  }, [active])

  // ── Draw onto Leaflet map ─────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    // Async Leaflet import
    import('leaflet').then((L) => {
      // Clear previous layer group
      layerGroupRef.current?.remove()

      if (!active) { layerGroupRef.current = null; return }

      const group = L.layerGroup().addTo(map)
      layerGroupRef.current = group

      // Draw PAR boundary
      L.polyline(PAR_POLY, { color: '#0088ff', weight: 1.5, dashArray: '6 4', opacity: 0.6 }).addTo(group)

      for (const { info, forecast, entersParAt } of storms) {
        const catColor = CAT_COLOR[info.category as keyof typeof CAT_COLOR] ?? '#87ceeb'

        // ── Current position marker ───────────────────────────
        L.circleMarker([info.lat, info.lon], {
          radius: 10, color: '#fff', weight: 2,
          fillColor: catColor, fillOpacity: 0.9,
        }).bindTooltip(
          `<b>${info.name}</b><br/>Cat ${info.category} · ${info.wind_speed} kt`,
          { permanent: false, className: 'storm-tip' }
        ).addTo(group)

        // ── Historic track (grey dashed) ──────────────────────
        if (info.path?.length > 1) {
          const pathLatLngs = info.path.map(p => [p.lat, p.lon] as [number, number])
          L.polyline(pathLatLngs, { color: '#888', weight: 1.5, dashArray: '3 5', opacity: 0.5 }).addTo(group)
        }

        // ── Forecast track ────────────────────────────────────
        if (forecast.length > 1) {
          const fcLatLngs = [
            [info.lat, info.lon] as [number, number],
            ...forecast.map(s => [s.lat, s.lon] as [number, number]),
          ]
          L.polyline(fcLatLngs, { color: catColor, weight: 2, dashArray: '8 5', opacity: 0.85 }).addTo(group)

          // 24 h interval dots
          forecast
            .filter((_, i) => i % 24 === 23 || i === forecast.length - 1)
            .forEach(step => {
              const stepCat = windToCategory(step.wind_speed ?? info.wind_speed)
              const stepColor = CAT_COLOR[stepCat as keyof typeof CAT_COLOR] ?? catColor
              L.circleMarker([step.lat, step.lon], {
                radius: 5, color: '#fff', weight: 1.5,
                fillColor: stepColor, fillOpacity: 0.75,
              }).bindTooltip(`+${step.hour}h · ${step.wind_speed ?? '?'} kt`)
               .addTo(group)
            })

          // PAR entry marker
          if (entersParAt !== undefined) {
            const entry = forecast.find(s => s.hour === entersParAt) ?? forecast[0]
            L.circleMarker([entry.lat, entry.lon], {
              radius: 8, color: '#ff2200', weight: 2.5,
              fillColor: '#ff6600', fillOpacity: 0.9,
            }).bindTooltip(`⚠ ${info.name} enters PAR ~${Math.round(entersParAt / 24)}d`, { permanent: true })
             .addTo(group)
          }
        }
      }
    })

    return () => {
      layerGroupRef.current?.remove()
      layerGroupRef.current = null
    }
  }, [active, storms, mapRef])

  // Warning banner (only when hurricane layer is active)
  if (!active || !warning) return null

  return (
    <div
      className="fixed z-[850] flex items-center gap-2 px-4 py-2 text-white text-sm font-semibold"
      style={{
        top: 58, left: '50%', transform: 'translateX(-50%)',
        background: 'linear-gradient(90deg, #cc2200 0%, #ff4400 100%)',
        borderRadius: 8,
        boxShadow: '0 4px 16px rgba(200,0,0,0.45)',
        maxWidth: 480,
        animation: 'pulse 2s infinite',
      }}
    >
      <span style={{ fontSize: 16 }}>⚠</span>
      {warning}
    </div>
  )
}
