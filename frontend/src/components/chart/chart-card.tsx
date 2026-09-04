import { useCallback, useMemo } from "react"
import { Group, Paper, Stack, Text } from "@mantine/core"

import { formatCount } from "@/lib/format"
import type { SeriesChannel } from "@/lib/types"

import { ChartBoundary } from "./chart-boundary"
import { pointCounts } from "./chart-data"
import { RangeControls } from "./range-controls"
import { RunChart } from "./run-chart"
import { useRunWindow } from "./use-run-window"

/**
 * A chart with its window controls and its own honesty line.
 *
 * The line under the chart says how many of the samples in the window are
 * actually drawn. On a long run that is a fraction, and a reader who does not
 * know that will read the smoothness of a decimated trace as a property of the
 * beam rather than of the plot.
 */
export function ChartCard({
  title,
  channels,
  unit,
  dataStart,
  dataEnd,
  loading,
  defaultPreset,
  empty,
  onWindow,
  right,
  height,
  resetKey,
}: {
  title: string
  channels: SeriesChannel[]
  unit: string
  /** Bounds of the run clock, in seconds. */
  dataStart: number
  dataEnd: number
  loading?: boolean
  defaultPreset?: string
  /** Shown instead of the chart when there is nothing to draw. */
  empty?: string
  /** Told the window whenever it moves, so the owner can refetch it. */
  onWindow?: (from: number, to: number) => void
  right?: React.ReactNode
  height?: number
  /** Identifies the data: change it and the window forgets its zoom. */
  resetKey?: string
}) {
  const range = useRunWindow(dataStart, dataEnd, defaultPreset, resetKey)
  const { shown, total } = useMemo(() => pointCounts(channels), [channels])

  const { window, setWindow, reset } = range
  const onRange = useCallback(
    (from: number, to: number) => {
      setWindow(from, to)
      onWindow?.(from, to)
    },
    [setWindow, onWindow],
  )
  const onReset = useCallback(() => {
    reset()
    onWindow?.(dataStart, dataEnd)
  }, [reset, onWindow, dataStart, dataEnd])

  const hasData = channels.some((channel) => channel.t.length > 0)

  return (
    <Paper withBorder p="md" radius="md">
      <Stack gap="sm">
        <Group justify="space-between" align="center" wrap="wrap" gap="sm">
          <Text fw={600}>{title}</Text>
          <Group gap="sm" wrap="wrap">
            {right}
            <RangeControls range={range} />
          </Group>
        </Group>

        {hasData ? (
          <ChartBoundary>
            <RunChart
              channels={channels}
              window={window}
              unit={unit}
              loading={loading}
              onRange={onRange}
              onReset={onReset}
              height={height}
            />
          </ChartBoundary>
        ) : (
          <Text c="dimmed" size="sm" py="xl" ta="center">
            {empty ?? "Nothing to draw yet."}
          </Text>
        )}

        <Text size="xs" c="dimmed">
          {shown === total
            ? `${formatCount(total)} points, all drawn`
            : `${formatCount(shown)} of ${formatCount(total)} points drawn — ` +
              "each bucket keeps its highest and lowest sample, so no spike is lost"}
          {" · drag to zoom, shift-drag to pan, double-click to go back"}
        </Text>
      </Stack>
    </Paper>
  )
}
