import { useEffect, useRef, useCallback } from 'react'
import { useDashboard } from './useDashboardState'
import { PLAY_MS, FCST_STEPS, STEP_HRS } from '@/lib/constants'

export function useTimeline() {
  const { state, setForecastHour, setPlaying } = useDashboard()
  const { isPlaying, forecastHour, appMode, activeStorm, forecastSteps } = state
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const totalSteps = appMode === 'historical'
    ? (activeStorm?.path.length ?? 1)
    : appMode === 'forecast'
      ? forecastSteps.length
      : FCST_STEPS

  const maxHour = (totalSteps - 1) * STEP_HRS

  const stopPlay = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    setPlaying(false)
  }, [setPlaying])

  const togglePlay = useCallback(() => {
    if (isPlaying) { stopPlay(); return }
    setPlaying(true)
  }, [isPlaying, stopPlay, setPlaying])

  const stepBack = useCallback(() => {
    stopPlay()
    setForecastHour(Math.max(0, forecastHour - STEP_HRS))
  }, [forecastHour, stopPlay, setForecastHour])

  const stepForward = useCallback(() => {
    stopPlay()
    setForecastHour(Math.min(maxHour, forecastHour + STEP_HRS))
  }, [forecastHour, maxHour, stopPlay, setForecastHour])

  const jumpTo = useCallback((hour: number) => {
    stopPlay()
    setForecastHour(Math.max(0, Math.min(maxHour, hour)))
  }, [maxHour, stopPlay, setForecastHour])

  // Playback interval — read forecastHour from a ref to avoid stale closure
  const hourRef = useRef(forecastHour)
  hourRef.current = forecastHour

  useEffect(() => {
    if (!isPlaying) { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null } ; return }
    timerRef.current = setInterval(() => {
      const next = hourRef.current + STEP_HRS
      if (next > maxHour) { setPlaying(false); return }
      setForecastHour(next)
    }, PLAY_MS)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [isPlaying, maxHour, setForecastHour, setPlaying])

  return { totalSteps, maxHour, togglePlay, stepBack, stepForward, jumpTo, stopPlay }
}
