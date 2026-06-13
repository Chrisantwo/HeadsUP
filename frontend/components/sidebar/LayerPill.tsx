'use client'
import { LAYER_META } from '@/lib/constants'
import type { LayerType } from '@/lib/types'

interface Props {
  layer: LayerType
  active: boolean
  onClick: (l: LayerType) => void
}

export function LayerPill({ layer, active, onClick }: Props) {
  const meta = LAYER_META[layer]

  return (
    <button
      onClick={() => onClick(layer)}
      title={meta.description}
      className={`
        group relative flex items-center gap-2.5 w-full px-3 py-[7px] rounded-lg
        text-[12px] font-medium border transition-all duration-150 text-left
        ${active
          ? 'bg-[#e6f0ff] border-[#0052cc] text-[#0052cc] font-semibold shadow-sm'
          : 'bg-transparent border-transparent text-slate-500 hover:bg-slate-100/80 hover:text-slate-700'
        }
      `}
    >
      {/* Coloured indicator dot */}
      <span
        className={`w-[9px] h-[9px] rounded-full flex-shrink-0 transition-transform duration-150 ${active ? 'scale-110' : ''}`}
        style={{ background: meta.dot, boxShadow: active ? `0 0 6px ${meta.dot}99` : 'none' }}
      />
      {meta.label}

      {/* Active tick mark */}
      {active && (
        <span className="ml-auto w-1.5 h-1.5 rounded-full bg-[#0052cc] flex-shrink-0" />
      )}
    </button>
  )
}
