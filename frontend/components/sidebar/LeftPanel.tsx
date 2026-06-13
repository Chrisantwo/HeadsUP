'use client'
import { useState, useEffect } from 'react'
import {
  Wind, Gauge, MapPin, Clock, Activity,
  ChevronRight, ChevronLeft,
} from 'lucide-react'
import { useDashboard } from '@/hooks/useDashboardState'
import { getStormsForYear, convertToStorm } from '@/lib/stormData'
import { CAT_COLOR, CAT_NAME, CAT_LABEL, API_BASE } from '@/lib/constants'
import type { HistoricalStorm, StormCategory, ForecastStep } from '@/lib/types'

const CAT_MAP: Record<string, StormCategory> = {
  TD: 0, TS: 1, TY: 2, STY3: 3, STY4: 4, STY5: 5,
}

function windToCat(ws: number): StormCategory {
  if (ws < 34) return 0; if (ws < 64) return 1; if (ws < 96) return 2
  if (ws < 113) return 3; if (ws < 137) return 4; return 5
}

function StatRow({ icon, label, value, color }: {
  icon: React.ReactNode; label: string; value: string; color?: string
}) {
  return (
    <div className="flex items-center justify-between py-1">
      <div className="flex items-center gap-1.5 text-[10px] text-slate-400 uppercase tracking-wide">
        {icon}{label}
      </div>
      <span className="text-xs font-semibold" style={{ color: color ?? '#1a2744' }}>{value}</span>
    </div>
  )
}

