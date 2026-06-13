'use client'
import { useDashboard } from '@/hooks/useDashboardState'
import { LayerPill } from './LayerPill'
import { LAYER_META } from '@/lib/constants'
import type { LayerType, MapTheme } from '@/lib/types'

const LAYERS: LayerType[] = ['wind', 'rain', 'temp', 'heat', 'cloud', 'wave', 'thunder', 'hurricane', 'seasonal', 'satellite']
const THEMES: { key: MapTheme; label: string }[] = [
  { key: 'satellite', label: 'SAT' },
  { key: 'terrain',   label: 'MAP' },
  { key: 'dark',      label: 'DARK' },
]

export function RightPanel() {
  const { state, setLayer, dispatch } = useDashboard()
  const { activeLayer, mapTheme } = state
  const activeMeta = LAYER_META[activeLayer]

  return (
    <div
      className="absolute z-[800] flex flex-col"
      style={{
        top: 'calc(52px + 10px)',
        right: 12,
        width: 172,
        background: 'rgba(255,255,255,0.96)',
        borderRadius: 14,
        border: '1px solid rgba(0,82,204,0.13)',
        boxShadow: '0 8px 32px rgba(0,40,100,0.14), 0 1px 4px rgba(0,0,0,0.06)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div className="px-3 pt-3 pb-2 border-b border-slate-100">
        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-[1.2px]">
          Weather Layers
        </p>
        {/* Active layer description */}
        <p className="text-[11px] text-[#0052cc] font-semibold mt-0.5 leading-tight truncate">
          {activeMeta.label}
          {activeMeta.unit && (
            <span className="text-slate-400 font-normal ml-1">({activeMeta.unit})</span>
          )}
        </p>
      </div>

      {/* Layer pills */}
      <div className="px-1.5 py-1.5 flex flex-col gap-0.5">
        {LAYERS.map(l => (
          <LayerPill key={l} layer={l} active={activeLayer === l} onClick={setLayer} />
        ))}
      </div>

      {/* Map theme switcher */}
      <div className="px-2 pb-2.5 pt-1 border-t border-slate-100">
        <p className="text-[9px] font-semibold text-slate-300 uppercase tracking-widest mb-1.5 px-1">
          Base Map
        </p>
        <div className="flex gap-1">
          {THEMES.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => dispatch({ type: 'SET_MAP_THEME', theme: key })}
              className={`
                flex-1 text-[10px] font-bold py-1.5 rounded-lg border transition-all duration-150
                ${mapTheme === key
                  ? 'bg-[#0052cc] text-white border-[#0052cc] shadow-sm'
                  : 'bg-slate-50 text-slate-400 border-slate-200 hover:bg-slate-100 hover:text-slate-600'
                }
              `}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
