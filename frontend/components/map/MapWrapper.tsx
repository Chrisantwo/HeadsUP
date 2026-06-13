'use client'
import {
  useEffect, useRef, useState, createContext, useContext,
  type ReactNode, type MutableRefObject,
} from 'react'
import type { Map as LMap, TileLayer, Layer } from 'leaflet'
import { MAP_TILES, PAR, CAT_COLOR } from '@/lib/constants'
import { useDashboard } from '@/hooks/useDashboardState'
import type { StormCategory } from '@/lib/types'

// ── Map context (shares the Leaflet instance with child hooks) ──
type MapCtx = MutableRefObject<LMap | null>
const MapContext = createContext<MapCtx>({ current: null })
export const useMapRef = () => useContext(MapContext)

// ── Helper: build pulse icon HTML ───────────────────────────────
function pulseIconHtml(color: string) {
  return `
    <div style="position:relative;width:44px;height:44px;">
      <div class="pulse-r1" style="position:absolute;inset:0;border-radius:50%;border:2px solid ${color}60;"></div>
      <div class="pulse-r2" style="position:absolute;width:28px;height:28px;top:8px;left:8px;border-radius:50%;border:2px solid ${color}99;"></div>
      <div style="position:absolute;width:12px;height:12px;top:16px;left:16px;border-radius:50%;background:${color};box-shadow:0 0 10px 4px ${color}70;"></div>
    </div>`
}

// ── MapWrapper ──────────────────────────────────────────────────
export function MapWrapper({ children }: { children?: ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef       = useRef<LMap | null>(null)
  const tileRef      = useRef<TileLayer | null>(null)
  const markerRef    = useRef<Layer | null>(null)
  const bgGroupRef   = useRef<import('leaflet').LayerGroup | null>(null)
  const [ready, setReady] = useState(false)

  const { state } = useDashboard()
  const { mapTheme, activeStorm } = state

  // ── Init Leaflet on mount ─────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current
    if (!container || mapRef.current) return
    // Guard: if Leaflet already stamped this DOM node (StrictMode remount race)
    if ((container as HTMLElement & { _leaflet_id?: number })._leaflet_id) return

    import('leaflet').then(L => {
      // Re-check after async resolution (StrictMode unmounts between import and .then)
      if (mapRef.current) return
      if ((container as HTMLElement & { _leaflet_id?: number })._leaflet_id) return

      // Fix missing default icons in webpack bundles
      delete (L.Icon.Default.prototype as { _getIconUrl?: unknown })._getIconUrl
      L.Icon.Default.mergeOptions({
        iconRetinaUrl:'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
        iconUrl:      'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
        shadowUrl:    'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
      })

      const map = L.map(container, {
        center: [13, 122.5], zoom: 5,
        preferCanvas: true,
        zoomControl: false,          // replaced by React ZoomControls component
        attributionControl: false,
        scrollWheelZoom: true,       // explicit — mouse wheel zooms the map
      })

      L.control.attribution({ position: 'bottomright', prefix: false }).addTo(map)

      // PAR boundary rectangle
      L.rectangle([[PAR.latMin, PAR.lonMin],[PAR.latMax, PAR.lonMax]], {
        color:'#0052cc', weight:1.5, opacity:0.35,
        fill:false, dashArray:'7,10', interactive:false,
      }).addTo(map)

      bgGroupRef.current = L.layerGroup().addTo(map)
      mapRef.current = map
      setReady(true)
    })

    return () => { mapRef.current?.remove(); mapRef.current = null; setReady(false) }
  }, [])

  // ── Switch tile layer when mapTheme changes ───────────────────
  useEffect(() => {
    if (!mapRef.current) return
    import('leaflet').then(L => {
      if (tileRef.current) { tileRef.current.remove() }
      const cfg = MAP_TILES[mapTheme]
      tileRef.current = L.tileLayer(cfg.url, {
        attribution: cfg.attr, maxZoom: cfg.maxZoom,
        ...(cfg.sub ? { subdomains: cfg.sub } : {}),
      }).addTo(mapRef.current!)
    })
  }, [mapTheme, ready])

  // ── Storm marker ──────────────────────────────────────────────
  useEffect(() => {
    if (!mapRef.current || !ready) return
    import('leaflet').then(L => {
      if (markerRef.current) { markerRef.current.remove(); markerRef.current = null }
      if (!activeStorm) return

      const last = activeStorm.path[activeStorm.path.length - 1]
      const cat  = last.category as StormCategory
      const icon = L.divIcon({
        className: '',
        html: pulseIconHtml(CAT_COLOR[cat]),
        iconSize: [44,44], iconAnchor: [22,22],
      })
      markerRef.current = L.marker([last.lat, last.lon], { icon, zIndexOffset: 1000 })
        .bindTooltip(`${activeStorm.name} · ${last.windSpeed.toFixed(0)} kt · ${last.pressure.toFixed(0)} hPa`)
        .addTo(mapRef.current!)
    })
  }, [activeStorm, ready])

  // ── Background tracks (year-load) ─────────────────────────────
  useEffect(() => {
    if (!mapRef.current || !ready) return
    const grp = bgGroupRef.current
    if (!grp) return
    grp.clearLayers()
    if (!activeStorm) return

    import('leaflet').then(L => {
      const path = activeStorm.path
      if (path.length < 2) return
      for (let i = 0; i < path.length - 1; i++) {
        const pt = path[i]
        L.polyline(
          [[pt.lat, pt.lon], [path[i+1].lat, path[i+1].lon]],
          { color: CAT_COLOR[pt.category as StormCategory], weight: 3, opacity: 0.9 }
        ).addTo(grp)
      }
    })
  }, [activeStorm, ready])

  return (
    <MapContext.Provider value={mapRef}>
      <div ref={containerRef} className="absolute inset-0 z-0" />
      {ready && children}
    </MapContext.Provider>
  )
}
