'use client'
import { useMapRef } from './MapWrapper'

export function ZoomControls() {
  const mapRef = useMapRef()

  const zoom = (delta: number) => {
    const map = mapRef.current
    if (!map) return
    map.setZoom(map.getZoom() + delta, { animate: true })
  }

  const btn = (label: string, delta: number, title: string) => (
    <button
      key={label}
      onClick={() => zoom(delta)}
      title={title}
      style={{
        width: 34, height: 34,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(255,255,255,0.97)',
        border: '1px solid rgba(0,82,204,0.18)',
        borderRadius: 8,
        boxShadow: '0 2px 8px rgba(0,30,80,0.13)',
        cursor: 'pointer',
        fontSize: 20, fontWeight: 700, lineHeight: 1,
        color: '#0052cc',
        transition: 'background 0.12s',
        userSelect: 'none',
      }}
      onMouseEnter={e => (e.currentTarget.style.background = '#e6f0ff')}
      onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.97)')}
    >
      {label}
    </button>
  )

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 112,        // above the timeline bar (~88px) with a gap
        right: 14,
        zIndex: 900,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      {btn('+', 1, 'Zoom in')}
      {btn('−', -1, 'Zoom out')}
    </div>
  )
}
