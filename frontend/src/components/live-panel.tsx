import { useCallback, useEffect, useMemo, useState } from "react"
import { Alert, Badge, Collapse, Group, SegmentedControl, Stack, Text, UnstyledButton } from "@mantine/core"
import { ChevronDown, ChevronRight } from "lucide-react"

import { ChartCard } from "./chart/chart-card"
import { api } from "@/lib/api"
import { formatBytes, formatCount, formatDuration, formatRunClock } from "@/lib/format"
import { MAX_SERIES } from "@/lib/palette"
import type { CounterRow, Profile, SeriesChannel, StampRow, Status } from "@/lib/types"

import { CounterTable } from "./counter-table"
import { PrintBlock } from "./print-block"
import { Section } from "./section"
import { StampTable } from "./stamp-table"

/** The averaging windows an operator actually asks for. */
export const AVERAGE_WINDOWS = [
  { value: "10", label: "10 s" },
  { value: "60", label: "1 min" },
  { value: "300", label: "5 min" },
  { value: "900", label: "15 min" },
  { value: "3600", label: "1 h" },
]

/** How often the charts re-read their window while a run is going. */
const CHART_INTERVAL = 2000

/**
 * The run as it happens: the two tables and the two charts.
 *
 * The tables come from the status socket, which carries only the present. The
 * charts fetch their own window on a timer, because a window is history and
 * history is a query -- a browser watching a day-old run costs the same as one
 * watching a run that started a minute ago.
 */
