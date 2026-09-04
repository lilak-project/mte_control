import { Paper, Stack, Text } from "@mantine/core"

import { formatCount, formatDuration, formatRate, formatRunClock } from "@/lib/format"
import type { StampRow } from "@/lib/types"

/**
 * The time-stamp channels: how often each one fired.
 *
 * The time-stamp file is one line per event, and a channel can write tens of
 * thousands a second. The individual times are not what anyone reads -- the
 * rate is -- so the events are counted into one-second bins as they are parsed
 * and this table is those bins. The last few raw event times are kept anyway,
 * in the right-hand column, because "is this channel firing at all" is a
 * question a bin count answers badly at low rates.
 *
 * Channels appear here as they fire. A channel with no row has produced no
 * time stamp, which is a real and useful thing to see.
 */
export function StampTable({
  rows,
  averageSeconds,
  monitor,
}: {
  rows: StampRow[]
  averageSeconds: number
  /** Monitor mode has no per-channel breakdown; see the note below. */
  monitor: boolean
}) {
  if (rows.length === 0) {
    return (
      <Paper withBorder p="lg">
        <Text size="sm" c="dimmed" ta="center">
          This profile reads no trigger channels. Tick some on the Profile tab — they are the ones
          numbered 1 to 10.
        </Text>
      </Paper>
    )
  }

  const unexpected = rows.filter((row) => !row.expected && row.total > 0)

  return (
    <Paper withBorder p={0} style={{ overflow: "hidden" }}>
      <table className="grid">
        <thead>
          <tr>
            <th className="col-ch" style={{ textAlign: "left" }}>
              channel
            </th>
            <th>events</th>
            <th title="Hits in the last second that finished">rate /s (1 s)</th>
            <th title="Hits per second over the ten complete seconds before now">rate /s (10 s)</th>
            <th>rate /s ({formatDuration(averageSeconds)})</th>
            <th>mean rate /s</th>
            <th>first</th>
            <th>last</th>
            <th style={{ textAlign: "left" }}>latest stamps (s)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.channel}>
              <td className="col-ch tabular" style={{ textAlign: "left" }}>
                {monitor && row.channel === 0 ? "all channels" : row.label}
                {!row.expected && !monitor ? (
                  <Text span size="xs" c="orange.8" ml={6}>
                    not in the profile
                  </Text>
                ) : null}
              </td>
              <td className={`tabular ${row.total > 0 ? "live" : "quiet"}`}>
                {formatCount(row.total)}
              </td>
              {/* The short windows first: they are what says a trigger has
                  just stopped, and a mean over a minute takes a minute to. */}
              <td className={`tabular ${(row.rate_1s ?? 0) > 0 ? "live" : "quiet"}`}>
                {formatRate(row.rate_1s)}
              </td>
              <td className="tabular">{formatRate(row.rate_10s)}</td>
              <td className="tabular">{formatRate(row.rate)}</td>
              <td className="tabular">{formatRate(row.mean_rate)}</td>
              <td className="tabular dim">{formatRunClock(row.first)}</td>
              <td className="tabular dim">{formatRunClock(row.last)}</td>
              <td className="tabular dim" style={{ textAlign: "left" }}>
                {row.recent.map((at) => at.toFixed(6)).join("  ") || "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <Stack gap={2} p="xs">
        <Text size="xs" c="dimmed">
          Rates are counted into one-second bins of the module's own clock. The 1 s and 10 s
          columns cover only seconds that have <b>finished</b> — the second still filling would
          divide a fraction of a second's hits by a whole one and always read low — so they are
          blank until the run has a complete second. A profile channel that has fired nothing
          still gets a row; an absent row would not say so.
        </Text>
        {unexpected.length > 0 ? (
          <Text size="xs" c="orange.8">
            {unexpected.length} channel{unexpected.length === 1 ? "" : "s"} fired without being in
            the profile. Shown anyway: the module produced that data, and hiding it would be worse
            than an untidy table.
          </Text>
        ) : null}
        {monitor ? (
          <Text size="xs" c="dimmed">
            Monitor mode writes no time-stamp file, so the runner can only report a total across
            every channel at once — that is the single <b>all</b> row above, not a channel.
          </Text>
        ) : null}
      </Stack>
    </Paper>
  )
}
