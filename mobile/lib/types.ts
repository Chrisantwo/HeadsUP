// ── Shared API types (mirror the Flask backend) ─────────────────────

export interface TrackPoint { lat: number; lon: number; pressure?: number; wind_speed?: number }

export type Freshness = 'live' | 'delayed' | 'archive' | 'none'

export interface LiveStorm {
  name: string
  lat: number
  lon: number
  wind_speed: number
  pressure?: number
  category: number
  source?: string
  data_kind?: 'analysis' | 'best_track' | 'historical'
  observed_at?: string | null
  freshness?: Freshness
  age_hours?: number | null
  path?: TrackPoint[]
}

export interface RealtimeStormsResponse {
  status: string
  source: string
  freshness?: Freshness
  count: number
  storms: LiveStorm[]
  generated_at?: string
}

export interface ForecastStep { lat: number; lon: number; hour: number; wind_speed?: number }

export interface ScenarioResponse {
  status: string
  name: string
  display_name: string
  source: string
  points: { lat: number; lon: number; pressure: number; wind_speed: number }[]
  categories: number[]
  n: number
}

export interface ModelTrackPoint { lat: number; lon: number; hour: number; wind_kt: number | null }

export interface ModelTrack {
  model: string
  label: string
  agency: string
  color: string
  source: 'live' | 'mock'
  points: ModelTrackPoint[]
}

export interface MultiModelResponse {
  storm: string
  base_method: string
  models: ModelTrack[]
}

// ── Analytics ───────────────────────────────────────────────────────
export interface TrackMetricRow { n: number; rmse: number; mae: number; std: number; p50: number; p90: number }
export interface PerClassMetric { label: string; precision: number; recall: number; f1: number; support: number }

export interface ModelPerformance {
  mode: string
  train_years: number[]
  test_years: number[]
  n_test_storms: number
  track_metrics: Record<string, TrackMetricRow>
  skill_scores: Record<string, number>
  classification: { accuracy: number; macro_f1: number }
  per_class: PerClassMetric[]
  plots: Partial<Record<'confusion_matrix' | 'track_error_plot', string>>
  generated_at: string
}

export interface ClimateOutlook {
  status: string
  month: number
  month_name: string
  target_year: number
  n_years: number
  avg_storms: number
  max_storms: number
  max_year: number
  activity_level: string
  analogs: Array<{ year: number; storms: number }>
  forecast_text: string
}
