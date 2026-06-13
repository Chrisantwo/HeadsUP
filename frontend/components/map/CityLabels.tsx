'use client'
import { useEffect, useRef } from 'react'
import { useMapRef } from './MapWrapper'
import { useDashboard } from '@/hooks/useDashboardState'
import type { GridPoint, LayerType } from '@/lib/types'

interface City {
  name: string
  lat: number
  lon: number
  minZoom: number  // only show at this zoom level or higher
}

const CITIES: City[] = [
  // Luzon
  { name: 'Manila',         lat: 14.5995, lon: 120.9842, minZoom: 5 },
  { name: 'Quezon City',    lat: 14.6760, lon: 121.0437, minZoom: 7 },
  { name: 'Tarlac City',    lat: 15.4755, lon: 120.5960, minZoom: 6 },
  { name: 'Baguio',         lat: 16.4023, lon: 120.5960, minZoom: 6 },
  { name: 'Laoag',          lat: 18.1975, lon: 120.5937, minZoom: 6 },
  { name: 'Tuguegarao',     lat: 17.6132, lon: 121.7270, minZoom: 6 },
  { name: 'Legazpi',        lat: 13.1391, lon: 123.7438, minZoom: 6 },
  { name: 'Naga',           lat: 13.6218, lon: 123.1948, minZoom: 6 },
  { name: 'Lucena',         lat: 13.9394, lon: 121.6169, minZoom: 7 },
  { name: 'Batangas',       lat: 13.7565, lon: 121.0583, minZoom: 7 },
  { name: 'San Fernando',   lat: 15.0289, lon: 120.6897, minZoom: 7 },
  // Visayas
  { name: 'Cebu City',      lat: 10.3157, lon: 123.8854, minZoom: 5 },
  { name: 'Tacloban',       lat: 11.2543, lon: 125.0000, minZoom: 6 },
  { name: 'Iloilo',         lat: 10.6969, lon: 122.5644, minZoom: 6 },
  { name: 'Roxas City',     lat: 11.5854, lon: 122.7510, minZoom: 6 },
  { name: 'Bacolod',        lat: 10.6773, lon: 122.9561, minZoom: 6 },
  { name: 'Dumaguete',      lat: 9.3068,  lon: 123.3054, minZoom: 7 },
  { name: 'Ormoc',          lat: 11.0060, lon: 124.6080, minZoom: 7 },
  // Mindanao
  { name: 'Davao',          lat: 7.1907,  lon: 125.4553, minZoom: 5 },
  { name: 'Zamboanga',      lat: 6.9214,  lon: 122.0790, minZoom: 6 },
  { name: 'Cagayan de Oro', lat: 8.4542,  lon: 124.6319, minZoom: 6 },
  { name: 'Gen. Santos',    lat: 6.1164,  lon: 125.1716, minZoom: 6 },
  { name: 'Cotabato',       lat: 7.2047,  lon: 124.2310, minZoom: 7 },
  { name: 'Butuan',         lat: 8.9475,  lon: 125.5406, minZoom: 7 },
  { name: 'Iligan',         lat: 8.2280,  lon: 124.2452, minZoom: 7 },
  // Palawan / outlying
  { name: 'Puerto Princesa',lat: 9.7392,  lon: 118.7353, minZoom: 6 },
  { name: 'Taytay',         lat: 10.8122, lon: 119.5188, minZoom: 7 },
  // Nearby countries (visible when zoomed out)
  { name: 'Taipei',         lat: 25.0330, lon: 121.5654, minZoom: 5 },
  { name: 'Hong Kong',      lat: 22.3193, lon: 114.1694, minZoom: 5 },
  { name: 'Hanoi',          lat: 21.0285, lon: 105.8542, minZoom: 5 },
  { name: 'Ho Chi Minh',    lat: 10.8231, lon: 106.6297, minZoom: 5 },
  { name: 'Kuala Lumpur',   lat: 3.1390,  lon: 101.6869, minZoom: 5 },
  { name: 'Jakarta',        lat: -6.2088, lon: 106.8456, minZoom: 5 },
  { name: 'Guam',           lat: 13.4443, lon: 144.7937, minZoom: 5 },
]

