import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Anchor,
  Badge,
  Button,
  Grid,
  Group,
  Paper,
  Stack,
  Tabs,
  Text,
  TextInput,
} from "@mantine/core"
import { Check, Download, FileText, RefreshCw, Search } from "lucide-react"

import { ChartCard } from "./chart/chart-card"
import { api } from "@/lib/api"
import { useAction } from "@/hooks/use-action"
import {
  formatBytes,
  formatCount,
  formatDuration,
  formatRate,
  formatRunClock,
  formatStamp,
} from "@/lib/format"
import { MAX_SERIES, seriesColor } from "@/lib/palette"
import type { RunDetail, RunList, SeriesChannel, SeriesResponse } from "@/lib/types"

import { Fact, FactGrid } from "./section"

/**
 * Every run the module has ever written, and what is in one.
 *
 * Runs are listed from more than one tree: the one this service writes to, and
 * the one the runner has been writing to from `sudo -i` up to now. A run found
 * by scanning has no name -- only a number and a set of file times -- and can
 * be given one here, which changes metadata and never touches a byte of data.
 */
export function RunsPanel({
  profileId,
  profileName,
  refreshKey,
  readOnly = false,
}: {
  /** Runs belong to a profile, and numbering restarts inside each one. */
  profileId: string | null
  profileName: string
  refreshKey: number
  /** The monitoring service: naming a run is a write, and it has none.
   *
   *  A hidden button is not the guarantee -- the monitoring backend forwards
   *  no PATCH at all -- but a control that would fail is worse than no
   *  control, so it is not drawn either. */
  readOnly?: boolean
}) {
  const { pending, run: act } = useAction()

  const [list, setList] = useState<RunList | null>(null)
  const [search, setSearch] = useState("")
  const [selected, setSelected] = useState<number | null>(null)
  const [detail, setDetail] = useState<RunDetail | null>(null)
  const [name, setName] = useState("")
  const [note, setNote] = useState("")

  const reload = useCallback(() => {
    if (!profileId) {
      setList(null)
      return
    }
    api
      .listRuns(profileId, search)
      .then(setList)
      .catch(() => setList(null))
  }, [profileId, search])

  useEffect(reload, [reload, refreshKey])

  // Open the newest run by default; it is nearly always the one being asked
  // about, and an empty right-hand pane teaches nothing.
  useEffect(() => {
    if (selected === null && list && list.runs.length > 0) setSelected(list.runs[0].number)
  }, [list, selected])

  // Switching profile must not leave the previous profile's run open.
  useEffect(() => {
    setSelected(null)
    setDetail(null)
  }, [profileId])

  useEffect(() => {
    if (selected === null || !profileId) return
    let cancelled = false
    api
      .run(profileId, selected)
      .then((answer) => {
        if (cancelled) return
        setDetail(answer)
        setName(answer.name)
        setNote(answer.note)
      })
      .catch(() => setDetail(null))
    return () => {
      cancelled = true
    }
  }, [selected, profileId, refreshKey])

  return (
    <Grid gap="md">
      <Grid.Col span={{ base: 12, md: 4, lg: 3 }}>
        <Stack gap="sm">
          <Group gap="xs" wrap="nowrap">
            <TextInput
              leftSection={<Search size={15} />}
              placeholder="Name, note, or number"
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
              style={{ flex: 1 }}
            />
            <Button variant="default" px="sm" onClick={reload} aria-label="Refresh">
              <RefreshCw size={15} />
            </Button>
          </Group>

          <div className="runs">
            {(list?.runs ?? []).map((run) => (
              <button
                type="button"
                key={run.number}
                className={`run-row${run.number === selected ? " is-current" : ""}`}
                onClick={() => setSelected(run.number)}
              >
                <Group justify="space-between" gap="xs" wrap="nowrap">
                  <Text size="sm" fw={600} className="tabular">
                    {run.number}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {formatBytes(run.files.total_bytes)}
                  </Text>
                </Group>
                <Text size="xs" lineClamp={1}>
                  {run.name || <span className="dim">unnamed</span>}
                </Text>
                <Text size="xs" c="dimmed">
                  {formatStamp(run.started_at)}
                </Text>
              </button>
            ))}
            {list && list.runs.length === 0 ? (
              <Text size="sm" c="dimmed" p="md" ta="center">
                {search ? "No run matches." : `${profileName} has no runs yet.`}
              </Text>
            ) : null}
          </div>

          {list ? (
            <Stack gap={2}>
              <Text size="xs" c="dimmed">
                {list.runs.length}
                {list.runs.length === list.total ? "" : ` of ${list.total}`} runs of {profileName} ·
                next number {list.next_number}
              </Text>
              <Text size="xs" c="dimmed" className="tabular">
                {list.directory}
              </Text>
            </Stack>
          ) : null}
        </Stack>
      </Grid.Col>

      <Grid.Col span={{ base: 12, md: 8, lg: 9 }}>
        {detail ? (
          <Stack gap="md">
            <Paper withBorder p="md">
              <Stack gap="sm">
                <Group justify="space-between" wrap="wrap" gap="sm">
                  <Group gap="sm">
                    <Text fw={600} size="lg">
                      {detail.profile_name} · run {detail.number}
                    </Text>
                    <Badge variant="light" color={detail.source === "service" ? "blue" : "gray"}>
                      {detail.source === "service" ? "started here" : "found on disk"}
                    </Badge>
                    {detail.exit_code != null ? (
                      <Badge variant="light" color={detail.exit_code === 0 ? "teal" : "red"}>
                        runner exited {detail.exit_code}
                      </Badge>
                    ) : null}
                  </Group>
                </Group>

                {readOnly ? (
                  detail.name || detail.note ? (
                    <FactGrid>
                      <Fact label="Name">{detail.name}</Fact>
                      <Fact label="Note">{detail.note}</Fact>
                    </FactGrid>
                  ) : null
                ) : (
                  <Group align="flex-end" wrap="wrap" gap="sm">
                    <TextInput
                      label="Name"
                      placeholder="What this run was for"
                      value={name}
                      onChange={(event) => setName(event.currentTarget.value)}
                      style={{ flex: 1, minWidth: 220 }}
                    />
                    <TextInput
                      label="Note"
                      value={note}
                      onChange={(event) => setNote(event.currentTarget.value)}
                      style={{ flex: 1, minWidth: 200 }}
                    />
                    <Button
                      leftSection={<Check size={15} />}
                      loading={pending === "rename"}
                      onClick={() =>
                        act(
                          "rename",
                          async () => {
                            setDetail(
                              await api.rename(detail.profile_id, detail.number, name, note),
                            )
                            reload()
                          },
                          "Saved. No file was moved.",
                        )
                      }
                    >
                      Save name
                    </Button>
                  </Group>
                )}

                <FactGrid>
                  <Fact label="Started">{formatStamp(detail.started_at)}</Fact>
                  <Fact label="Ended">{formatStamp(detail.stopped_at)}</Fact>
                  <Fact label="Length">
                    {detail.counters
                      ? `${formatDuration(detail.counters.duration)} of counting, ${formatCount(detail.counters.rows)} periods`
                      : "—"}
                  </Fact>
                  <Fact label="Counting period">
                    {detail.count_period_ms ? `${detail.count_period_ms} ms` : "not recorded"}
                  </Fact>
                  <Fact label="Channels">
                    {detail.profile
                      ? detail.profile.selected
                          .map((channel) => detail.profile?.labels[String(channel)] ?? `Ch${channel}`)
                          .join(", ") || "none selected"
                      : "not recorded — this run predates the service"}
                  </Fact>
                  <Fact label="Down-scale">
                    {detail.profile ? detail.profile.down_scale.join(", ") : "—"}
                  </Fact>
                  <Fact label="Files" mono>
                    {detail.files.converted_dir ?? "—"}
                  </Fact>
                </FactGrid>

                <Group gap="xs">
                  {(
                    [
                      ["counter_txt", "counter .txt"],
                      ["stamp_txt", "time_stamp .txt"],
                      ["counter_dat", "counter .dat"],
                      ["stamp_dat", "time_stamp .dat"],
                    ] as const
                  ).map(([key, label]) =>
                    detail.files[key] ? (
                      <Anchor
                        key={key}
                        href={api.fileUrl(detail.profile_id, detail.number, key)}
                        download
                      >
                        <Button variant="default" size="xs" leftSection={<Download size={14} />}>
                          {label} · {formatBytes(detail.files.sizes[key])}
                        </Button>
                      </Anchor>
                    ) : null,
                  )}
                </Group>
              </Stack>
            </Paper>

            <RunData detail={detail} />
          </Stack>
        ) : (
          <Paper withBorder p="xl">
            <Text c="dimmed" ta="center">
              Pick a run on the left.
            </Text>
          </Paper>
        )}
      </Grid.Col>
    </Grid>
  )
}

