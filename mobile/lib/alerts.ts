// ── PAR geo-fence alert computation ─────────────────────────────────
// Ported from the web app. Given active storms (and, when available, their
// forecast tracks) it classifies each against the PAR polygon and enriches it
// with the PAGASA wind signal, the storm's closest approach to Naga City, and a
// recommended action — so each alert is actionable and Bicol/Naga-focused.
import { distanceToParKm, firstParEntryHour, isInPar } from './par'
import { tcwsFromWind, type Tcws } from './tcws'
import type { LiveStorm, ForecastStep } from './types'

export type ParAlertStatus = 'inside' | 'approaching' | 'watch'

export interface ParAlert {
  storm: string
  status: ParAlertStatus
  category: number
  windKt: number
  etaHours: number | null
  distanceKm: number
  tcws: Tcws | null
  nagaEtaHours: number | null      // hour of closest approach to Naga (if it threatens)
  nagaDistanceKm: number | null    // closest-approach distance to Naga (km)
  action: string                   // recommended action for people in the path
}

const WATCH_DISTANCE_KM = 300
const NAGA = { lat: 13.62, lon: 123.18 }   // Naga City, Camarines Sur
const NAGA_THREAT_KM = 250                  // storm counts as "threatening Naga" within this

function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371, r = Math.PI / 180
  const dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

/** Closest approach of the storm (now + forecast) to Naga, or null if it stays
 *  farther than NAGA_THREAT_KM. */
function nagaApproach(lat: number, lon: number, fc: ForecastStep[]): { etaHours: number; distanceKm: number } | null {
  let best = haversineKm(NAGA.lat, NAGA.lon, lat, lon)
  let bestHour = 0
  for (const step of fc) {
    const d = haversineKm(NAGA.lat, NAGA.lon, step.lat, step.lon)
    if (d < best) { best = d; bestHour = step.hour }
  }
  return best <= NAGA_THREAT_KM ? { etaHours: bestHour, distanceKm: Math.round(best) } : null
}

/** Recommended action, keyed on the wind signal, alert status, and whether the
 *  track threatens Naga. Deliberately plain and imperative. */
export function recommendedAction(status: ParAlertStatus, tcws: Tcws | null, threatensNaga: boolean): string {
  const sig = tcws?.signal ?? 0
  if (sig >= 4) return threatensNaga
    ? 'Evacuate now to a safe shelter. Do not travel.'
    : 'Take shelter from destructive winds. Do not travel.'
  if (sig === 3) return 'Prepare to evacuate. Secure your home; avoid rivers, coasts and low-lying areas.'
  if (sig >= 1) return 'Ready an emergency kit and secure loose items. Monitor official updates.'
  if (status === 'inside' || status === 'approaching') return 'Monitor updates closely and prepare emergency supplies.'
  return 'Stay informed — a storm is near the PAR.'
}

export function computeParAlerts(
  storms: LiveStorm[],
  forecasts: Record<string, ForecastStep[]>,
): ParAlert[] {
  const alerts: ParAlert[] = []
  for (const s of storms) {
    const windKt = Math.round(s.wind_speed)
    const fc = forecasts[s.name] ?? []
    const tcws = tcwsFromWind(windKt)
    const naga = nagaApproach(s.lat, s.lon, fc)
    const base = {
      storm: s.name, category: s.category, windKt, tcws,
      nagaEtaHours: naga ? naga.etaHours : null,
      nagaDistanceKm: naga ? naga.distanceKm : null,
    }

    if (isInPar(s.lat, s.lon)) {
      alerts.push({
        ...base, status: 'inside', etaHours: null, distanceKm: 0,
        action: recommendedAction('inside', tcws, !!naga),
      })
      continue
    }
    const entry = fc.length ? firstParEntryHour(fc) : null
    const distanceKm = distanceToParKm(s.lat, s.lon)
    if (entry !== null) {
      alerts.push({
        ...base, status: 'approaching', etaHours: entry, distanceKm,
        action: recommendedAction('approaching', tcws, !!naga),
      })
    } else if (distanceKm <= WATCH_DISTANCE_KM) {
      alerts.push({
        ...base, status: 'watch', etaHours: null, distanceKm,
        action: recommendedAction('watch', tcws, !!naga),
      })
    }
  }
  const rank: Record<ParAlertStatus, number> = { inside: 0, approaching: 1, watch: 2 }
  return alerts.sort((a, b) => rank[a.status] - rank[b.status])
}

export function etaLabel(h: number): string {
  const d = Math.floor(h / 24), r = h % 24
  return d > 0 ? `~${d}d ${r}h` : `~${r}h`
}

export function alertHeadline(a: ParAlert): string {
  if (a.status === 'inside') return `${a.storm} has entered the PAR`
  if (a.status === 'approaching') return `${a.storm} may enter the PAR in ${etaLabel(a.etaHours ?? 0)}`
  return `${a.storm} is near the PAR boundary (${a.distanceKm} km)`
}
