'use client'
import { useEffect } from 'react'
import { DashboardProvider, useDashboard } from '@/hooks/useDashboardState'
import { useWeatherData } from '@/hooks/useWeatherData'
import { MapWrapper } from './map/MapWrapper'
import { WindParticleCanvas } from './map/WindParticleCanvas'
import { WeatherOverlayCanvas } from './map/WeatherOverlayCanvas'
import { ZoomControls } from './map/ZoomControls'
import { HurricaneTracker } from './map/HurricaneTracker'
import { CityLabels } from './map/CityLabels'
import { ScatterSymbols } from './map/ScatterSymbols'
import { RightPanel } from './sidebar/RightPanel'
import { TimelineBar } from './timeline/TimelineBar'
import { MapTooltip } from './MapTooltip'

// ── Inner shell (has access to Dashboard context) ─────────────
function DashboardShell() {
  useWeatherData()   // keep grid data in sync with forecastHour

  const { state } = useDashboard()
  const { hoverInfo } = state

  // Clock in topbar
  useEffect(() => {
    const el = document.getElementById('utc-clock')
    if (!el) return
    const tick = () => { el.textContent = new Date().toUTCString().slice(0, 25).replace('GMT','UTC') }
    tick()
    const id = setInterval(tick, 15_000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="relative w-full h-screen overflow-hidden">
      {/* ── Full-screen Leaflet map ─────────────────────────── */}
      <MapWrapper>
        <WindParticleCanvas />
        <WeatherOverlayCanvas />
        <HurricaneTracker />
        <CityLabels />
        <ScatterSymbols />
        <ZoomControls />
      </MapWrapper>

      {/* ── Top bar ──────────────────────────────────────────── */}
      <header
        className="fixed top-0 left-0 right-0 z-[900] flex items-center gap-4 px-4"
        style={{
          height: 52, background: 'rgba(255,255,255,0.97)',
          borderBottom: '3px solid #0052cc',
          boxShadow: '0 2px 12px rgba(0,40,100,0.12)',
        }}
      >
        {/* Brand */}
        <div className="flex items-center gap-2.5 flex-shrink-0">
          <svg className="w-7 h-7 text-[#0052cc]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M12 2a10 10 0 1 0 10 10"/>
            <path d="M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8"/>
            <path d="M12 2v3M12 19v3M3 12H6M18 12h3"/>
          </svg>
          <div className="flex flex-col leading-tight">
            <span className="text-sm font-extrabold text-slate-800 tracking-tight">Storm Forecasting</span>
            <span className="text-[9px] text-slate-400 uppercase tracking-widest">Real-Time PAR · Western Pacific</span>
          </div>
        </div>

        {/* Center status */}
        <div className="flex-1 text-center">
          <span id="topbar-status" className="text-xs text-slate-400">
            PAR Weather · 7-Day Forecast — Select a storm or scrub the timeline
          </span>
        </div>

        {/* Right: clock + live badge */}
        <div className="flex items-center gap-3 flex-shrink-0">
          <span id="utc-clock" className="text-[11px] text-slate-400 tabular-nums" />
          <span
            className="live-badge text-[9px] font-bold tracking-widest text-white px-2 py-0.5 rounded"
            style={{ background: '#cc2200' }}
          >
            LIVE
          </span>
        </div>
      </header>

      {/* ── Side panels ────────────────────────────────────────── */}
      <RightPanel />

      {/* ── PAR label ───────────────────────────────────────────── */}
      <div
        className="fixed text-[10px] tracking-[3px] uppercase font-semibold pointer-events-none"
        style={{ top: 80, right: 200, color: 'rgba(0,80,220,0.4)', zIndex: 700 }}
      >
        PAR
      </div>

      {/* ── Bottom timeline ──────────────────────────────────────── */}
      <TimelineBar />

      {/* ── Hover tooltip ────────────────────────────────────────── */}
      {hoverInfo && <MapTooltip info={hoverInfo} />}
    </div>
  )
}

// ── Root export (wraps context provider) ─────────────────────
export default function Dashboard() {
  return (
    <DashboardProvider>
      <DashboardShell />
    </DashboardProvider>
  )
}
