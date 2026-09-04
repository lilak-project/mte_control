import { useCallback, useMemo, useRef, useState } from "react"

/** The window a chart is showing, in seconds since the run started. */
export interface RunWindow {
  from: number
  to: number
}

/** Shortest window any control will produce. */
const MIN_SPAN = 10

/** The widths an operator asks for, shortest first. `null` is the whole run. */
export const RUN_PRESETS = [
  { id: "1m", label: "1 m", seconds: 60 },
  { id: "10m", label: "10 m", seconds: 600 },
  { id: "1h", label: "1 h", seconds: 3600 },
  { id: "all", label: "All", seconds: null as number | null },
]

export interface RunWindowControl {
  window: RunWindow
  presetId: string
  /** True while the right edge is pinned to the newest data there is. */
  follow: boolean
  span: number
  choosePreset: (id: string) => void
  setWindow: (from: number, to: number) => void
  pan: (fraction: number) => void
  zoom: (factor: number) => void
  reset: () => void
  atStart: boolean
  atEnd: boolean
}

/**
 * The x axis as a small state machine, on the module's own clock.
 *
 * There are only two things to know: how wide the window is, and whether its
 * right edge is pinned to the newest sample. Every control -- the presets, the
 * pan and zoom buttons, a drag on the chart -- is one of those two changing,
 * and "follow live" is simply the right edge being the end of the data rather
 * than a fixed instant. Holding it this way is what keeps zooming into a live
 * chart from fighting with the chart scrolling out from under you: the moment
 * you choose an end, following stops.
 *
 * `dataEnd` is the run clock of the newest sample -- not the wall clock. On a
 * finished run it stops moving on its own, which is exactly right: nothing
 * about that run is going to change again.
 */
export function useRunWindow(
  dataStart: number,
  dataEnd: number,
  defaultPreset = "10m",
  /**
   * Identifies the data underneath.  Change it and the window goes back to the
   * preset, forgetting any zoom or pan.
   *
   * The window is state, and state outlives a prop change: without this,
   * opening a twenty-second run after a four-hour one inherited the four-hour
   * one's window -- a fixed right edge and a span far wider than the new run,
   * so the chart came up showing a sliver, or nothing, of data that was
   * perfectly fine. A zoom is a statement about the run you were looking at,
   * and it should not survive the run changing.
   */
  resetKey: string = "",
): RunWindowControl {
  const [presetId, setPresetId] = useState(defaultPreset)
  const [span, setSpan] = useState<number>(
    () => RUN_PRESETS.find((preset) => preset.id === defaultPreset)?.seconds ?? 600,
  )
  /** null means "the newest sample": the window follows the run. */
  const [end, setEnd] = useState<number | null>(null)

  // Adjusted during render rather than in an effect, so the first paint after
  // the switch is already correct -- an effect would show one frame of the old
  // window over the new data.
  const [lastKey, setLastKey] = useState(resetKey)
  if (resetKey !== lastKey) {
    setLastKey(resetKey)
    setPresetId(defaultPreset)
    setSpan(RUN_PRESETS.find((preset) => preset.id === defaultPreset)?.seconds ?? 600)
    setEnd(null)
  }

  const follow = end === null
  const allSpan = Math.max(MIN_SPAN, dataEnd - dataStart)
  const effectiveSpan = presetId === "all" ? allSpan : span
  const right = end ?? dataEnd

  const window = useMemo<RunWindow>(() => {
    const to = right
    const from = to - effectiveSpan
    if (effectiveSpan >= dataEnd - dataStart) return { from: dataStart, to: dataEnd }
    if (from < dataStart) return { from: dataStart, to: dataStart + effectiveSpan }
    if (to > dataEnd) return { from: dataEnd - effectiveSpan, to: dataEnd }
    return { from, to }
  }, [right, effectiveSpan, dataStart, dataEnd])

  // Gestures read the live window without re-subscribing to it.
  const windowRef = useRef(window)
  windowRef.current = window
  const boundsRef = useRef({ start: dataStart, end: dataEnd })
  boundsRef.current = { start: dataStart, end: dataEnd }

  const choosePreset = useCallback((id: string) => {
    setPresetId(id)
    setEnd(null)
    const seconds = RUN_PRESETS.find((preset) => preset.id === id)?.seconds
    if (seconds != null) setSpan(seconds)
  }, [])

  /** Slide a window back inside the data, keeping its width. */
  const clamp = useCallback((from: number, to: number): [number, number] => {
    const width = Math.max(MIN_SPAN, to - from)
    const { start, end: last } = boundsRef.current
    if (width >= last - start) return [start, last]
    if (from < start) return [start, start + width]
    if (to > last) return [last - width, last]
    return [from, to]
  }, [])

  const setWindow = useCallback(
    (rawFrom: number, rawTo: number) => {
      const [from, to] = clamp(rawFrom, rawTo)
      setSpan(Math.max(MIN_SPAN, to - from))
      setPresetId("custom")
      // Reaching the live end is a request to follow again -- otherwise the
      // chart freezes the instant you look at the present.
      setEnd(to >= boundsRef.current.end - 1 ? null : to)
    },
    [clamp],
  )

  const pan = useCallback(
    (fraction: number) => {
      const { from, to } = windowRef.current
      const shift = (to - from) * fraction
      setWindow(from + shift, to + shift)
    },
    [setWindow],
  )

  const zoom = useCallback(
    (factor: number) => {
      const { from, to } = windowRef.current
      const width = Math.max(MIN_SPAN, (to - from) * factor)
      if (end === null) {
        // Zooming a live chart keeps the present on screen; it is what you are
        // watching. Only the amount of run behind it changes.
        setSpan(width)
        setPresetId("custom")
        return
      }
      const centre = (from + to) / 2
      setWindow(centre - width / 2, centre + width / 2)
    },
    [end, setWindow],
  )

  const reset = useCallback(() => {
    choosePreset(presetId === "custom" ? defaultPreset : presetId)
  }, [choosePreset, presetId, defaultPreset])

  return {
    window,
    presetId,
    follow,
    span: effectiveSpan,
    choosePreset,
    setWindow,
    pan,
    zoom,
    reset,
    atStart: window.from <= dataStart + 0.5,
    atEnd: window.to >= dataEnd - 0.5,
  }
}
