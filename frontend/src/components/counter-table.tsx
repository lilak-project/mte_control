import { Checkbox, Group, Paper, Stack, Text, Tooltip } from "@mantine/core"

import { formatCount, formatDuration, formatRate } from "@/lib/format"
import { MAX_SERIES, seriesColor } from "@/lib/palette"
import type { CounterRow } from "@/lib/types"

/**
 * The counter channels this profile reads, as one dense table.
 *
 * Both a count and a rate are given, never one. The count is what the module
 * reported for the last counting period, exactly; the rate is that divided by
 * the period. The period is a per-run setting, so a rate alone would silently
 * change meaning between runs and a count alone would not be comparable
 * across them.
 *
 * `Mean` is the average over the window chosen above the table -- the "average
 * over the last N seconds" the panel exists to show. `Run mean` is the same
 * over everything held in memory, which for a long run is the last day of it;
 * the two are side by side because a channel drifting shows up as the
 * difference between them.
 *
 * The rows are the profile's channels, not all ten. A table where six rows are
 * permanently zero teaches the operator to skim past it -- and the run's files
 * still hold every channel, so nothing is lost by not showing them here.
 */
export function CounterTable({
  rows,
  averageSeconds,
  selected,
  onSelect,
}: {
  rows: CounterRow[]
  averageSeconds: number
  /** Channels drawn on the chart, in the order they were picked. */
  selected: number[]
  onSelect: (channels: number[]) => void
}) {
  const full = selected.length >= MAX_SERIES

  const toggle = (channel: number) => {
    if (selected.includes(channel)) {
      onSelect(selected.filter((each) => each !== channel))
    } else if (!full) {
      onSelect([...selected, channel])
    }
  }

  if (rows.length === 0) {
    return (
      <Paper withBorder p="lg">
        <Text size="sm" c="dimmed" ta="center">
          This profile reads no counter channels. Tick some on the Profile tab — they are the ones
          numbered 11 to 20.
        </Text>
      </Paper>
    )
  }

  return (
    <Paper withBorder p={0} style={{ overflow: "hidden" }}>
      <table className="grid">
        <thead>
          <tr>
            <th className="col-ch">
              {/* All (as many as the chart draws) or none. */}
              <Tooltip label={selected.length ? "Draw none" : `Draw the first ${Math.min(MAX_SERIES, rows.length)}`}>
                <Checkbox
                  size="xs"
                  checked={selected.length > 0 && selected.length >= Math.min(MAX_SERIES, rows.length)}
                  indeterminate={selected.length > 0 && selected.length < Math.min(MAX_SERIES, rows.length)}
                  onChange={() => onSelect(selected.length ? [] : rows.slice(0, MAX_SERIES).map((row) => row.channel))}
                  aria-label={selected.length ? "Draw no channel" : "Draw every channel the chart can take"}
                />
              </Tooltip>
            </th>
            <th className="col-ch" style={{ textAlign: "left" }}>
              channel
            </th>
            <th>
              <Tooltip label="Counts in the last counting period, as the module reported them">
                <span>count</span>
              </Tooltip>
            </th>
            <th>rate /s</th>
            <th>mean ({formatDuration(averageSeconds)})</th>
            <th>mean rate /s</th>
            <th>min</th>
            <th>max</th>
            <th>run mean</th>
            <th>run mean /s</th>
            <th>samples</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const position = selected.indexOf(row.channel)
            const counting = (row.count ?? 0) > 0
            return (
              <tr key={row.channel}>
                <td className="col-ch">
                  <Checkbox
                    size="xs"
                    checked={position >= 0}
                    disabled={position < 0 && full}
                    onChange={() => toggle(row.channel)}
                    aria-label={`Draw channel ${row.channel} on the chart`}
                  />
                </td>
                <td className="col-ch" style={{ textAlign: "left" }}>
                  {/* Always there, hidden when not drawn: ticking never shifts the name. */}
                  <span
                    className={`swatch${position >= 0 ? "" : " off"}`}
                    style={position >= 0 ? { background: seriesColor(position) } : undefined}
                  />
                  <span className="tabular">{row.label}</span>
                </td>
                <td className={`tabular ${counting ? "live" : "quiet"}`}>
                  {formatCount(row.count)}
                </td>
                <td className={`tabular ${counting ? "" : "quiet"}`}>{formatRate(row.rate)}</td>
                <td className="tabular">{formatCount(row.mean)}</td>
                <td className="tabular">{formatRate(row.mean_rate)}</td>
                <td className="tabular dim">{formatCount(row.min)}</td>
                <td className="tabular dim">{formatCount(row.max)}</td>
                <td className="tabular">{formatCount(row.run_mean)}</td>
                <td className="tabular">{formatRate(row.run_mean_rate)}</td>
                <td className="tabular dim">{row.samples}</td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <Stack gap={2} p="xs">
        <Group gap="xs">
          <Text size="xs" c="dimmed">
            {rows[0]?.window_span
              ? `The mean columns cover the last ${formatDuration(rows[0].window_span)} of the run.`
              : "The mean columns fill in as the run goes."}
          </Text>
        </Group>
        {full ? (
          <Text size="xs" c="dimmed">
            Eight channels is the most the chart will draw at once — past that the colours stop
            being reliably distinguishable. Untick one to add another; every channel stays in the
            table regardless.
          </Text>
        ) : null}
      </Stack>
    </Paper>
  )
}
