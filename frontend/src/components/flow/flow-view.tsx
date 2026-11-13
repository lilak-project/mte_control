import { useCallback, useEffect, useMemo, useState } from "react"

import { api } from "@/lib/api"
import { formatCount, formatRate, formatRunClock, formatTick } from "@/lib/format"
import type { Profile, SeriesChannel, Status } from "@/lib/types"
import { Chart, Choice, Empty, Facts, Panel, Tile, TileGrid, type Tone } from "@neon"

/**
 * The live run as flow tiles: one tile per channel, its rate large, the last
 * window of it drawn behind the number, and one channel opened below in full.
 *
 * Every tile shares one time window, so their traces can be compared side by
 * side. The columns a table would need (min, max, run mean, count) live in the
 * opened channel's panel instead of across a row, so nothing ever scrolls
 * sideways.
 */

export const FLOW_WINDOWS = [
  { seconds: 60, label: "1 min" },
  { seconds: 600, label: "10 min" },
  { seconds: 3600, label: "1 h" },
]

const WINDOW_KEY = "mte.flow.window"
const PICK_KEY = "mte.flow.pick"
const POLL = 2000
/** Points per tile trace; the opened channel gets more. */
const TILE_POINTS = 120
const DETAIL_POINTS = 600

interface TileData {
  channel: number
  label: string
  kind: "counter" | "trigger"
  rate: number | null
  /** Mean over the module's averaging window, per second. */
  mean: number | null
  runMean: number | null
  min: number | null
  max: number | null
  total: number
}

function remembered(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function remember(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* the choice just will not survive a reload */
  }
}

/**
 * What a tile says about its channel.
 *
 * ponytail: relative thresholds (50 % off its own run mean, zero after counting),
 * not per-channel limits. Add limits to the profile when a channel has a real
 * band it must stay in.
 */
function toneOf(tile: TileData, running: boolean): { tone: Tone; tag: string } {
  if (!running) return { tone: "idle", tag: "" }
  if (tile.rate === 0 && (tile.runMean ?? 0) > 0) return { tone: "alarm", tag: "■ stopped" }
  const ref = tile.runMean
  if (tile.rate != null && ref) {
    const off = (tile.rate - ref) / ref
    if (off > 0.5) return { tone: "warn", tag: "▲ high" }
    if (off < -0.5) return { tone: "warn", tag: "▼ low" }
  }
  return { tone: "ok", tag: "" }
}

/** A tile's number: whole counts below a thousand, where a decimal is noise. */
function tileRate(value: number | null): string {
  if (value != null && Math.abs(value) < 1000) return Math.round(value).toLocaleString("en-US")
  return formatRate(value)
}

/** "▲ 4%" against the window mean; nothing under 3 %, which is just noise. */
function drift(rate: number | null, mean: number | null): string {
  if (rate == null || !mean) return ""
  const off = ((rate - mean) / mean) * 100
  if (Math.abs(off) < 3) return ""
  return `${off > 0 ? "▲" : "▼"} ${Math.abs(off).toFixed(0)}%`
}

