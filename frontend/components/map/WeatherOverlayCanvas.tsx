'use client'
import { useEffect } from 'react'
import { useMapRef } from './MapWrapper'
import { useOverlayCanvas } from '@/hooks/useOverlayCanvas'
import { useDashboard } from '@/hooks/useDashboardState'
import type { LayerType } from '@/lib/types'
import { LAYER_META } from '@/lib/constants'

function getValueAt(
  layer: LayerType,
  lat: number, lon: number,
  gridPoints: ReturnType<typeof useDashboard>['state']['gridPoints'],
  seasonal: ReturnType<typeof useDashboard>['state']['seasonalData'],
): { label: string; value: string; unit: string } | null {
  if (layer === 'wind' || layer === 'satellite') return null

  if (layer === 'seasonal' && seasonal) {
    const closest = seasonal.trackDensity.reduce((best, p) =>
      Math.hypot(p.lat-lat, p.lon-lon) < Math.hypot(best.lat-lat, best.lon-lon) ? p : best
    )
    return { label: 'Storm Frequency', value: (closest.density * 100).toFixed(0), unit: '%' }
  }

  if (!gridPoints.length) return null
  const closest = gridPoints.reduce((best, p) =>
    Math.hypot(p.lat-lat, p.lon-lon) < Math.hypot(best.lat-lat, best.lon-lon) ? p : best
  )
  const meta = LAYER_META[layer]
  let value = ''
  if      (layer === 'temp')  value = (closest.temp  ?? 0).toFixed(1)
  else if (layer === 'heat')  value = ((closest.heat ?? closest.temp) ?? 0).toFixed(1)
  else if (layer === 'cloud') value = (closest.cloud ?? 0).toFixed(0)
  else if (layer === 'wave')  value = (closest.waveHeight ?? 0).toFixed(2)
  else if (layer === 'rain')  value = (closest.precip ?? 0).toFixed(1)
  return { label: meta.label, value, unit: meta.unit }
}

export function WeatherOverlayCanvas() {
  const mapRef = useMapRef()
  const { state, setHover, clearHover } = useDashboard()
  const { activeLayer, gridPoints, seasonalData } = state

  // Canvas rendering hook — handles draw + map-move redraws + resize
  const { canvasRef } = useOverlayCanvas(mapRef, activeLayer, gridPoints, seasonalData)

  // ── Hover tooltip via map container (NOT canvas) ──────────────
  // Attaching to the map container leaves scroll/zoom events untouched.
  useEffect(() => {
    const map  = mapRef.current
    if (!map) return
    const cont = map.getContainer()

    const onMove = (e: MouseEvent) => {
      if (activeLayer === 'wind' || activeLayer === 'satellite') { clearHover(); return }
      const rect = cont.getBoundingClientRect()
      const ll   = map.containerPointToLatLng([e.clientX - rect.left, e.clientY - rect.top])
      const info = getValueAt(activeLayer, ll.lat, ll.lng, gridPoints, seasonalData)
      if (!info) { clearHover(); return }
      const hover = { x: e.clientX, y: e.clientY, lat: ll.lat, lon: ll.lng, ...info }
      setHover(hover)
    }
    const onLeave = () => clearHover()

    cont.addEventListener('mousemove', onMove)
    cont.addEventListener('mouseleave', onLeave)
    return () => {
      cont.removeEventListener('mousemove', onMove)
      cont.removeEventListener('mouseleave', onLeave)
    }
  }, [activeLayer, gridPoints, seasonalData, mapRef, setHover, clearHover])

  const visible = activeLayer !== 'wind' && activeLayer !== 'satellite' && activeLayer !== 'hurricane'

  const blendMode: React.CSSProperties['mixBlendMode'] =
    activeLayer === 'rain' || activeLayer === 'thunder'
      ? 'screen'                          // black=transparent on dark map
      : activeLayer === 'heat' || activeLayer === 'temp' || activeLayer === 'seasonal'
      ? 'screen'
      : activeLayer === 'cloud' || activeLayer === 'wave'
      ? 'multiply'
      : 'normal'

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 pointer-events-none"
      style={{
        zIndex: 200,
        display: visible ? 'block' : 'none',
        mixBlendMode: blendMode,
        opacity: 0.60,
      }}
    />
  )
}