// IDW interpolation for a single lat/lon from grid points
function idw(
  lat: number, lon: number,
  pts: GridPoint[],
  getValue: (p: GridPoint) => number | null,
  k = 6,
): number | null {
  const candidates = pts
    .map(p => ({ p, d2: (p.lat - lat) ** 2 + (p.lon - lon) ** 2 }))
    .sort((a, b) => a.d2 - b.d2)
    .slice(0, k)
  const valid = candidates.filter(c => getValue(c.p) !== null)
  if (!valid.length) return null
  if (valid[0].d2 < 0.01) return getValue(valid[0].p)
  let wSum = 0, vSum = 0
  for (const { p, d2 } of valid) {
    const w = 1 / d2; wSum += w; vSum += w * (getValue(p) as number)
  }
  return vSum / wSum
}

function getCityDisplay(
  city: City,
  layer: LayerType,
  pts: GridPoint[],
): string | null {
  if (!pts.length) return null

  let getValue: (p: GridPoint) => number | null
  let format: (v: number) => string

  switch (layer) {
    case 'temp':
      getValue = p => p.temp
      format   = v => `${v.toFixed(0)}°`
      break
    case 'heat':
      getValue = p => p.heat ?? p.temp
      format   = v => `${v.toFixed(0)}°`
      break
    case 'rain':
      getValue = p => p.precip
      format   = v => v < 0.5 ? '0 mm' : `${v.toFixed(1)} mm`
      break
    case 'cloud':
      getValue = p => p.cloud
      format   = v => `${v.toFixed(0)}%`
      break
    case 'wind':
      getValue = p => p.windSpeed !== null ? (p.windSpeed ?? 0) * 1.944 : null
      format   = v => `${v.toFixed(0)} kt`
      break
    case 'thunder': {
      getValue = p => {
        const c = p.cloud ?? 0; const r = p.precip ?? 0
        return Math.min(100, c * 0.6 + r * 18)
      }
      format = v => `${v.toFixed(0)}%`
      break
    }
    case 'wave':
      getValue = p => p.waveHeight
      format   = v => `${v.toFixed(1)} m`
      break
    default:
      // satellite / hurricane / seasonal — show temperature as default
      getValue = p => p.temp
      format   = v => v !== null ? `${v.toFixed(0)}°` : ''
      break
  }

  const val = idw(city.lat, city.lon, pts, getValue)
  if (val === null) return null
  return format(val)
}

function buildMarkers(
  L: typeof import('leaflet'),
  map: import('leaflet').Map,
  layer: LayerType,
  pts: GridPoint[],
  group: import('leaflet').LayerGroup,
) {
  const zoom = map.getZoom()
  for (const city of CITIES) {
    if (zoom < city.minZoom) continue
    const display   = getCityDisplay(city, layer, pts)
    const valueHtml = display ? `<span class="city-label-value">${display}</span>` : ''
    const icon = L.divIcon({
      className: '',
      html: `<div class="city-label"><span class="city-label-name">${city.name}</span>${valueHtml}</div>`,
      iconSize: [0, 0], iconAnchor: [0, 0],
    })
    L.marker([city.lat, city.lon], { icon, interactive: false }).addTo(group)
  }
}

export function CityLabels() {
  const mapRef    = useMapRef()
  const { state } = useDashboard()
  const { gridPoints, activeLayer } = state
  const groupRef  = useRef<import('leaflet').LayerGroup | null>(null)
  // stable refs so the zoom handler always sees latest values
  const dataRef   = useRef({ gridPoints, activeLayer })
  dataRef.current = { gridPoints, activeLayer }

  // ── Rebuild markers when data/layer changes ───────────────────
  useEffect(() => {
    let cancelled = false
    const map = mapRef.current
    if (!map) return

    import('leaflet').then((L) => {
      if (cancelled) return
      groupRef.current?.remove()
      if (!gridPoints.length) { groupRef.current = null; return }
      const group = L.layerGroup().addTo(map)
      groupRef.current = group
      buildMarkers(L, map, activeLayer, gridPoints, group)
    })

    return () => {
      cancelled = true
      groupRef.current?.remove()
      groupRef.current = null
    }
  }, [gridPoints, activeLayer, mapRef])

  // ── Refresh on zoom (separate effect, runs once) ──────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    let LCache: typeof import('leaflet') | null = null
    import('leaflet').then(L => { LCache = L })

    const onZoom = () => {
      if (!LCache) return
      groupRef.current?.remove()
      groupRef.current = null
      const { gridPoints: pts, activeLayer: layer } = dataRef.current
      if (!pts.length) return
      const group = LCache.layerGroup().addTo(map)
      groupRef.current = group
      buildMarkers(LCache, map, layer, pts, group)
    }

    map.on('zoomend', onZoom)
    return () => { map.off('zoomend', onZoom) }
  }, [mapRef])

  return null
}