export function LeftPanel() {
  const { state, setActiveStorm, setForecastSteps, dispatch } = useDashboard()
  const { activeStorm, appMode, forecastHour, forecastSteps } = state

  const [year, setYear]             = useState(2024)
  const [storms, setStorms]         = useState<HistoricalStorm[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [forecasting, setForecasting] = useState(false)

  // Auto-load storms whenever year changes
  useEffect(() => {
    setStorms(getStormsForYear(year))
    setSelectedId(null)
    setActiveStorm(null)
    setForecastSteps([])
  }, [year]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSelectStorm = (hs: HistoricalStorm) => {
    setSelectedId(hs.id)
    const converted = convertToStorm(hs)
    setActiveStorm(converted)
    setForecastSteps([])
  }

  const handleRunForecast = async () => {
    if (!activeStorm) return
    setForecasting(true)

    // Use last 16 track points (48 h of 3-hourly data) as forecast seed
    const trackHistory = activeStorm.path.slice(-16).map(p => ({
      lat: p.lat,
      lon: p.lon,
      pressure: p.pressure,
      wind_speed: p.windSpeed,
    }))

    try {
      const res = await fetch(`${API_BASE}/api/forecast/smart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storm_name: activeStorm.name, track_history: trackHistory }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const steps: ForecastStep[] = (data.forecast_steps as Array<{
        hour: number; lat: number; lon: number; wind_speed: number; pressure: number
      }>).map(s => ({
        lat: s.lat,
        lon: s.lon,
        hour: s.hour,
        windSpeed: s.wind_speed,
        pressure: s.pressure,
      }))
      setForecastSteps(steps)
      dispatch({ type: 'SET_APP_MODE', mode: 'forecast' })
    } catch {
      // Flask unavailable — fall back to physics-like extrapolation
      const last = activeStorm.path[activeStorm.path.length - 1]
      const steps: ForecastStep[] = Array.from({ length: 56 }, (_, i) => ({
        lat:       Math.min(38, last.lat + 0.22 * i + (Math.random() - 0.4) * 0.1),
        lon:       Math.max(100, last.lon - 0.15 * i + (Math.random() - 0.3) * 0.1),
        hour:      (i + 1) * 3,
        windSpeed: Math.max(18, last.windSpeed - i * 0.6 + (Math.random() - 0.4) * 2),
        pressure:  Math.min(1013, last.pressure + i * 0.5),
      }))
      setForecastSteps(steps)
      dispatch({ type: 'SET_APP_MODE', mode: 'forecast' })
    } finally {
      setForecasting(false)
    }
  }

  // Current telemetry depends on mode
  const currentPoint = appMode === 'forecast' && forecastSteps.length
    ? forecastSteps[Math.floor(forecastHour / 3)]
    : activeStorm?.path[activeStorm.path.length - 1]

  const cat = currentPoint ? windToCat(currentPoint.windSpeed) : null

  const MIN_YEAR = 2013
  const MAX_YEAR = 2026

  return (
    <div
      className="absolute z-[800] flex flex-col gap-0 overflow-y-auto"
      style={{
        top: 'calc(52px + 10px)', left: 12, width: 276,
        maxHeight: 'calc(100vh - 52px - 112px - 24px)',
        background: 'rgba(255,255,255,0.94)',
        borderRadius: 12, border: '1px solid rgba(0,82,204,0.15)',
        boxShadow: '0 4px 20px rgba(0,40,100,0.15)',
        backdropFilter: 'blur(6px)',
        padding: 14,
      }}
    >
      {/* Header */}
      <div className="mb-3">
        <p className="text-[10px] font-bold text-[#0052cc] uppercase tracking-widest mb-0.5">
          Historical Storm Browser
        </p>
        <p className="text-[10px] text-slate-400 mb-3">IBTrACS Archive 2013–2026</p>

        {/* Year selector with chevron buttons */}
        <div className="flex items-center justify-between mb-3">
          <button
            onClick={() => setYear(y => Math.max(MIN_YEAR, y - 1))}
            disabled={year <= MIN_YEAR}
            className="w-7 h-7 flex items-center justify-center rounded-md border border-slate-200 bg-white hover:bg-blue-50 hover:border-blue-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            aria-label="Previous year"
          >
            <ChevronLeft size={14} className="text-slate-600" />
          </button>

          <div className="flex flex-col items-center">
            <span className="text-[9px] text-slate-400 uppercase tracking-wider">Year</span>
            <span className="text-base font-extrabold text-[#0052cc]">{year}</span>
          </div>

          <button
            onClick={() => setYear(y => Math.min(MAX_YEAR, y + 1))}
            disabled={year >= MAX_YEAR}
            className="w-7 h-7 flex items-center justify-center rounded-md border border-slate-200 bg-white hover:bg-blue-50 hover:border-blue-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            aria-label="Next year"
          >
            <ChevronRight size={14} className="text-slate-600" />
          </button>
        </div>

        {/* Storm card list */}
        <div
          className="flex flex-col gap-1.5 overflow-y-auto"
          style={{ maxHeight: 220 }}
        >
          {storms.length === 0 && (
            <p className="text-[10px] text-slate-400 text-center py-3">No storms on record for {year}</p>
          )}
          {storms.map(hs => {
            const catNum = CAT_MAP[hs.category] ?? 2
            const isSelected = hs.id === selectedId
            return (
              <button
                key={hs.id}
                onClick={() => handleSelectStorm(hs)}
                className="w-full text-left rounded-lg px-2.5 py-2 transition-all"
                style={{
                  background: isSelected ? `${CAT_COLOR[catNum as StormCategory]}18` : 'rgba(248,250,255,0.9)',
                  border: isSelected
                    ? `1.5px solid ${CAT_COLOR[catNum as StormCategory]}88`
                    : '1px solid rgba(0,82,204,0.08)',
                  boxShadow: isSelected ? `0 0 0 1px ${CAT_COLOR[catNum as StormCategory]}33` : 'none',
                }}
              >
                <div className="flex items-center gap-2">
                  {/* Category badge */}
                  <span
                    className="text-[8px] font-bold uppercase px-1.5 py-0.5 rounded flex-shrink-0"
                    style={{
                      background: `${CAT_COLOR[catNum as StormCategory]}22`,
                      color:       CAT_COLOR[catNum as StormCategory],
                      border:     `1px solid ${CAT_COLOR[catNum as StormCategory]}55`,
                    }}
                  >
                    {hs.category}
                  </span>
                  {/* Name */}
                  <span className="text-xs font-bold text-slate-800 tracking-wide flex-1 truncate">
                    {hs.name}
                  </span>
                  {/* Month indicator */}
                  <span className="text-[9px] text-slate-400 flex-shrink-0">
                    {new Date(hs.year, hs.month - 1).toLocaleString('en', { month: 'short' })}
                  </span>
                </div>
                <div className="flex items-center gap-3 mt-0.5 pl-0.5">
                  <span className="text-[9px] text-slate-400">
                    <span className="font-semibold text-slate-600">{hs.maxWinds}</span> kt
                  </span>
                  <span className="text-[9px] text-slate-400">
                    <span className="font-semibold text-slate-600">{hs.minPressure}</span> hPa
                  </span>
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {/* Storm telemetry */}
      {activeStorm && currentPoint && cat !== null && (
        <>
          <div className="h-px bg-blue-100 mb-3" />
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <span
              className="text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded"
              style={{
                background: `${CAT_COLOR[cat]}22`,
                color:       CAT_COLOR[cat],
                border:     `1px solid ${CAT_COLOR[cat]}55`,
              }}
            >
              {appMode === 'forecast' ? 'AI Forecast' : 'Historical'}
            </span>
            <h2 className="text-base font-extrabold text-slate-800 tracking-wide">
              {activeStorm.name}
            </h2>
          </div>

          <div className="flex flex-col gap-0.5 mb-3">
            <StatRow
              icon={<Activity size={10} />} label="Category"
              value={`${CAT_LABEL[cat]} — ${CAT_NAME[cat]}`}
              color={CAT_COLOR[cat]}
            />
            <StatRow
              icon={<MapPin size={10} />} label="Position"
              value={`${currentPoint.lat.toFixed(2)}°N, ${currentPoint.lon.toFixed(2)}°E`}
            />
            <StatRow
              icon={<Gauge size={10} />} label="Pressure"
              value={`${currentPoint.pressure.toFixed(0)} hPa`}
            />
            <StatRow
              icon={<Wind size={10} />} label="Max Winds"
              value={`${currentPoint.windSpeed.toFixed(0)} kt  (${(currentPoint.windSpeed * 0.514).toFixed(1)} m/s)`}
            />
            <StatRow
              icon={<Clock size={10} />} label="Time / Lead"
              value={appMode === 'forecast' ? `+${forecastHour}h` : (currentPoint as { time?: string }).time ?? '--'}
            />
          </div>

          {/* Wind speed colour bar */}
          <div className="flex items-center gap-2 mb-3">
            <span className="text-[9px] text-slate-400">Calm</span>
            <div className="flex-1 h-1.5 rounded"
              style={{ background: 'linear-gradient(to right,#0350c8,#00c8ff,#00e646,#ffe600,#ff7800,#ff1e1e)' }} />
            <span className="text-[9px] text-slate-400">80 kt</span>
          </div>

          {/* Action buttons */}
          <div className="flex flex-col gap-2">
            {appMode !== 'forecast' && (
              <button
                onClick={handleRunForecast}
                disabled={forecasting}
                className="w-full py-2.5 text-xs font-bold rounded-lg bg-[#0052cc] text-white hover:bg-blue-700 disabled:opacity-60 flex items-center justify-center gap-2 transition-colors shadow-sm"
              >
                {forecasting
                  ? <><span className="w-3 h-3 border border-white/30 border-t-white rounded-full animate-spin" />Running…</>
                  : <><ChevronRight size={14} />Run 7-Day AI Forecast + Ensemble</>
                }
              </button>
            )}
            {appMode === 'forecast' && (
              <button
                onClick={() => { setForecastSteps([]); dispatch({ type: 'SET_APP_MODE', mode: 'historical' }) }}
                className="w-full py-2 text-xs font-semibold rounded-lg bg-blue-50 text-[#0052cc] border border-blue-200 hover:bg-blue-100 transition-colors"
              >
                ← Back to Historical Track
              </button>
            )}
          </div>
        </>
      )}

      {/* Category legend */}
      <div className="mt-auto pt-3 border-t border-blue-100">
        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
          {([0, 1, 2, 3, 4, 5] as StormCategory[]).map(c => (
            <div key={c} className="flex items-center gap-1.5 text-[10px] text-slate-400">
              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: CAT_COLOR[c] }} />
              {CAT_LABEL[c]}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
