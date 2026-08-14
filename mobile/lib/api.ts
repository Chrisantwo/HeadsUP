// ── Backend API client ──────────────────────────────────────────────
// Thin fetch helpers over the shared Flask backend. Every call has a
// timeout and surfaces a readable error so screens can show honest states.
import { API_BASE } from './config'
import type {
  RealtimeStormsResponse, MultiModelResponse, ModelPerformance,
  ClimateOutlook, ForecastStep, TrackPoint, ScenarioResponse,
} from './types'

const DEFAULT_TIMEOUT = 20000

async function request<T>(path: string, init?: RequestInit, timeout = DEFAULT_TIMEOUT): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const res = await fetch(`${API_BASE}${path}`, { ...init, signal: controller.signal })
    if (!res.ok) {
      let msg = `Request failed (${res.status})`
      try { msg = (await res.json())?.error ?? msg } catch { /* non-JSON */ }
      throw new Error(msg)
    }
    return (await res.json()) as T
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`No response from ${API_BASE}. If the phone can't connect, allow port 5000 through your PC's firewall and use the same Wi-Fi.`)
    }
    if (err instanceof TypeError) {
      throw new Error(`Can't reach the backend at ${API_BASE}. Is it running and on the same network?`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

function postJson(path: string, body: unknown, timeout?: number) {
  return { path, init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, timeout }
}

export const fetchStorms = () =>
  request<RealtimeStormsResponse>('/api/realtime-storms')

/** Historical storm track (+ per-step RF category) for the defense demo replay. */
export const fetchScenario = (name = 'goni') =>
  request<ScenarioResponse>(`/api/scenario?name=${encodeURIComponent(name)}`)

export const fetchModelPerformance = () =>
  request<ModelPerformance>('/api/analytics/model-performance')

export const fetchClimateOutlook = () =>
  request<ClimateOutlook>('/api/climate/outlook')

export function fetchMultiModel(stormName: string, trackHistory: TrackPoint[]) {
  const { path, init } = postJson('/api/multi-model-tracks', { storm_name: stormName, track_history: trackHistory })
  return request<MultiModelResponse>(path, init, 25000)
}

export interface SmartForecastResponse {
  status: string
  storm_name: string
  forecast_steps: ForecastStep[]
}

export function fetchForecast(stormName: string, trackHistory: TrackPoint[]) {
  const { path, init } = postJson('/api/forecast/smart', {
    storm_name: stormName, track_history: trackHistory, use_live: false,
  })
  return request<SmartForecastResponse>(path, init, 25000)
}
