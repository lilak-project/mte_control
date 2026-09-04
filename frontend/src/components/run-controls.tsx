import { useEffect, useState } from "react"
import {
  Badge,
  Button,
  Checkbox,
  Group,
  NumberInput,
  Paper,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core"
import { Play, Square } from "lucide-react"

import { api, type StartOptions } from "@/lib/api"
import { useAction } from "@/hooks/use-action"
import { formatDuration, formatRunClock } from "@/lib/format"
import type { DeviceState, Profile, Status } from "@/lib/types"

import { Label } from "./help"
import { Readout } from "./readout"

/**
 * The runner's own default acquisition time, and its ceiling: thirty days.
 *
 * There is no "forever" to ask for -- `SCALER_write_ACQ_TIME` takes a number of
 * seconds and the module stops itself when it gets there. So "until I stop it"
 * is this, and the tooltip says so rather than implying a promise the hardware
 * does not make.
 */
const UNTIL_STOPPED = 60 * 60 * 24 * 30

/** Times worth a click; the box takes any number of seconds. */
const ACQ_SHORTCUTS = [60, 600, 3600, 28800, 86400]

/**
 * Start and stop, and everything a run needs before it can start.
 *
 * The profile comes first because it decides the rest: where the files go, what
 * number the run gets, and which channels the panel below will show. Nothing
 * else on this form means anything until it is chosen.
 *
 * There is no run-name box. A run is identified by its profile and number, and
 * a name is worth giving once you have seen what the run did -- which is on the
 * Past runs tab, where naming one moves no files.
 */
export function RunControls({
  status,
  device,
  profiles,
  profileId,
  onProfile,
  onChanged,
}: {
  status: Status | null
  device: DeviceState | null
  profiles: Profile[]
  /** The profile a run would use: it decides the files, the number and the channels. */
  profileId: string | null
  onProfile: (id: string) => void
  onChanged: () => void
}) {
  const { pending, run } = useAction()

  const [note, setNote] = useState("")
  const [runNumber, setRunNumber] = useState<number | "">("")
  const [untilStopped, setUntilStopped] = useState(false)
  const [acqTime, setAcqTime] = useState(3600)
  const [period, setPeriod] = useState(1000)
  const [monitor, setMonitor] = useState(false)
  const [forceInit, setForceInit] = useState(false)

  const profile = profiles.find((each) => each.id === profileId) ?? null
  const nextNumber = profile?.next_run ?? 0

  // Numbering is per profile, so a number typed for one means something else
  // in another.
  useEffect(() => {
    setRunNumber("")
  }, [profileId])

  const running = status ? ["starting", "running", "stopping"].includes(status.state) : false
  const blocked = !device?.ok || !profile

  const start = () =>
    run(
      "start",
      async () => {
        const options: StartOptions = {
          note,
          profile_id: profileId,
          run_number: runNumber === "" ? null : Number(runNumber),
          acq_time_sec: untilStopped ? UNTIL_STOPPED : acqTime,
          count_period_ms: period,
          monitor,
          force_init: forceInit,
        }
        await api.start(options)
        onChanged()
      },
      monitor ? "Monitoring — nothing is being written." : "Run started.",
    )

  const stop = () =>
    run(
      "stop",
      async () => {
        await api.stop()
        onChanged()
      },
      "Stopped. The module was drained and the files closed.",
    )

  return (
    <Paper withBorder p="md">
      <Stack gap="md">
        <Group justify="space-between" align="flex-end" wrap="wrap" gap="lg">
          <Group gap="xl" align="flex-end">
            <Readout
              label={running ? "Run clock" : "Last run clock"}
              value={formatRunClock(status?.module_time ?? 0)}
              size="hero"
            />
            <Readout
              label={profile ? `Run · ${profile.name}` : "Run"}
              value={
                status?.mode === "monitor"
                  ? "monitor"
                  : status?.run_number != null
                    ? String(status.run_number)
                    : `${nextNumber} next`
              }
            />
            <Readout label="Periods read" value={String(status?.rows ?? 0)} />
            <Readout label="Time stamps" value={String(status?.stamp_events ?? 0)} />
            <RunBadge status={status} />
          </Group>

          <Group gap="sm">
            <Tooltip
              label={
                !device?.ok
                  ? "The module cannot be opened — see the Module tab."
                  : !profile
                    ? "Pick a profile first."
                    : "Start acquisition"
              }
            >
              <div>
                <Button
                  leftSection={<Play size={16} />}
                  disabled={running || blocked}
                  loading={pending === "start"}
                  onClick={start}
                >
                  {monitor ? "Monitor" : "Start"}
                </Button>
              </div>
            </Tooltip>
            <Button
              color="red"
              variant={running ? "filled" : "default"}
              leftSection={<Square size={15} />}
              disabled={!running}
              loading={pending === "stop"}
              onClick={stop}
            >
              Stop
            </Button>
          </Group>
        </Group>

        <Group grow align="flex-start" wrap="wrap">
          <Select
            label={
              <Label help="The experiment this run belongs to. It decides which directory the files go in, what number the run gets — numbering restarts inside each profile — and which channels the tables and charts below show. Edit profiles on the Module & profile tab.">
                Profile
              </Label>
            }
            placeholder={profiles.length ? "Pick one" : "Make one on the Module & profile tab"}
            data={profiles.map((each) => ({ value: each.id, label: each.name }))}
            value={profileId}
            onChange={(value) => value && onProfile(value)}
            disabled={running || profiles.length === 0}
            allowDeselect={false}
          />
          <NumberInput
            label={
              <Label help={`Left empty this is ${nextNumber}, one past the highest run this profile already has on disk. Type a number only to deliberately re-use one; a number whose files already exist is refused rather than overwritten.`}>
                Run number
              </Label>
            }
            placeholder={String(nextNumber)}
            min={0}
            value={runNumber}
            onChange={(value) => setRunNumber(value === "" ? "" : Number(value))}
            disabled={running || monitor}
          />
          <NumberInput
            label={
              <Label help="How often the module latches its counters. Every row of the counter file is one of these periods, so this sets both the time resolution of the chart and how fast the file grows.">
                Counting period (ms)
              </Label>
            }
            min={1}
            step={100}
            value={period}
            onChange={(value) => setPeriod(Number(value) || 1000)}
            disabled={running}
          />
          <TextInput
            label={
              <Label help="Anything you would otherwise write in the logbook. Kept beside the run number; it can also be added or changed afterwards on the Past runs tab.">
                Note
              </Label>
            }
            value={note}
            onChange={(event) => setNote(event.currentTarget.value)}
            disabled={running}
          />
        </Group>

        <Group align="flex-end" wrap="wrap" gap="sm">
          <Stack gap={4}>
            <Label help={`The module counts down its own acquisition time and stops itself when it reaches zero. "Until I stop it" is the longest it will accept — thirty days, the runner's own default — so it is a very long run rather than an endless one, and it still ends the moment you press Stop.`}>
              Acquisition time
            </Label>
            <SegmentedControl
              size="xs"
              value={untilStopped ? "open" : "fixed"}
              onChange={(value) => setUntilStopped(value === "open")}
              disabled={running}
              data={[
                { value: "fixed", label: "Fixed length" },
                { value: "open", label: "Until I stop it" },
              ]}
            />
          </Stack>

          {untilStopped ? (
            <Text size="sm" c="dimmed" pb={6}>
              Runs until you press Stop — or after {formatDuration(UNTIL_STOPPED)}, which is as long
              as the module will accept.
            </Text>
          ) : (
            <>
              <NumberInput
                label={<Label help="In seconds.">Seconds</Label>}
                min={1}
                step={60}
                value={acqTime}
                onChange={(value) => setAcqTime(Math.max(1, Number(value) || 1))}
                disabled={running}
                style={{ width: 150 }}
              />
              <Group gap={4} pb={6}>
                {ACQ_SHORTCUTS.map((seconds) => (
                  <Button
                    key={seconds}
                    size="compact-xs"
                    variant={acqTime === seconds ? "filled" : "default"}
                    disabled={running}
                    onClick={() => setAcqTime(seconds)}
                  >
                    {formatDuration(seconds)}
                  </Button>
                ))}
              </Group>
            </>
          )}
        </Group>

        <Group gap="lg">
          <Checkbox
            label={
              <Label help="Watches the counters without opening any file and without taking a run number, so nothing is written and the numbering is untouched. The runner reports only a total time-stamp count in this mode, not a per-channel breakdown — that lives in the file it is not writing.">
                Monitor only — write nothing
              </Label>
            }
            checked={monitor}
            onChange={(event) => setMonitor(event.currentTarget.checked)}
            disabled={running}
          />
          <Checkbox
            label={
              <Label help="Before every run the runner reads the module's current down-scale and input levels back and compares them with the profile. If they already match it leaves the module alone; if they differ it writes the profile in. This makes it write regardless. Reach for it when you doubt the readback — after a firmware update, a power cycle, or anything else that could leave the module reporting one thing and doing another.">
                Write the setup even if the module already reads back the same
              </Label>
            }
            checked={forceInit}
            onChange={(event) => setForceInit(event.currentTarget.checked)}
            disabled={running}
          />
        </Group>
      </Stack>
    </Paper>
  )
}

/** The run's state, in the one place the eye goes first. */
function RunBadge({ status }: { status: Status | null }) {
  if (!status) return null
  const look: Record<string, { color: string; label: string }> = {
    idle: { color: "gray", label: "Idle" },
    starting: { color: "blue", label: "Opening the module…" },
    running: { color: "teal", label: status.mode === "monitor" ? "Monitoring" : "Running" },
    stopping: { color: "orange", label: "Draining and closing…" },
    finished: { color: "gray", label: "Finished" },
    failed: { color: "red", label: "Failed" },
  }
  const state = look[status.state] ?? look.idle
  return (
    <Badge color={state.color} size="lg" variant={status.state === "running" ? "filled" : "light"}>
      {state.label}
    </Badge>
  )
}
