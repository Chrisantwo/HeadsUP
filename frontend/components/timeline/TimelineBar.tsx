'use client'
import { useState, useEffect, useMemo } from 'react'
import { Play, Pause, SkipBack, SkipForward, Sun, Cloud, CloudRain, Droplets } from 'lucide-react'
import { useDashboard } from '@/hooks/useDashboardState'
import { useTimeline } from '@/hooks/useTimeline'
import { STEP_HRS, API_BASE } from '@/lib/constants'

// ── Real 7-day forecast from Flask /api/weather/fullgrid ───────────────────
// We derive daily summaries from the same hourly dataset the map uses,
// so the cards and the overlay always show exactly the same data.
interface DayForecast {
  date: string
  tempMax: number | null
  tempMin: number | null
  precip: number | null   // daily total mm
  windMax: number | null  // km/h
  weatherCode: number | null
}

function makePlaceholderDays(): DayForecast[] {
  const base = new Date()
  return Array.from({ length: 7 }, (_, i) => ({
    date:        new Date(base.getTime() + i * 86_400_000).toISOString().slice(0, 10),
    tempMax: null, tempMin: null, precip: null, windMax: null, weatherCode: null,
  }))
}

function useDayForecasts(): DayForecast[] {
  const [days, setDays] = useState<DayForecast[]>(makePlaceholderDays)

  useEffect(() => {
    const ctrl = new AbortController()
    ;(async () => {
      try {
        const res = await fetch(`${API_BASE}/api/weather/fullgrid?region=par`, {
          signal: ctrl.signal, cache: 'no-store',
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = await res.json()
        if (json.status !== 'success') throw new Error('bad status')

        // Average across all grid points to get a PAR-region summary
        const pts: Array<{
          temp: (number|null)[]; heat: (number|null)[]; precip: (number|null)[]
          wind_speed: (number|null)[]; cloud: (number|null)[]
        }> = json.points

        const N_HRS = 168
        const base  = new Date()
        base.setUTCMinutes(0, 0, 0)

        const result: DayForecast[] = []
        for (let day = 0; day < 7; day++) {
          const startH = day * 24
          const endH   = Math.min(startH + 24, N_HRS)
          const d = new Date(base.getTime() + day * 86_400_000)
          const dateStr = d.toISOString().slice(0, 10)

          let sumTemp = 0, minTemp = Infinity, maxTemp = -Infinity
          let sumPrecip = 0, maxWind = 0, count = 0

          for (let h = startH; h < endH; h++) {
            for (const p of pts) {
              const t  = p.temp[h]
              const pr = p.precip[h]
              const ws = p.wind_speed[h]
              if (t  != null) { sumTemp += t; if (t < minTemp) minTemp = t; if (t > maxTemp) maxTemp = t; count++ }
              if (pr != null && pr > sumPrecip / Math.max(count,1)) sumPrecip += pr / pts.length
              if (ws != null && ws > maxWind) maxWind = ws
            }
          }

          result.push({
            date:        dateStr,
            tempMax:     maxTemp === -Infinity ? null : Math.round(maxTemp * 10) / 10,
            tempMin:     minTemp === Infinity  ? null : Math.round(minTemp * 10) / 10,
            precip:      sumPrecip > 0 ? Math.round(sumPrecip * 10) / 10 : 0,
            windMax:     maxWind > 0   ? Math.round(maxWind)            : null,
            weatherCode: null,   // derive from precip/wind below
          })
        }

        // Assign a simple weather code from precip+wind for icons
        result.forEach(r => {
          if (r.precip !== null && r.precip > 15)     r.weatherCode = 65   // heavy rain
          else if (r.precip !== null && r.precip > 3) r.weatherCode = 61   // light rain
          else if (r.windMax !== null && r.windMax > 50) r.weatherCode = 3  // overcast/windy
          else r.weatherCode = 0                                              // clear
        })

        setDays(result)
      } catch (err) {
        if ((err as Error).name === 'AbortError') return
        // Flask not running — build placeholder rows with real dates
        const base = new Date()
        setDays(Array.from({ length: 7 }, (_, i) => ({
          date:        new Date(base.getTime() + i * 86_400_000).toISOString().slice(0, 10),
          tempMax: null, tempMin: null, precip: null, windMax: null, weatherCode: null,
        })))
      }
    })()
    return () => ctrl.abort()
  }, [])

  return days
}

// ── WMO weather code → icon ────────────────────────────────────────────────
function WeatherIcon({ code, precip }: { code: number | null; precip: number | null }) {
  const sz = 13
  if (code === null) {
    return precip !== null && precip > 3
      ? <CloudRain size={sz} className="text-blue-400" />
      : <Sun size={sz} className="text-yellow-400" />
  }
  if (code >= 95) return <CloudRain size={sz} className="text-blue-300" />   // thunderstorm
  if (code >= 61) return <CloudRain size={sz} className="text-blue-400" />   // rain
  if (code >= 51) return <Droplets  size={sz} className="text-blue-300" />   // drizzle
  if (code >= 2)  return <Cloud     size={sz} className="text-slate-400" />  // partly-cloudy / overcast
  return <Sun size={sz} className="text-yellow-400" />                        // clear
}

// ── Date label helper ──────────────────────────────────────────────────────
function dayLabel(dateStr: string, todayStr: string, tmrwStr: string) {
  const d = new Date(dateStr + 'T00:00:00Z')
  const weekday  = d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }).toUpperCase()
  const monthDay = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  if (dateStr === todayStr) return { top: 'TODAY',  sub: monthDay }
  if (dateStr === tmrwStr)  return { top: 'TMRW',   sub: monthDay }
  return { top: weekday, sub: monthDay }
}

