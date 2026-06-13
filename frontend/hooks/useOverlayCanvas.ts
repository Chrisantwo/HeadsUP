import { useEffect, useRef, useCallback } from 'react'
import type { GridPoint, SeasonalOutlook } from '@/lib/types'
import type { LayerType } from '@/lib/types'
import type { Map as LMap } from 'leaflet'
import {
  tempColor, heatColor, waveColor, precipColor, seasonColor, thunderColor,
  drawSmoothField,
} from '@/lib/colors'

// ── IDW interpolation from sparse grid to any lat/lon ─────────
const MAX_IDW_D2 = 6.25   // ~2.5 deg radius — beyond this, return null (no extrapolation)

function idw(
  lat: number, lon: number,
  gridPoints: GridPoint[],
  getValue: (p: GridPoint) => number | null,
  k = 6,
): number | null {
  const candidates = gridPoints
    .map(p => ({ p, d2: (p.lat - lat) ** 2 + (p.lon - lon) ** 2 }))
    .sort((a, b) => a.d2 - b.d2)
    .slice(0, k)

  const valid = candidates.filter(c => getValue(c.p) !== null)
  if (!valid.length) return null
  if (valid[0].d2 > MAX_IDW_D2) return null   // too far from any data point
  if (valid[0].d2 < 0.001) return getValue(valid[0].p)

  let wSum = 0, vSum = 0
  for (const { p, d2 } of valid) {
    const w = 1 / d2
    wSum += w
    vSum += w * (getValue(p) as number)
  }
  return vSum / wSum
}

// ── Build a virtual grid that exactly fills the current map view ─
function buildViewGrid(
  map: LMap,
  gridPoints: GridPoint[],
  layer: LayerType,
  N = 32,
): Array<{ x: number; y: number; value: number | null }> {
  const bounds = map.getBounds()
  const south = bounds.getSouth(), north = bounds.getNorth()
  const west  = bounds.getWest(),  east  = bounds.getEast()

  const getVal = (p: GridPoint): number | null => {
    if (layer === 'temp')    return p.temp
    if (layer === 'heat')    return p.heat ?? p.temp
    if (layer === 'cloud')   return (p.cloud ?? 0) >= 25 ? p.cloud : null
    if (layer === 'wave')    return (p.waveHeight ?? 0) >= 0.2 ? p.waveHeight : null
    if (layer === 'rain')    return (p.precip ?? 0) >= 0.3 ? p.precip : null   // skip dry areas
    if (layer === 'thunder') {
      const c = p.cloud  ?? 0
      const r = p.precip ?? 0
      const idx = Math.min(100, c * 0.6 + r * 18)
      return idx >= 18 ? idx : null   // skip low-instability areas
    }
    return null
  }

  const out: Array<{ x: number; y: number; value: number | null }> = []
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N; j++) {
      const lat = south + (i / N) * (north - south)
      const lon = west  + (j / N) * (east  - west)
      const ll  = map.latLngToContainerPoint([lat, lon])
      const value = idw(lat, lon, gridPoints, getVal)
      out.push({ x: ll.x, y: ll.y, value })
    }
  }
  return out
}

export function useOverlayCanvas(
  mapRef: React.MutableRefObject<LMap | null>,
  layer: LayerType,
  gridPoints: GridPoint[],
  seasonalData: SeasonalOutlook | null,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  const redraw = useCallback(() => {
    const canvas = canvasRef.current
    const map    = mapRef.current
    if (!canvas || !map) return

    const cont = map.getContainer()
    const W = cont.clientWidth  || canvas.width
    const H = cont.clientHeight || canvas.height
    if (!W || !H) return

    // Resize canvas if needed (avoids clearing unnecessarily)
    if (canvas.width !== W) canvas.width  = W
    if (canvas.height !== H) canvas.height = H

    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, W, H)

    if (layer === 'wind' || layer === 'satellite' || layer === 'hurricane') return

    // ── Seasonal outlook ──────────────────────────────────────
    if (layer === 'seasonal' && seasonalData) {
      const pts = seasonalData.trackDensity
        .filter(p => p.density > 0.02)
        .map(p => {
          const ll = map.latLngToContainerPoint([p.lat, p.lon])
          return { x: ll.x, y: ll.y, value: p.density }
        })
      drawSmoothField(canvas, pts, seasonColor, { blurPx: 18, radius: 70 })
      return
    }

    if (!gridPoints.length) return

    // ── Full-screen virtual grid (fills entire map view) ──────
    // Pixel spacing of virtual points
    const spacing = Math.max(W, H) / 32
    const radius  = Math.max(40, spacing * 1.2)

    const mapped = buildViewGrid(map, gridPoints, layer)

    // ── Cloud: white/grey blobs ────────────────────────────────
    if (layer === 'cloud') {
      const tmp = document.createElement('canvas')
      tmp.width = W; tmp.height = H
      const tctx = tmp.getContext('2d')!
      for (const { x, y, value } of mapped) {
        if (!value || value < 8) continue
        const a = Math.min(0.90, (value - 8) / 92)
        const g = Math.round(255 - value * 0.28)
        tctx.globalAlpha = a
        tctx.fillStyle   = `rgb(235,${g},255)`
        tctx.beginPath(); tctx.arc(x, y, radius, 0, Math.PI * 2); tctx.fill()
      }
      tctx.globalAlpha = 1
      ctx.save(); ctx.filter = 'blur(22px)'; ctx.drawImage(tmp, 0, 0); ctx.restore()
      return
    }

    let colorFn = tempColor
    if      (layer === 'heat')    colorFn = heatColor
    else if (layer === 'wave')    colorFn = waveColor
    else if (layer === 'rain')    colorFn = precipColor
    else if (layer === 'thunder') colorFn = thunderColor

    drawSmoothField(canvas, mapped, colorFn, { radius: radius * 0.8, blurPx: 18 })
  }, [layer, gridPoints, seasonalData, mapRef])

  const redrawRef = useRef(redraw)
  redrawRef.current = redraw

  // ── Redraw when layer or data changes ─────────────────────────
  useEffect(() => { redraw() }, [redraw])

  // ── Redraw on map pan / zoom ──────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const onMove  = () => redrawRef.current()
    const onStart = () => {
      const c = canvasRef.current
      c?.getContext('2d')?.clearRect(0, 0, c.width, c.height)
    }
    map.on('moveend zoomend', onMove)
    map.on('movestart zoomstart', onStart)
    return () => { map.off('moveend zoomend', onMove); map.off('movestart zoomstart', onStart) }
  }, [mapRef])

  // ── Redraw on container resize ────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const ro = new ResizeObserver(() => redrawRef.current())
    ro.observe(map.getContainer())
    return () => ro.disconnect()
  }, [mapRef])

  return { canvasRef, redraw }
}
