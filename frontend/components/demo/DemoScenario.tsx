'use client'
import { Play, Pause, SkipForward, X, Clapperboard } from 'lucide-react'
import { useDemoScenario } from '@/hooks/useDemoScenario'
import { useDashboard } from '@/hooks/useDashboardState'

// Floating "Demo Scenario" control + honest banner. Replays GONI (Rolly) 2020
// through the real alert pipeline to prove the app warns on PAR entry / Naga.
export function DemoScenario() {
  const demo = useDemoScenario()
  const { setLayer } = useDashboard()

  // ── Not active: a single labelled launch button ──────────────────────────
  if (!demo.active) {
    return (
      <button
        onClick={() => { setLayer('hurricane'); demo.start() }}
        disabled={demo.loading}
        className="fixed z-[1000] left-3 bottom-[150px] flex items-center gap-1.5
                   rounded-lg px-3 py-2 text-[12px] font-bold text-white shadow-lg
                   transition-colors disabled:opacity-60"
        style={{ background: 'linear-gradient(90deg,#7c3aed,#a21caf)' }}
        title="Play a historical typhoon (GONI/Rolly 2020) to demonstrate PAR alerts"
      >
        <Clapperboard size={14} />
        {demo.loading ? 'Loading demo…' : 'Demo Scenario'}
      </button>
    )
  }

  const speeds = [1, 2, 4]

  return (
    <>
      {/* Persistent honesty banner */}
      <div
        className="fixed z-[1001] left-1/2 -translate-x-1/2 top-[58px] flex items-center gap-2
                   rounded-full px-4 py-1 text-[11px] font-bold text-white shadow-lg animate-pulse"
        style={{ background: 'linear-gradient(90deg,#7c3aed,#a21caf)' }}
      >
        🎬 DEMO SCENARIO — historical replay: {demo.displayName}
      </div>

      {/* Control panel */}
      <div
        className="fixed z-[1001] left-3 bottom-[150px] w-[260px] rounded-xl p-3 text-white shadow-2xl"
        style={{ background: 'rgba(20,16,34,0.96)', border: '1px solid rgba(160,120,255,0.4)' }}
      >
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[12px] font-extrabold tracking-wide flex items-center gap-1.5">
            <Clapperboard size={13} /> Demo Scenario
          </span>
          <button onClick={demo.stop} title="Exit demo (restore live)"
            className="text-slate-300 hover:text-white"><X size={15} /></button>
        </div>

        <div className="text-[11px] text-violet-200 font-semibold">{demo.displayName}</div>
        <div className="text-[11px] mt-0.5 font-bold"
          style={{ color: demo.statusLabel.startsWith('LANDFALL') ? '#ff6b6b'
            : demo.statusLabel.startsWith('INSIDE') ? '#ffd166' : '#9ecbff' }}>
          {demo.statusLabel || '—'}
        </div>

        {/* progress */}
        <div className="mt-2 h-1.5 rounded bg-white/15 overflow-hidden">
          <div className="h-full bg-violet-400"
            style={{ width: `${demo.total > 0 ? Math.round((demo.index / demo.total) * 100) : 0}%` }} />
        </div>
        <div className="text-[9px] text-slate-400 mt-0.5 tabular-nums">
          step {Math.max(0, demo.index)} / {Math.max(0, demo.total)}
        </div>

        {/* controls */}
        <div className="flex items-center gap-1.5 mt-2">
          {demo.playing ? (
            <button onClick={demo.pause}
              className="flex-1 flex items-center justify-center gap-1 rounded-md py-1.5 text-[11px] font-bold bg-white/10 hover:bg-white/20">
              <Pause size={13} /> Pause
            </button>
          ) : (
            <button onClick={demo.play}
              className="flex-1 flex items-center justify-center gap-1 rounded-md py-1.5 text-[11px] font-bold bg-violet-600 hover:bg-violet-500">
              <Play size={13} /> Play
            </button>
          )}
          <button onClick={demo.step} title="Step one 3-hour step"
            className="flex items-center justify-center rounded-md py-1.5 px-2 bg-white/10 hover:bg-white/20">
            <SkipForward size={13} />
          </button>
        </div>

        {/* speed */}
        <div className="flex items-center gap-1 mt-2">
          <span className="text-[9px] text-slate-400 mr-0.5">Speed</span>
          {speeds.map(s => (
            <button key={s} onClick={() => demo.setSpeed(s)}
              className={`text-[10px] font-bold rounded px-2 py-0.5 ${
                demo.speed === s ? 'bg-violet-500 text-white' : 'bg-white/10 text-slate-300 hover:bg-white/20'}`}>
              {s}×
            </button>
          ))}
        </div>
      </div>
    </>
  )
}