/** The counts and the time stamps of one finished run. */
function RunData({ detail }: { detail: RunDetail }) {
  const [counterSeries, setCounterSeries] = useState<SeriesResponse | null>(null)
  const [stampSeries, setStampSeries] = useState<SeriesResponse | null>(null)
  const [preview, setPreview] = useState<string>("")

  // The channels the run's own profile read -- not today's profile, which may
  // have been re-pointed since. Falling back to whatever actually counted, for
  // a run taken before profiles existed.
  const active = useMemo(() => {
    const fromProfile = detail.profile?.counter_channels ?? []
    if (fromProfile.length > 0) return fromProfile.slice(0, MAX_SERIES)
    return (detail.counters?.channels ?? [])
      .filter((channel) => channel.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, MAX_SERIES)
      .map((channel) => channel.channel)
      .sort((a, b) => a - b)
  }, [detail])

  const label = (channel: number) =>
    detail.profile?.labels[String(channel)] ?? `Ch${channel}`

  useEffect(() => {
    if (!detail.files.counter_txt || active.length === 0) {
      setCounterSeries(null)
      return
    }
    api
      .runCounters(detail.profile_id, detail.number, { channels: active })
      .then(setCounterSeries)
      .catch(() => setCounterSeries(null))
  }, [detail.profile_id, detail.number, detail.files.counter_txt, active])

  useEffect(() => {
    if (!detail.files.stamp_txt) {
      setStampSeries(null)
      return
    }
    api
      .runStamps(detail.profile_id, detail.number, {})
      .then(setStampSeries)
      .catch(() => setStampSeries(null))
  }, [detail.profile_id, detail.number, detail.files.stamp_txt])

  const span = detail.counters?.span
  const counterChannels: SeriesChannel[] = counterSeries?.channels ?? []
  const stampChannels: SeriesChannel[] = (stampSeries?.channels ?? []).slice(0, MAX_SERIES)
  const stampSpan = spanOf(stampChannels)

  return (
    <Tabs defaultValue="counters">
      <Tabs.List>
        <Tabs.Tab value="counters">Counters</Tabs.Tab>
        <Tabs.Tab value="stamps">Time stamps</Tabs.Tab>
        <Tabs.Tab value="file" leftSection={<FileText size={14} />}>
          The file itself
        </Tabs.Tab>
      </Tabs.List>

      <Tabs.Panel value="counters" pt="md">
        <Stack gap="md">
          <ChartCard
            title="Counts per period"
            channels={counterChannels}
            unit="counts / period"
            dataStart={span?.[0] ?? 0}
            dataEnd={span?.[1] ?? 1}
            defaultPreset="all"
            empty="This run counted nothing on any channel."
            resetKey={`${detail.profile_id}/${detail.number}/counters`}
          />

          {detail.counters ? (
            <Paper withBorder p={0} style={{ overflow: "hidden" }}>
              <table className="grid">
                <thead>
                  <tr>
                    <th className="col-ch">ch</th>
                    <th>total counts</th>
                    <th>mean / period</th>
                    <th>mean rate /s</th>
                    <th>min</th>
                    <th>max</th>
                    <th>periods</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.counters.channels
                    .filter((channel) => active.length === 0 || active.includes(channel.channel))
                    .map((channel) => {
                    const position = active.indexOf(channel.channel)
                    return (
                      <tr key={channel.channel}>
                        <td className="col-ch" style={{ textAlign: "left" }}>
                          {position >= 0 ? (
                            <span
                              className="swatch"
                              style={{ background: seriesColor(position) }}
                            />
                          ) : null}
                          <span className="tabular">{label(channel.channel)}</span>
                        </td>
                        <td className={`tabular ${channel.total > 0 ? "live" : "quiet"}`}>
                          {formatCount(channel.total)}
                        </td>
                        <td className="tabular">{formatCount(channel.mean)}</td>
                        <td className="tabular">{formatRate(channel.mean_rate)}</td>
                        <td className="tabular dim">{formatCount(channel.min)}</td>
                        <td className="tabular dim">{formatCount(channel.max)}</td>
                        <td className="tabular dim">{channel.samples}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </Paper>
          ) : null}
        </Stack>
      </Tabs.Panel>

      <Tabs.Panel value="stamps" pt="md">
        <Stack gap="md">
          <ChartCard
            title="Time-stamp hits per second"
            channels={stampChannels}
            unit="hits / s"
            dataStart={stampSpan[0]}
            dataEnd={stampSpan[1]}
            defaultPreset="all"
            empty="This run wrote no time stamps."
            resetKey={`${detail.profile_id}/${detail.number}/stamps`}
          />

          {detail.stamps && detail.stamps.channels.length > 0 ? (
            <Paper withBorder p={0} style={{ overflow: "hidden" }}>
              <table className="grid">
                <thead>
                  <tr>
                    <th className="col-ch">ch</th>
                    <th>events</th>
                    <th>mean rate /s</th>
                    <th>seconds live</th>
                    <th>first</th>
                    <th>last</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.stamps.channels.map((channel, position) => (
                    <tr key={channel.channel}>
                      <td className="col-ch" style={{ textAlign: "left" }}>
                        {position < MAX_SERIES ? (
                          <span className="swatch" style={{ background: seriesColor(position) }} />
                        ) : null}
                        <span className="tabular">{label(channel.channel)}</span>
                      </td>
                      <td className="tabular live">{formatCount(channel.total)}</td>
                      <td className="tabular">{formatRate(channel.mean_rate)}</td>
                      <td className="tabular dim">{channel.seconds_live}</td>
                      <td className="tabular dim">{formatRunClock(channel.first)}</td>
                      <td className="tabular dim">{formatRunClock(channel.last)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {detail.stamps.skipped_bytes > 0 ? (
                <Text size="xs" c="dimmed" p="xs">
                  This file is large; {formatBytes(detail.stamps.skipped_bytes)} of it was not read.
                  The rates above cover the part that was. Download the file for the whole of it.
                </Text>
              ) : null}
            </Paper>
          ) : null}
        </Stack>
      </Tabs.Panel>

      <Tabs.Panel value="file" pt="md">
        <Stack gap="sm">
          <Group gap="xs">
            {(
              [
                ["counter_txt", "counter"],
                ["stamp_txt", "time stamps"],
              ] as const
            ).map(([key, label]) =>
              detail.files[key] ? (
                <Button
                  key={key}
                  variant="default"
                  size="xs"
                  onClick={() =>
                    api
                      .preview(detail.profile_id, detail.number, key)
                      .then(setPreview)
                      .catch((error) => setPreview(String(error)))
                  }
                >
                  First lines of {label}
                </Button>
              ) : null,
            )}
          </Group>
          {preview ? (
            <div className="log" style={{ maxHeight: 520 }}>
              {preview}
            </div>
          ) : (
            <Text size="sm" c="dimmed">
              The converted files are plain text, and this is the top of one — the same file any
              analysis script would open.
            </Text>
          )}
        </Stack>
      </Tabs.Panel>
    </Tabs>
  )
}

/** The run-clock bounds a set of series covers, with a sane fallback. */
function spanOf(channels: SeriesChannel[]): [number, number] {
  let low = Infinity
  let high = -Infinity
  for (const channel of channels) {
    if (channel.t.length === 0) continue
    low = Math.min(low, channel.t[0])
    high = Math.max(high, channel.t[channel.t.length - 1])
  }
  return Number.isFinite(low) && high > low ? [low, high] : [0, 1]
}
