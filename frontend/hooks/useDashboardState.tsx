'use client'
import React, {
  createContext, useContext, useReducer, useCallback,
  type ReactNode, type Dispatch,
} from 'react'
import type { DashboardState, DashboardAction, LayerType, MapTheme, Storm, ForecastStep, GridPoint, WindGrid, SeasonalOutlook, HoverInfo } from '@/lib/types'
import { generateWeatherGrid, generateWindGrid } from '@/lib/mockData'

// ── Initial state ─────────────────────────────────────────
const initialState: DashboardState = {
  activeLayer: 'wind',
  mapTheme: 'dark',
  forecastHour: 0,
  isPlaying: false,
  appMode: 'idle',
  selectedYear: 2024,
  availableStorms: [],
  activeStorm: null,
  forecastSteps: [],
  gridPoints: generateWeatherGrid(0),
  windGrid: generateWindGrid(0),
  seasonalData: null,
  hoverInfo: null,
}

// ── Reducer ───────────────────────────────────────────────
function reducer(state: DashboardState, action: DashboardAction): DashboardState {
  switch (action.type) {
    case 'SET_LAYER': {
      // Auto-switch map theme to match layer type
      const darkLayers = ['rain','thunder','cloud','hurricane','wave']
      const lightLayers = ['temp','heat','seasonal']
      const newTheme = darkLayers.includes(action.layer) ? 'dark'
        : lightLayers.includes(action.layer) ? 'terrain'
        : state.mapTheme
      return { ...state, activeLayer: action.layer, mapTheme: newTheme }
    }
    case 'SET_MAP_THEME':
      return { ...state, mapTheme: action.theme }
    case 'SET_FORECAST_HOUR':
      return { ...state, forecastHour: action.hour }
    case 'SET_PLAYING':
      return { ...state, isPlaying: action.playing }
    case 'SET_YEAR':
      return { ...state, selectedYear: action.year }
    case 'SET_STORM_LIST':
      return { ...state, availableStorms: action.storms }
    case 'SET_ACTIVE_STORM':
      return { ...state, activeStorm: action.storm, appMode: action.storm ? 'historical' : 'idle' }
    case 'SET_APP_MODE':
      return { ...state, appMode: action.mode }
    case 'SET_FORECAST_STEPS':
      return { ...state, forecastSteps: action.steps, appMode: 'forecast' }
    case 'SET_GRID_POINTS':
      return { ...state, gridPoints: action.points }
    case 'SET_WIND_GRID':
      return { ...state, windGrid: action.grid }
    case 'SET_SEASONAL_DATA':
      return { ...state, seasonalData: action.data }
    case 'SET_HOVER':
      return { ...state, hoverInfo: action.info }
    case 'CLEAR_HOVER':
      return { ...state, hoverInfo: null }
    default:
      return state
  }
}

// ── Context ───────────────────────────────────────────────
type ContextValue = {
  state: DashboardState
  dispatch: Dispatch<DashboardAction>
  setLayer:       (l: LayerType)  => void
  setMapTheme:    (t: MapTheme)   => void
  setForecastHour:(h: number)     => void
  setPlaying:     (p: boolean)    => void
  setActiveStorm: (s: Storm|null) => void
  setForecastSteps:(steps: ForecastStep[]) => void
  setGridPoints:  (pts: GridPoint[])       => void
  setWindGrid:    (g: WindGrid)            => void
  setSeasonalData:(d: SeasonalOutlook|null)=> void
  setHover:       (info: HoverInfo)        => void
  clearHover:     ()                       => void
}

const DashboardContext = createContext<ContextValue | null>(null)

export function DashboardProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState)

  const setLayer        = useCallback((layer: LayerType)       => dispatch({ type:'SET_LAYER', layer }), [])
  const setMapTheme     = useCallback((theme: MapTheme)        => dispatch({ type:'SET_MAP_THEME', theme }), [])
  const setForecastHour = useCallback((hour: number)           => dispatch({ type:'SET_FORECAST_HOUR', hour }), [])
  const setPlaying      = useCallback((playing: boolean)       => dispatch({ type:'SET_PLAYING', playing }), [])
  const setActiveStorm  = useCallback((storm: Storm|null)      => dispatch({ type:'SET_ACTIVE_STORM', storm }), [])
  const setForecastSteps= useCallback((steps: ForecastStep[]) => dispatch({ type:'SET_FORECAST_STEPS', steps }), [])
  const setGridPoints   = useCallback((points: GridPoint[])   => dispatch({ type:'SET_GRID_POINTS', points }), [])
  const setWindGrid     = useCallback((grid: WindGrid)         => dispatch({ type:'SET_WIND_GRID', grid }), [])
  const setSeasonalData = useCallback((data: SeasonalOutlook|null) => dispatch({ type:'SET_SEASONAL_DATA', data }), [])
  const setHover        = useCallback((info: HoverInfo)        => dispatch({ type:'SET_HOVER', info }), [])
  const clearHover      = useCallback(()                       => dispatch({ type:'CLEAR_HOVER' }), [])

  return (
    <DashboardContext.Provider value={{
      state, dispatch,
      setLayer, setMapTheme, setForecastHour, setPlaying,
      setActiveStorm, setForecastSteps, setGridPoints, setWindGrid,
      setSeasonalData, setHover, clearHover,
    }}>
      {children}
    </DashboardContext.Provider>
  )
}

export function useDashboard() {
  const ctx = useContext(DashboardContext)
  if (!ctx) throw new Error('useDashboard must be inside DashboardProvider')
  return ctx
}
