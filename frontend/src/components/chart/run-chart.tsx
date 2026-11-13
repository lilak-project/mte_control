import { useEffect, useMemo, useRef } from "react"
import { useTheme } from "@neon"
import type uPlot from "uplot"

import { formatRunClock, formatTick } from "@/lib/format"
import { axisColor, chartFont, gridColor, seriesColor, surfaceColor, tickColor } from "@/lib/palette"
import type { SeriesChannel } from "@/lib/types"

import { toAligned } from "./chart-data"
import type { RunWindow } from "./use-run-window"
import { UplotChart } from "./uplot-react"
import { zoomPlugin } from "./zoom-plugin"


/**
 * Counts, or hits a second, against the run clock.
 *
 * One y scale, always. Counts per period and counts per second differ by a
 * constant -- the counting period -- so the caller converts and says which it
 * asked for in `unit`; two y axes on one chart would make two channels look
 * comparable when they are not on the same scale at all.
 */
export function RunChart({
  channels,
  window,
  unit,
  height = 300,
  loading = false,
  onRange,
  onReset,
  onPlot,
}: {
  channels: SeriesChannel[]
  window: RunWindow
  /** What the y axis is counting, written on it. */
  unit: string
  height?: number
  loading?: boolean
  onRange: (from: number, to: number) => void
  onReset: () => void
  onPlot?: (plot: uPlot) => void
}) {
  const plotRef = useRef<uPlot | null>(null)
  const windowRef = useRef(window)
  windowRef.current = window

  const theme = useTheme()
  const data = useMemo(() => toAligned(channels), [channels])

  // Everything uPlot cannot be told after it is built.
  const rebuildKey = useMemo(
    () => [unit, channels.map((channel) => channel.label).join("|")].join("~"),
    [unit, channels],
  )

  const options = useMemo<Omit<uPlot.Options, "width" | "height">>(
    () => ({
      cursor: {
        // uPlot draws the selection; the zoom plugin decides what it means, so
        // a drag can go back to the server for the samples inside it.
        drag: { x: true, y: false, setScale: false },
        points: { size: 8 },
      },
      // Live values at the crosshair, for every channel at once. It is the
      // legend and the tooltip in one, and it is also where the channel
      // numbers are written -- so identity is never carried by colour alone.
      legend: { live: true, markers: { width: 3 } },
      scales: {
        x: { time: false, auto: false },
        // Counts start at zero and a scaler channel that is quiet reads zero;
        // an axis that floated off the floor would hide exactly that.
        y: { auto: true, range: (_self, _min, max) => [0, max > 0 ? max * 1.05 : 1] },
      },
      axes: [
        {
          stroke: axisColor(),
          font: chartFont(),
          label: "run time",
          labelFont: chartFont(),
          grid: { stroke: gridColor(), width: 1 },
          ticks: { stroke: tickColor(), width: 1, size: 5 },
          values: (_self: uPlot, splits: number[]) => splits.map((at) => formatRunClock(at)),
        },
        {
          scale: "y",
          label: unit,
          labelFont: chartFont(),
          stroke: axisColor(),
          font: chartFont(),
          size: 64,
          grid: { stroke: gridColor(), width: 1 },
          ticks: { stroke: tickColor(), width: 1, size: 5 },
          values: (_self: uPlot, splits: number[]) => splits.map((value) => formatTick(value)),
        },
      ],
      series: [
        {
          label: "t",
          value: (_self: uPlot, value: number | null) =>
            value == null || !Number.isFinite(value) ? "—" : formatRunClock(value),
        },
        ...channels.map((channel, position) => ({
          label: channel.label,
          scale: "y",
          stroke: seriesColor(position),
          width: 2,
          // Drawn through the gaps a channel that fired in no part of a second
          // leaves behind, so a quiet moment does not cut the trace in two.
          spanGaps: true,
          points: {
            // uPlot decides when the samples are far enough apart to be worth
            // marking; the ring in the surface colour keeps them legible where
            // two channels cross.
            size: 8,
            width: 2,
            stroke: surfaceColor(),
            fill: seriesColor(position),
          },
          value: (_self: uPlot, value: number | null) =>
            value == null ? "—" : formatTick(value),
        })),
      ],
      plugins: [zoomPlugin({ onRange, onReset })],
    }),
    // theme: canvas colours are read when the options are built.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [channels, unit, onRange, onReset, theme],
  )

  // The window is owned outside the chart, so it is pushed in rather than
  // being whatever the data happens to span.
  useEffect(() => {
    plotRef.current?.setScale("x", { min: window.from, max: window.to })
  }, [window])

  return (
    <div
      // Refetching keeps the frame: the previous render stays up, dimmed,
      // rather than collapsing to a skeleton and jumping the layout.
      style={{ opacity: loading ? 0.65 : 1, transition: "opacity 120ms linear" }}
    >
      <UplotChart
        data={data}
        options={options}
        rebuildKey={rebuildKey}
        height={height}
        onCreate={(plot) => {
          plotRef.current = plot
          onPlot?.(plot)
          const { from, to } = windowRef.current
          plot.setScale("x", { min: from, max: to })
        }}
      />
    </div>
  )
}