export function FlowView({ status, profile }: { status: Status | null; profile: Profile | null }) {
  const [windowSeconds, setWindowSeconds] = useState(() => {
    const saved = Number(remembered(WINDOW_KEY))
    return FLOW_WINDOWS.some((w) => w.seconds === saved) ? saved : 600
  })
  const [pick, setPick] = useState<number | null>(() => Number(remembered(PICK_KEY)) || null)
  const [traces, setTraces] = useState<Record<number, SeriesChannel>>({})
  const [detail, setDetail] = useState<SeriesChannel | null>(null)

  const running = status ? ["starting", "running", "stopping"].includes(status.state) : false
  const moduleTime = status?.module_time ?? 0
  const period = (status?.count_period_ms ?? 1000) / 1000
  const shown = status?.profile ?? profile

  const tiles = useMemo(() => {
    const counters: TileData[] = (status?.counters ?? [])
      .filter((row) => !shown?.counter_channels || shown.counter_channels.includes(row.channel))
      .map((row) => ({
        channel: row.channel,
        label: row.label,
        kind: "counter",
        rate: row.rate,
        mean: row.mean_rate,
        runMean: row.run_mean_rate,
        min: row.min == null ? null : row.min / period,
        max: row.max == null ? null : row.max / period,
        total: row.total,
      }))
    const triggers: TileData[] = (status?.stamps ?? [])
      .filter((row) => row.expected)
      .map((row) => ({
        channel: row.channel,
        label: row.label,
        kind: "trigger",
        rate: row.rate_1s ?? row.rate,
        mean: row.rate_10s ?? row.mean_rate,
        runMean: row.mean_rate,
        min: null,
        max: null,
        total: row.total,
      }))
    return { counters, triggers }
  }, [status, shown, period])

  const all = useMemo(() => [...tiles.counters, ...tiles.triggers], [tiles])
  const picked = all.find((tile) => tile.channel === pick) ?? all[0] ?? null

  const counterKey = tiles.counters.map((t) => t.channel).join(",")
  const triggerKey = tiles.triggers.map((t) => t.channel).join(",")

  // Every tile's trace over the shared window, and the opened channel finer.
  const fetchTraces = useCallback(async () => {
    const start = Math.max(0, moduleTime - windowSeconds)
    const window = { start, end: moduleTime || null }
    const counters = counterKey ? counterKey.split(",").map(Number) : []
    const triggers = triggerKey ? triggerKey.split(",").map(Number) : []
    try {
      const [c, s] = await Promise.all([
        counters.length ? api.liveCounters({ ...window, channels: counters, maxPoints: TILE_POINTS }) : null,
        triggers.length ? api.liveStamps({ ...window, channels: triggers, maxPoints: TILE_POINTS }) : null,
      ])
      const next: Record<number, SeriesChannel> = {}
      for (const channel of c?.channels ?? []) {
        next[channel.channel] = { ...channel, v: channel.v.map((v) => v / period) }
      }
      for (const channel of s?.channels ?? []) next[channel.channel] = channel
      setTraces(next)
    } catch {
      /* a dropped poll is not worth a notice; the next one will do */
    }
    if (picked) {
      try {
        const query = { ...window, channels: [picked.channel], maxPoints: DETAIL_POINTS }
        const answer = picked.kind === "counter" ? await api.liveCounters(query) : await api.liveStamps(query)
        const one = answer.channels[0] ?? null
        setDetail(one && picked.kind === "counter" ? { ...one, v: one.v.map((v) => v / period) } : one)
      } catch {
        /* as above */
      }
    }
    // moduleTime moves every status; polling on its own clock is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowSeconds, counterKey, triggerKey, picked?.channel, picked?.kind, period])

  useEffect(() => {
    fetchTraces()
    if (!running) return
    const timer = setInterval(fetchTraces, POLL)
    return () => clearInterval(timer)
  }, [fetchTraces, running])

  const chooseWindow = (seconds: number) => {
    setWindowSeconds(seconds)
    remember(WINDOW_KEY, String(seconds))
  }
  const choosePick = (channel: number) => {
    setPick(channel)
    remember(PICK_KEY, String(channel))
  }

  const group = (title: string, list: TileData[]) =>
    list.length ? (
      <TileGrid title={title}>
        {list.map((tile) => {
          const { tone, tag } = toneOf(tile, running)
          const values = traces[tile.channel]?.v ?? []
          const mean = values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : tile.mean
          return (
            <Tile
              key={tile.channel}
              label={tile.label}
              value={tileRate(tile.rate)}
              unit="/s"
              sub={<>mean <span className="num">{tileRate(mean)}</span></>}
              tag={tag || drift(tile.rate, mean)}
              tone={tone}
              trace={values}
              mean={mean}
              picked={picked?.channel === tile.channel}
              onClick={() => choosePick(tile.channel)}
            />
          )
        })}
      </TileGrid>
    ) : null

  return (
    <div className="mte-flow">
      <div className="mte-flow-bar">
        <span className="dim">window</span>
        <Choice
          options={FLOW_WINDOWS.map((w) => ({ value: w.seconds, label: w.label }))}
          value={windowSeconds}
          onChange={chooseWindow}
        />
        <span className="neon-spacer" />
        <span className="faint">click a tile to open it below</span>
      </div>

      {group("scalers", tiles.counters)}
      {group("triggers", tiles.triggers)}
      {all.length === 0 ? <Empty>No channels in this profile yet.</Empty> : null}

      {picked ? <Detail tile={picked} trace={detail} running={running} windowSeconds={windowSeconds} /> : null}
    </div>
  )
}

function Detail({
  tile,
  trace,
  running,
  windowSeconds,
}: {
  tile: TileData
  trace: SeriesChannel | null
  running: boolean
  windowSeconds: number
}) {
  const { tone, tag } = toneOf(tile, running)
  const facts: [string, string][] = [
    ["now", formatRate(tile.rate)],
    [tile.kind === "counter" ? "window mean" : "10 s mean", formatRate(tile.mean)],
    ...(tile.min != null ? ([["window min", formatRate(tile.min)]] as [string, string][]) : []),
    ...(tile.max != null ? ([["window max", formatRate(tile.max)]] as [string, string][]) : []),
    ["run mean", formatRate(tile.runMean)],
    [tile.kind === "counter" ? "counts" : "hits", formatCount(tile.total)],
  ]
  const values = trace?.v ?? []
  const mean = values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null
  return (
    <Panel
      fill
      title={
        <>
          {tile.label} {tag ? <span className={`tone-text-${tone}`}>{tag}</span> : null}
        </>
      }
      actions={<span className="faint">/s · last {FLOW_WINDOWS.find((w) => w.seconds === windowSeconds)?.label}</span>}
    >
      <Facts items={facts} />
      {trace && trace.t.length > 1 ? (
        <Chart
          t={trace.t}
          series={[{ label: tile.label, values: trace.v, tone: tone === "ok" || tone === "idle" ? "ok" : tone }]}
          mean={mean}
          height="fill"
          xLabel={formatRunClock}
          yLabel={(y) => formatTick(y)}
        />
      ) : (
        <Empty>Nothing to draw yet.</Empty>
      )}
    </Panel>
  )
}
