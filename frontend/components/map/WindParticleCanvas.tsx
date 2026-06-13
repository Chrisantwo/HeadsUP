'use client'
import { useEffect } from 'react'
import { useMapRef } from './MapWrapper'
import { useWindEngine } from '@/hooks/useWindEngine'
import { useDashboard } from '@/hooks/useDashboardState'

export function WindParticleCanvas() {
  const mapRef  = useMapRef()
  const { state } = useDashboard()
  // Wind always runs; full speed on wind layer, dimmed on others
  const active  = true
  const { canvasRef, setGrid, clearTrails } = useWindEngine(mapRef, active)
  const opacity = state.activeLayer === 'wind' ? 1
    : state.activeLayer === 'satellite' || state.activeLayer === 'hurricane' ? 0
    : 0.65

  // Feed wind grid into the engine whenever it updates
  useEffect(() => {
    if (state.windGrid) setGrid(state.windGrid)
  }, [state.windGrid, setGrid])

  // Clear trails on map move
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    map.on('movestart zoomstart', clearTrails)
    return () => { map.off('movestart zoomstart', clearTrails) }
  }, [mapRef, clearTrails])

  // Size the canvas to fill the map container
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const cont = mapRef.current?.getContainer()
    if (!cont) return
    const resize = () => { canvas.width = cont.clientWidth; canvas.height = cont.clientHeight }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(cont)
    return () => ro.disconnect()
  }, [canvasRef, mapRef])

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 pointer-events-none"
      style={{ zIndex: 201, opacity, transition: 'opacity 0.4s ease' }}
    />
  )
}