export function LivePanel({
  status,
  profile,
  averageSeconds,
  onAverage,
}: {
  status: Status | null
  /** The profile picked in the UI, used while nothing is running.
   *
   *  Two different profiles are in play and they answer different questions: a
   *  run in progress carries the profile it was *started* with, which is what
   *  its numbers actually are; when nothing is running there is no such thing,
   *  and the right answer is whichever profile the operator is looking at. The
   *  running one always wins -- relabelling live data with a profile it was not
   *  taken under would be a lie about what the module is doing. */
  profile: Profile | null
  averageSeconds: number
  onAverage: (seconds: number) => void
}) {
  const [selected, setSelected] = useState<number[]>([])
  const [counterSeries, setCounterSeries] = useState<SeriesChannel[]>([])
  const [stampSeries, setStampSeries] = useState<SeriesChannel[]>([])
  const [logOpen, setLogOpen] = useState(false)

  const running = status ? ["starting", "running", "stopping"].includes(status.state) : false
  const moduleTime = status?.module_time ?? 0

  const shown = status?.profile ?? profile
  const label = (channel: number) =>
    shown?.labels[String(channel)] ?? `Ch${channel}`

  // The backend narrows these to the running profile's channels. Idle, it has
  // no profile to narrow by and sends all ten, so the same narrowing is done
  // here against the picked one -- the alternative being a table that is six
  // rows of zeroes until someone presses Start.
  const counterRows: CounterRow[] = useMemo(() => {
    const rows = status?.counters ?? []
    if (status?.profile) return rows
    const wanted = profile?.counter_channels
    if (!wanted) return rows
    return rows
      .filter((row) => wanted.includes(row.channel))
      .map((row) => ({ ...row, label: label(row.channel) }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, profile])

  const stampRows: StampRow[] = useMemo(() => {
    const rows = status?.stamps ?? []
    if (status?.profile) return rows
    const wanted = profile?.trigger_channels ?? []
    const seen = new Set(rows.map((row) => row.channel))
    // A selected channel that has fired nothing still gets a row: silence on a
    // channel you are watching is a finding, and a missing row does not say it.
    const quiet: StampRow[] = wanted
      .filter((channel) => !seen.has(channel))
      .map((channel) => ({
        channel,
        label: label(channel),
        expected: true,
        total: 0,
        rate: null,
        rate_1s: null,
        rate_10s: null,
        mean_rate: null,
        first: null,
        last: null,
        recent: [],
      }))
    return [
      ...rows.map((row) => ({
        ...row,
        label: label(row.channel),
        expected: wanted.includes(row.channel),
      })),
      ...quiet,
    ].sort((a, b) => a.channel - b.channel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, profile])

  // The profile decides which channels exist here at all, so the chart opens
  // on them rather than on whatever happens to be counting. Re-picked whenever
  // the profile changes, because a channel from the previous one would be a
  // line the table no longer has a row for.
  const profileChannels = shown?.counter_channels
  const profileKey = profileChannels?.join(",") ?? ""
  useEffect(() => {
    if (!profileChannels) return
    setSelected(profileChannels.slice(0, MAX_SERIES))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileKey])

  const fetchSeries = useCallback(async () => {
    if (selected.length > 0) {
      try {
        const answer = await api.liveCounters({ channels: selected })
        setCounterSeries(answer.channels)
      } catch {
        /* a dropped poll is not worth a notification; the next one will do */
      }
    } else {
      setCounterSeries([])
    }
    try {
      const answer = await api.liveStamps({})
      setStampSeries(answer.channels.slice(0, MAX_SERIES))
    } catch {
      /* as above */
    }
  }, [selected])

  useEffect(() => {
    fetchSeries()
    if (!running) return
    const timer = setInterval(fetchSeries, CHART_INTERVAL)
    return () => clearInterval(timer)
  }, [fetchSeries, running])

  const counterEnd = Math.max(1, moduleTime)
  const stampEnd = useMemo(() => {
    let high = 1
    for (const channel of stampSeries) {
      if (channel.t.length) high = Math.max(high, channel.t[channel.t.length - 1])
    }
    return Math.max(high, moduleTime || 1)
  }, [stampSeries, moduleTime])

  const period = (status?.count_period_ms ?? 1000) / 1000
  const counterPrint = status?.counter_print ?? { channels: [], labels: [], rows: [] }

  // Which run these rows belong to, on the printouts themselves. The header
  // says it too, but a printout is read on its own -- and after a run ends its
  // last periods stay on screen, where "the last ten" without a number is a
  // claim about the present that is no longer true.
  const runLabel =
    status?.mode === "monitor"
      ? "Monitor"
      : status?.run_number != null
        ? `Run ${status.run_number}`
        : null

  const stampPrint = status?.stamp_print ?? { channels: [], labels: [], rows: [] }

  return (
    <Stack gap="xl">
      {status?.error ? (
        <Alert color={status.state === "failed" ? "red" : "orange"} title="From the runner">
          <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
            {status.error}
          </Text>
        </Alert>
      ) : null}

      {status && status.skipped_bytes > 0 ? (
        <Alert color="orange" title="Time stamps are arriving faster than they can be parsed">
          <Text size="sm">
            {formatBytes(status.skipped_bytes)} of the time-stamp file has been skipped, so the
            per-channel rates below are a sample rather than a total.{" "}
            <b>Nothing is lost from the data</b> — the runner is still writing every event, and the
            file on disk is complete.
          </Text>
        </Alert>
      ) : null}

      <Section
        title="Counter channels"
        description={
          `Counts latched every ${status?.count_period_ms ?? 1000} ms, for the ` +
          `${counterRows.length} channels ${shown?.name ?? "the profile"} reads. ` +
          "The mean columns cover the window chosen here."
        }
        action={
          <Group gap="xs">
            <Text size="xs" c="dimmed">
              Average over
            </Text>
            <SegmentedControl
              size="xs"
              data={AVERAGE_WINDOWS}
              value={String(averageSeconds)}
              onChange={(value) => onAverage(Number(value))}
            />
          </Group>
        }
      >
        {/* The chart above the table. Both say the same thing, and the shape is
            what is read across the room -- the table is what you come closer
            for when a number looks wrong. */}
        <ChartCard
          title="Counts against run time"
          channels={counterSeries}
          unit={`counts / ${period === 1 ? "s" : `${period.toFixed(2)} s`}`}
          dataStart={0}
          dataEnd={counterEnd}
          empty={
            selected.length === 0
              ? "Tick a channel in the table to draw it."
              : "Nothing counted yet."
          }
          height={280}
          resetKey={`${status?.run_number ?? "none"}/${status?.started_at ?? 0}/counters`}
        />

        <CounterTable
          rows={counterRows}
          averageSeconds={averageSeconds}
          selected={selected}
          onSelect={setSelected}
        />

        <PrintBlock
          run={runLabel}
          title={`The last ${status?.print_rows ?? 10} counting periods`}
          hint="the runner's own printout · newest at the bottom"
          first={[
            { label: "event#", values: counterPrint.rows.map((row) => String(row.index)) },
            { label: "time", values: counterPrint.rows.map((row) => formatRunClock(row.time)) },
            {
              label: "#stamps",
              values: counterPrint.rows.map((row) => formatCount(row.stamps)),
            },
          ]}
          columns={counterPrint.labels}
          rows={counterPrint.rows.map((row) => row.counts.map((count) => formatCount(count)))}
          empty="No counting period has been read yet."
        />
      </Section>

      <Section
        title="Time stamps"
        description="One line per event in the file; counted into one-second bins here, because the rate is the thing that is read."
      >
        <ChartCard
          title="Hits per second against run time"
          channels={stampSeries}
          unit="hits / s"
          dataStart={0}
          dataEnd={stampEnd}
          empty="No time stamps yet."
          height={240}
          resetKey={`${status?.run_number ?? "none"}/${status?.started_at ?? 0}/stamps`}
        />

        <StampTable
          rows={stampRows}
          averageSeconds={averageSeconds}
          monitor={status?.mode === "monitor"}
        />

        <PrintBlock
          run={runLabel}
          title={`Hits in each of the last ${status?.print_rows ?? 10} seconds`}
          hint="complete seconds only · newest at the bottom"
          first={[
            { label: "t", values: stampPrint.rows.map((row) => formatRunClock(row.second)) },
          ]}
          columns={stampPrint.labels}
          rows={stampPrint.rows.map((row) => row.counts.map((count) => formatCount(count)))}
          empty="No complete second of time stamps yet."
        />
      </Section>

      {status && status.log.length > 0 ? (
        <Stack gap="xs">
          <UnstyledButton onClick={() => setLogOpen((open) => !open)}>
            <Group gap={6}>
              {logOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              <Text fw={600} size="sm">
                What the runner said
              </Text>
              <Badge size="sm" variant="light" color="gray">
                {status.log.length} lines
              </Badge>
              {status.sid != null ? (
                <Text size="xs" c="dimmed">
                  · opened as sid {status.sid}
                </Text>
              ) : null}
            </Group>
          </UnstyledButton>
          <Collapse expanded={logOpen}>
            <Stack gap="xs">
              <div className="log">{status.log.join("\n")}</div>
              {status.command ? (
                <Text size="xs" c="dimmed" className="tabular">
                  {status.command}
                </Text>
              ) : null}
              {status.elapsed != null ? (
                <Text size="xs" c="dimmed">
                  {formatDuration(status.elapsed)} since it was started
                </Text>
              ) : null}
            </Stack>
          </Collapse>
        </Stack>
      ) : null}
    </Stack>
  )
}