// ── Component ──────────────────────────────────────────────────────────────
export function TimelineBar() {
  const { state } = useDashboard()
  const { forecastHour, isPlaying, appMode, activeStorm } = state
  const { maxHour, togglePlay, stepBack, stepForward, jumpTo } = useTimeline()
  const dayForecasts = useDayForecasts()

  const now      = new Date()
  const todayStr = now.toISOString().slice(0, 10)
  const tmrwStr  = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10)

  // Anchor date for timeline (storm end or right now)
  const base = useMemo(() => {
    if (appMode === 'historical' && activeStorm) {
      const last = activeStorm.path[activeStorm.path.length - 1]
      try { return new Date(last.time.replace(' ', 'T') + ':00Z') } catch { /* fall through */ }
    }
    return new Date()
  }, [appMode, activeStorm])

  const currentDate = new Date(base.getTime() + forecastHour * 3_600_000)
  const timeStr = currentDate.toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC',
  }) + ' UTC'

  const activeDayIdx = Math.floor(forecastHour / 24)

  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-[900] select-none"
      style={{
        background: 'linear-gradient(180deg, rgba(8,12,32,0.98) 0%, rgba(5,8,25,1) 100%)',
        borderTop: '1px solid rgba(0,100,255,0.2)',
        boxShadow: '0 -6px 32px rgba(0,0,0,0.5)',
      }}
    >
      {/* ── Row 1: controls + current time ─────────────────────── */}
      <div className="flex items-center gap-3 px-4 pt-2.5 pb-1">
        {/* Play controls */}
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={stepBack}
            className="w-7 h-7 rounded flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
          >
            <SkipBack size={11} />
          </button>
          <button
            onClick={togglePlay}
            className="w-8 h-8 rounded-full flex items-center justify-center shadow-lg transition-colors"
            style={{ background: '#0052cc' }}
            onMouseEnter={e => (e.currentTarget.style.background = '#1a6ddd')}
            onMouseLeave={e => (e.currentTarget.style.background = '#0052cc')}
          >
            {isPlaying ? <Pause size={13} /> : <Play size={13} className="ml-0.5 text-white" />}
          </button>
          <button
            onClick={stepForward}
            className="w-7 h-7 rounded flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
          >
            <SkipForward size={11} />
          </button>
        </div>

        {/* Current time */}
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span className="text-sm font-bold text-white tabular-nums leading-none">{timeStr}</span>
          <span
            className="text-[9px] font-bold px-1.5 py-0.5 rounded font-mono tracking-wider flex-shrink-0"
            style={{
              background: forecastHour === 0 ? 'rgba(220,40,40,0.25)' : 'rgba(0,82,204,0.25)',
              color:       forecastHour === 0 ? '#ff6b6b'             : '#60aaff',
              border: `1px solid ${forecastHour === 0 ? 'rgba(220,40,40,0.4)' : 'rgba(0,82,204,0.4)'}`,
            }}
          >
            {forecastHour === 0 ? '● LIVE' : `+${forecastHour}h`}
          </span>
        </div>

        {/* Mode / storm label */}
        <div className="flex-shrink-0 text-right">
          <div className="text-[9px] text-slate-500 uppercase tracking-wider">
            {appMode === 'historical' ? 'Historical Track'
              : appMode === 'forecast'  ? 'AI Forecast'
              : '7-Day Forecast'}
          </div>
          {activeStorm && (
            <div className="text-[11px] font-bold text-blue-300 leading-tight">{activeStorm.name}</div>
          )}
        </div>
      </div>

      {/* ── Row 2: 7-day cards ──────────────────────────────────── */}
      <div className="flex gap-1.5 px-4 pb-1.5">
        {dayForecasts.map((day, i) => {
          const isActive = i === activeDayIdx
          const { top, sub } = dayLabel(day.date, todayStr, tmrwStr)
          const isToday = day.date === todayStr
          const hourInDay = forecastHour - i * 24
          const progress  = isActive ? Math.min(1, Math.max(0, hourInDay / 24)) : 0
          const isLoading = day.tempMax === null

          return (
            <button
              key={day.date}
              onClick={() => jumpTo(i * 24)}
              className="flex-1 flex flex-col items-center rounded-lg py-1.5 px-1 transition-all relative overflow-hidden"
              style={{
                background: isActive ? 'rgba(0,82,204,0.3)' : isToday ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.03)',
                border: isActive ? '1px solid rgba(0,140,255,0.5)' : isToday ? '1px solid rgba(255,255,255,0.12)' : '1px solid rgba(255,255,255,0.05)',
              }}
            >
              {/* Progress bar at bottom of card */}
              {isActive && (
                <div
                  className="absolute bottom-0 left-0 h-[2px] transition-all"
                  style={{ width: `${progress * 100}%`, background: 'linear-gradient(90deg,#0052cc,#00aaff)' }}
                />
              )}

              <span
                className="text-[9px] font-extrabold tracking-widest leading-none mb-px"
                style={{ color: isActive ? '#60aaff' : isToday ? '#aabbcc' : '#6b7a8d' }}
              >
                {top}
              </span>
              <span className="text-[8px] text-slate-600 mb-1 leading-none">{sub}</span>

              <WeatherIcon code={day.weatherCode} precip={day.precip} />

              {isLoading ? (
                <span className="text-[9px] text-slate-600 mt-0.5 animate-pulse">--°</span>
              ) : (
                <span className="text-[11px] font-bold mt-0.5 leading-none" style={{ color: isActive ? '#ffffff' : '#c8d4e0' }}>
                  {Math.round(day.tempMax!)}°
                  <span className="text-[8px] font-normal text-slate-500 ml-0.5">
                    /{day.tempMin !== null ? Math.round(day.tempMin) : '--'}°
                  </span>
                </span>
              )}

              {day.precip !== null && day.precip > 0.1 ? (
                <span className="text-[8px] text-blue-400 leading-none mt-px">
                  {day.precip >= 10 ? Math.round(day.precip) : day.precip.toFixed(1)}mm
                </span>
              ) : (
                <span className="text-[8px] text-slate-600 leading-none mt-px">{isLoading ? '…' : 'Dry'}</span>
              )}
            </button>
          )
        })}
      </div>

      {/* ── Row 3: hour scrubber ────────────────────────────────── */}
      <div className="px-4 pb-2.5">
        <input
          type="range"
          className="tl-slider"
          min={0} max={maxHour} step={STEP_HRS}
          value={forecastHour}
          onChange={e => jumpTo(Number(e.target.value))}
          style={{
            width: '100%',
            background: `linear-gradient(to right,
              #0088ff 0%,
              #0088ff ${maxHour > 0 ? (forecastHour / maxHour) * 100 : 0}%,
              rgba(255,255,255,0.12) ${maxHour > 0 ? (forecastHour / maxHour) * 100 : 0}%,
              rgba(255,255,255,0.12) 100%)`,
          }}
        />
      </div>
    </div>
  )
}
