import type uPlot from "uplot"

import type { SeriesChannel } from "@/lib/types"

/**
 * Turn the per-channel series the API returns into uPlot's aligned form.
 *
 * uPlot wants one x array shared by every series. Counter channels are latched
 * in the same period, so before decimation they do share timestamps -- but
 * min/max decimation picks each channel's own extremes, so afterwards they do
 * not, and time-stamp channels never did: a channel that fired in no part of a
 * second has no bin for it. Rather than lose those extremes by forcing a common
 * grid, the union of the times is taken and each channel is filled with nulls
 * where it has no sample. `spanGaps` then draws through them, so the line is
 * continuous and every peak that was in the data is still on the screen.
 *
 * The usual case -- channels that decimated identically -- is detected and
 * passes straight through with no union built at all.
 */
export function toAligned(channels: SeriesChannel[]): uPlot.AlignedData {
  if (channels.length === 0) return [[]]

  const shared = channels.every((channel) => sameTimes(channel.t, channels[0].t))
  if (shared) {
    return [channels[0].t, ...channels.map((channel) => channel.v)] as uPlot.AlignedData
  }

  const union = Array.from(new Set(channels.flatMap((channel) => channel.t))).sort((a, b) => a - b)
  const position = new Map(union.map((time, index) => [time, index]))
  const rows = channels.map((channel) => {
    const row: (number | null)[] = Array.from({ length: union.length }, () => null)
    for (let i = 0; i < channel.t.length; i += 1) {
      const at = position.get(channel.t[i])
      if (at !== undefined) row[at] = channel.v[i]
    }
    return row
  })
  return [union, ...rows] as uPlot.AlignedData
}

function sameTimes(a: number[], b: number[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/** Points on screen across every channel, for the "showing N of M" line. */
export function pointCounts(channels: SeriesChannel[]): { shown: number; total: number } {
  return channels.reduce(
    (sum, channel) => ({ shown: sum.shown + channel.t.length, total: sum.total + channel.total }),
    { shown: 0, total: 0 },
  )
}
