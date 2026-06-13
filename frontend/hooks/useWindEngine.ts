import { useEffect, useRef } from 'react'
import type { WindGrid } from '@/lib/types'
import { PAR, WEATHER_BOUNDS, GRID_N } from '@/lib/constants'
import { windColor } from '@/lib/colors'
import type { Map as LMap } from 'leaflet'

const N_PART    = 3500
const MAX_AGE   = 260
const SPD_SCALE = 0.006
const FADE      = 0.028

interface Particle { lat: number; lon: number; age: number }

const BOUNDS = WEATHER_BOUNDS   // particles cover full WP region

function newParticle(rnd = false): Particle {
  return {
    lat: BOUNDS.latMin + Math.random() * (BOUNDS.latMax - BOUNDS.latMin),
    lon: BOUNDS.lonMin + Math.random() * (BOUNDS.lonMax - BOUNDS.lonMin),
    age: rnd ? Math.floor(Math.random() * MAX_AGE) : 0,
  }
}

function bilerp(grid: number[][], lat: number, lon: number): number {
  const ty = (lat - BOUNDS.latMin) / (BOUNDS.latMax - BOUNDS.latMin) * (GRID_N - 1)
  const tx = (lon - BOUNDS.lonMin) / (BOUNDS.lonMax - BOUNDS.lonMin) * (GRID_N - 1)
  const i = Math.floor(ty), j = Math.floor(tx)
  if (i < 0 || i >= GRID_N - 1 || j < 0 || j >= GRID_N - 1) return 0
  const fy = ty - i, fx = tx - j
  return (
    (1-fy)*((1-fx)*grid[i][j]   + fx*grid[i][j+1]) +
    fy   *((1-fx)*grid[i+1][j] + fx*grid[i+1][j+1])
  )
}

/**
 * Manages the wind particle canvas animation loop.
 * Returns refs for the canvas element and a function to set the wind grid.
 */
export function useWindEngine(
  mapRef: React.MutableRefObject<LMap | null>,
  active: boolean,
) {
  const canvasRef  = useRef<HTMLCanvasElement | null>(null)
  const gridRef    = useRef<WindGrid | null>(null)
  const partsRef   = useRef<Particle[]>(Array.from({ length: N_PART }, () => newParticle(true)))
  const rafRef     = useRef<number | null>(null)
  const activeRef  = useRef(active)

  activeRef.current = active

  const setGrid = (g: WindGrid) => { gridRef.current = g }

  const clearTrails = () => {
    const c = canvasRef.current
    c?.getContext('2d')?.clearRect(0, 0, c.width, c.height)
  }

  useEffect(() => {
    if (!active) { clearTrails(); if (rafRef.current) cancelAnimationFrame(rafRef.current); return }

    if (!mapRef.current) return
    // Non-null assertion so the type is LMap (not LMap|null) inside the frame closure
    const mapInst = mapRef.current as NonNullable<typeof mapRef.current>

    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!

    const cosLat = Math.cos(((PAR.latMin + PAR.latMax) / 2) * Math.PI / 180)

    function frame() {
      if (!activeRef.current) return
      const W = canvas!.width, H = canvas!.height

      ctx.globalCompositeOperation = 'destination-out'
      ctx.fillStyle = `rgba(0,0,0,${FADE})`
      ctx.fillRect(0, 0, W, H)
      ctx.globalCompositeOperation = 'source-over'

      const grid = gridRef.current
      const parts = partsRef.current

      for (const p of parts) {
        p.age++
        if (p.age > MAX_AGE) { Object.assign(p, newParticle()); continue }

        const u = grid ? bilerp(grid.u, p.lat, p.lon) : 0
        const v = grid ? bilerp(grid.v, p.lat, p.lon) : 0
        const spd = Math.hypot(u, v)

        const pt0 = mapInst.latLngToContainerPoint([p.lat, p.lon])

        if (spd > 0.05) {
          const sc = SPD_SCALE * (0.3 + 0.7 * Math.min(spd / 20, 1))
          p.lon += (u / spd) * sc / cosLat
          p.lat += (v / spd) * sc
        }

        if (p.lat < BOUNDS.latMin || p.lat > BOUNDS.latMax || p.lon < BOUNDS.lonMin || p.lon > BOUNDS.lonMax) {
          Object.assign(p, newParticle()); continue
        }

        const pt1 = mapInst.latLngToContainerPoint([p.lat, p.lon])
        const dx = pt1.x - pt0.x, dy = pt1.y - pt0.y
        if (dx*dx + dy*dy < 0.04) continue

        const life  = 1 - p.age / MAX_AGE
        // Bright flash when young, fades smoothly — simulates lightning streaks
        const alpha = Math.max(0.04, life < 0.15 ? 1.0 : 0.95 * life)
        const [r, g, b] = windColor(spd * 1.94)  // m/s → kt

        // Outer glow pass (wider, dimmer)
        ctx.strokeStyle = `rgba(${r},${g},${b},${alpha * 0.28})`
        ctx.lineWidth   = 4.0
        ctx.beginPath(); ctx.moveTo(pt0.x, pt0.y); ctx.lineTo(pt1.x, pt1.y); ctx.stroke()

        // Core bright pass (narrow, vivid)
        ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`
        ctx.lineWidth   = 1.4
        ctx.beginPath(); ctx.moveTo(pt0.x, pt0.y); ctx.lineTo(pt1.x, pt1.y); ctx.stroke()
      }

      rafRef.current = requestAnimationFrame(frame)
    }

    rafRef.current = requestAnimationFrame(frame)
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [active, mapRef])

  return { canvasRef, setGrid, clearTrails }
}
