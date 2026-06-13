'use client'
import type { HoverInfo } from '@/lib/types'
import { useDashboard } from '@/hooks/useDashboardState'

export function MapTooltip({ info }: { info: HoverInfo }) {
  const { state } = useDashboard()
  const { forecastHour, gridPoints } = state

  // Nearest grid point (for showing all weather metrics, not just active layer)
  const closest = gridPoints.length > 0
    ? gridPoints.reduce((best, p) =>
        Math.hypot(p.lat - info.lat, p.lon - info.lon) <
        Math.hypot(best.lat - info.lat, best.lon - info.lon) ? p : best
      )
    : null

  // Forecast date label
  const forecastDate = new Date(Date.now() + forecastHour * 3_600_000)
  const dateStr = forecastDate.toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC',
  }) + ' UTC'

  return (
    <div
      className="fixed z-[1100] pointer-events-none select-none"
      style={{ left: info.x + 16, top: info.y - 52 }}
    >
      <div
        className="flex flex-col gap-1 px-3 py-2 rounded-xl text-xs shadow-2xl"
        style={{
          background: 'rgba(6,10,30,0.97)',
          border: '1px solid rgba(0,120,255,0.35)',
          minWidth: 170,
          backdropFilter: 'blur(8px)',
        }}
      >
        {/* Forecast time + lead */}
        <div className="flex items-center justify-between gap-2">
          <span className="text-[9px] text-blue-300 font-mono tracking-wide">{dateStr}</span>
          <span
            className="text-[8px] font-bold px-1 py-0.5 rounded font-mono"
            style={{
              background: forecastHour === 0 ? 'rgba(220,40,40,0.25)' : 'rgba(0,82,204,0.25)',
              color:       forecastHour === 0 ? '#ff8080'             : '#80c0ff',
            }}
          >
            {forecastHour === 0 ? 'NOW' : `+${forecastHour}h`}
          </span>
        </div>

        {/* Coordinates */}
        <div className="text-[9px] text-slate-500 tabular-nums leading-none">
          {info.lat.toFixed(2)}°N &nbsp;{info.lon.toFixed(2)}°E
        </div>

        {/* Active layer value (prominent) */}
        <div className="border-t border-white/8 pt-1.5 mt-0.5">
          <div className="text-[9px] text-slate-400 uppercase tracking-widest mb-0.5">{info.label}</div>
          <div className="text-base font-extrabold text-white leading-none">
            {info.value}
            <span className="text-xs font-normal text-slate-400 ml-1">{info.unit}</span>
          </div>
        </div>

        {/* All-metrics row — shows what changes between days */}
        {closest && (
          <div className="grid grid-cols-4 gap-1 border-t border-white/8 pt-1.5 mt-0.5">
            <Metric label="TEMP"  value={closest.temp    != null ? `${closest.temp.toFixed(1)}°`    : '--'} color="#ffa040" />
            <Metric label="RAIN"  value={closest.precip  != null ? `${closest.precip.toFixed(1)}`   : '--'} color="#4db8ff" unit="mm" />
            <Metric label="CLOUD" value={closest.cloud   != null ? `${closest.cloud.toFixed(0)}%`   : '--'} color="#8ab0cc" />
            <Metric label="WIND"  value={closest.windSpeed!=null ? `${closest.windSpeed.toFixed(0)}` : '--'} color="#a0e0a0" unit="km/h" />
          </div>
        )}
      </div>
    </div>
  )
}

function Metric({ label, value, unit, color }: {
  label: string; value: string; unit?: string; color: string
}) {
  return (
    <div className="flex flex-col items-center">
      <span className="text-[7px] text-slate-500 uppercase tracking-wider leading-none mb-px">{label}</span>
      <span className="text-[10px] font-bold leading-none" style={{ color }}>{value}</span>
      {unit && <span className="text-[7px] text-slate-600 leading-none">{unit}</span>}
    </div>
  )
}
