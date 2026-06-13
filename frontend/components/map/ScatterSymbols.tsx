'use client'
import { useEffect, useRef, useCallback } from 'react'
import { useMapRef } from './MapWrapper'
import { useDashboard } from '@/hooks/useDashboardState'
import type { GridPoint, LayerType } from '@/lib/types'

const SCATTER_LAYERS: LayerType[] = ['thunder', 'rain', 'cloud', 'wind']
const GRID_SPACING = 38  // px between scatter points

// ── Nearest-neighbour value lookup (fast, good enough for symbols) ──
function nearestValue(
  lat: number, lon: number,
  pts: GridPoint[],
  getValue: (p: GridPoint) => number | null,
): number | null {
  let best: GridPoint | null = null
  let bestD = Infinity
  for (const p of pts) {
    const d = (p.lat - lat) ** 2 + (p.lon - lon) ** 2
    if (d < bestD) { bestD = d; best = p }
  }
  if (!best || bestD > 9) return null   // >~3° away → no data
  return getValue(best)
}

// ── Canvas drawing helpers ────────────────────────────────────────
function drawLightning(ctx: CanvasRenderingContext2D, x: number, y: number, sz: number) {
  ctx.beginPath()
  ctx.moveTo(x + sz * 0.22,  y - sz)
  ctx.lineTo(x - sz * 0.05,  y - sz * 0.05)
  ctx.lineTo(x + sz * 0.12,  y - sz * 0.05)
  ctx.lineTo(x - sz * 0.22,  y + sz)
  ctx.lineTo(x + sz * 0.05,  y + sz * 0.05)
  ctx.lineTo(x - sz * 0.12,  y + sz * 0.05)
  ctx.closePath()
  ctx.fill()
}

function drawRainDrop(ctx: CanvasRenderingContext2D, x: number, y: number, sz: number) {
  // Small diagonal slash — like Windy rain streaks
  ctx.beginPath()
  ctx.moveTo(x + sz * 0.3,  y - sz * 0.7)
  ctx.lineTo(x - sz * 0.3,  y + sz * 0.7)
  ctx.stroke()
}

function drawCloudDot(ctx: CanvasRenderingContext2D, x: number, y: number, sz: number) {
  ctx.beginPath()
  ctx.arc(x, y, sz * 0.45, 0, Math.PI * 2)
  ctx.fill()
}

function drawWindArrow(ctx: CanvasRenderingContext2D, x: number, y: number, sz: number, dir: number) {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate((dir * Math.PI) / 180)
  ctx.beginPath()
  ctx.moveTo(0, -sz)
  ctx.lineTo(sz * 0.35, sz * 0.4)
  ctx.lineTo(0, sz * 0.1)
  ctx.lineTo(-sz * 0.35, sz * 0.4)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

function drawSymbol(
  ctx: CanvasRenderingContext2D,
  layer: LayerType,
  x: number, y: number,
  value: number,
  windDir?: number | null,
) {
  const sz = 5.5

  if (layer === 'thunder') {
    const t = Math.min(1, Math.max(0, (value - 15) / 85))
    if (t < 0.05) return
    // Yellow lightning bolt
    ctx.globalAlpha = 0.25 + t * 0.60
    ctx.fillStyle   = `rgb(255,${Math.round(240 - t * 80)},${Math.round(60 - t * 60)})`
    drawLightning(ctx, x, y, sz)
  } else if (layer === 'rain') {
    const t = Math.min(1, Math.max(0, (value - 0.3) / 30))
    if (t < 0.05) return
    ctx.globalAlpha  = 0.20 + t * 0.55
    ctx.strokeStyle  = `rgba(120,200,255,1)`
    ctx.lineWidth    = 1.2
    drawRainDrop(ctx, x, y, sz)
  } else if (layer === 'cloud') {
    const t = Math.min(1, Math.max(0, (value - 20) / 80))
    if (t < 0.08) return
    ctx.globalAlpha = 0.12 + t * 0.30
    ctx.fillStyle   = `rgba(200,220,240,1)`
    drawCloudDot(ctx, x, y, sz)
  } else if (layer === 'wind') {
    const spd = value * 1.944   // m/s → kt
    const t = Math.min(1, Math.max(0, (spd - 3) / 50))
    if (t < 0.05) return
    ctx.globalAlpha = 0.18 + t * 0.45
    ctx.fillStyle   = `rgba(100,200,255,1)`
    drawWindArrow(ctx, x, y, sz * 0.9, windDir ?? 0)
  }
}

export function ScatterSymbols() {
  const mapRef     = useMapRef()
  const { state }  = useDashboard()
  const { activeLayer, gridPoints } = state
  const canvasRef  = useRef<HTMLCanvasElement | null>(null)

  const redraw = useCallback(() => {
    const canvas = canvasRef.current
    const map    = mapRef.current
    if (!canvas || !map) return

    const cont = map.getContainer()
    const W = cont.clientWidth, H = cont.clientHeight
    if (!W || !H) return
    if (canvas.width !== W)  canvas.width  = W
    if (canvas.height !== H) canvas.height = H

    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, W, H)

    if (!SCATTER_LAYERS.includes(activeLayer)) return
    if (!gridPoints.length) return

    // ── Build scatter grid ────────────────────────────────────────
    const getVal = (p: GridPoint): number | null => {
      if (activeLayer === 'thunder') {
        const c = p.cloud ?? 0; const r = p.precip ?? 0
        return Math.min(100, c * 0.6 + r * 18)
      }
      if (activeLayer === 'rain')  return p.precip
      if (activeLayer === 'cloud') return p.cloud
      if (activeLayer === 'wind')  return p.windSpeed
      return null
    }

    ctx.save()
    const cols = Math.ceil(W / GRID_SPACING) + 1
    const rows = Math.ceil(H / GRID_SPACING) + 1

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const px = col * GRID_SPACING + (row % 2) * (GRID_SPACING / 2)
        const py = row * GRID_SPACING

        const ll  = map.containerPointToLatLng([px, py])
        const val = nearestValue(ll.lat, ll.lng, gridPoints, getVal)
        if (val === null) continue

        const windDir = activeLayer === 'wind'
          ? nearestValue(ll.lat, ll.lng, gridPoints, p => p.windDir)
          : null

        ctx.globalAlpha = 1
        drawSymbol(ctx, activeLayer, px, py, val, windDir)
      }
    }

    ctx.restore()
  }, [activeLayer, gridPoints, mapRef])

  const redrawRef = useRef(redraw)
  redrawRef.current = redraw

  useEffect(() => { redraw() }, [redraw])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const onMove  = () => redrawRef.current()
    const onStart = () => canvasRef.current?.getContext('2d')?.clearRect(
      0, 0, canvasRef.current.width, canvasRef.current.height
    )
    map.on('moveend zoomend', onMove)
    map.on('movestart zoomstart', onStart)
    return () => { map.off('moveend zoomend', onMove); map.off('movestart zoomstart', onStart) }
  }, [mapRef])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const ro = new ResizeObserver(() => redrawRef.current())
    ro.observe(map.getContainer())
    return () => ro.disconnect()
  }, [mapRef])

  if (!SCATTER_LAYERS.includes(activeLayer)) return null

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 pointer-events-none"
      style={{ zIndex: 202 }}
    />
  )
}
