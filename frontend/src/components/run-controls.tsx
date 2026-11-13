import { useEffect, useState } from "react";
import {
  Button,
  Checkbox,
  Group,
  Input,
  NumberInput,
  Paper,
  Select,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { Play, Square } from "lucide-react";

import { Choice, Command, Hold, Readout, StateDot, Tag, type Tone } from "@neon";

import { api, type StartOptions } from "@/lib/api";
import { useAction } from "@/hooks/use-action";
import { formatCount, formatDuration, formatRunClock } from "@/lib/format";
import type { DeviceState, Profile, Status } from "@/lib/types";

import { Label } from "./help";

/**
 * The runner's own default acquisition time, and its ceiling: thirty days.
 *
 * There is no "forever" to ask for -- `SCALER_write_ACQ_TIME` takes a number of
 * seconds and the module stops itself when it gets there. So "until I stop it"
 * is this, and the tooltip says so rather than implying a promise the hardware
 * does not make.
 */
const UNTIL_STOPPED = 60 * 60 * 24 * 30;

/** Times worth a click; the box takes any number of seconds. */
const ACQ_SHORTCUTS = [60, 600, 3600, 28800, 86400];

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
  status: Status | null;
  device: DeviceState | null;
  profiles: Profile[];
  /** The profile a run would use: it decides the files, the number and the channels. */
  profileId: string | null;
  onProfile: (id: string) => void;
  onChanged: () => void;
}) {
  const { pending, run } = useAction();

  const [note, setNote] = useState("");
  const [runNumber, setRunNumber] = useState<number | "">("");
  /** The NEXT number being edited; null while it is shown as a tag. */
  const [editing, setEditing] = useState<string | null>(null);
  const [untilStopped, setUntilStopped] = useState(true);
  const [acqTime, setAcqTime] = useState(3600);
  const [period, setPeriod] = useState(1000);
  const [monitor, setMonitor] = useState(false);
  const [forceInit, setForceInit] = useState(false);

  const profile = profiles.find((each) => each.id === profileId) ?? null;
  const nextNumber = profile?.next_run ?? 0;

  // Numbering is per profile, so a number typed for one means something else
  // in another.
  useEffect(() => {
    setRunNumber("");
    setEditing(null);
  }, [profileId]);

  const running = status
    ? ["starting", "running", "stopping"].includes(status.state)
    : false;
  const blocked = !device?.ok || !profile;

  // Set: the typed number is the one the next run asks for (blank or the
  // profile's own next number means "the next one").
  const settle = () => {
    if (editing === null) return runNumber;
    const n = Number(editing);
    const value: number | "" = editing.trim() === "" || !Number.isInteger(n) || n < 0 || n === nextNumber ? "" : n;
    setRunNumber(value);
    setEditing(null);
    return value;
  };

  const start = () => {
    // Start with the box still open counts as pressing Set first.
    const chosen = settle();
    return run(
      "start",
      async () => {
        const options: StartOptions = {
          note,
          profile_id: profileId,
          run_number: chosen === "" ? null : Number(chosen),
          acq_time_sec: untilStopped ? UNTIL_STOPPED : acqTime,
          count_period_ms: period,
          monitor,
          force_init: forceInit,
        };
        await api.start(options);
        onChanged();
      },
      monitor ? "Monitoring — nothing is being written." : "Run started.",
    );
  };

  const stop = () =>
    run(
      "stop",
      async () => {
        await api.stop();
        onChanged();
      },
      "Stopped. The module was drained and the files closed.",
    );

  return (
    <Paper withBorder p="md">
      <Stack gap="md">
        {/* What this run IS (fixed: its number, its profile) on a line of its
            own; below it, what it is DOING (NEON rule 4). */}
        <div className="mte-runtags">
          {running ? (
            <Tag label="RUN" on>{status?.mode === "monitor" ? "monitor" : (status?.run_number ?? "—")}</Tag>
          ) : monitor ? (
            <Tag label="NEXT">no number</Tag>
          ) : editing === null ? (
            <button
              type="button"
              className="mte-tagkey"
              title="Change the number the next run takes"
              disabled={!profile}
              onClick={() => setEditing(String(runNumber === "" ? nextNumber : runNumber))}
            >
              <Tag label="NEXT">{runNumber === "" ? nextNumber : runNumber}</Tag>
            </button>
          ) : (
            <span className="mte-nextedit">
              <input
                className="neon-input num"
                type="number"
                min={0}
                autoFocus
                value={editing}
                onChange={(e) => setEditing(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") settle();
                  if (e.key === "Escape") setEditing(null);
                }}
              />
              <Command small onRun={() => settle()}>
                Set
              </Command>
            </span>
          )}
          {(status?.profile?.name ?? profile?.name) ? (
            <Tag label="PROFILE">{running ? (status?.profile?.name ?? profile?.name) : profile?.name}</Tag>
          ) : null}
          <RunState status={status} />
        </div>

        <Group justify="space-between" align="flex-end" wrap="wrap" gap="lg">
          <Group gap="xl" align="flex-end">
            <Readout
              label={<Hold reserve={["Run clock", "Last run clock"]}>{running ? "Run clock" : "Last run clock"}</Hold>}
              value={<Hold reserve={["88:88:88"]}>{formatRunClock(status?.module_time ?? 0)}</Hold>}
              size="hero"
            />
            <Readout label="Periods read" value={<Hold reserve={["8 888 888"]}>{formatCount(status?.rows ?? 0)}</Hold>} />
            <Readout label="Time stamps" value={<Hold reserve={["88 888 888"]}>{formatCount(status?.stamp_events ?? 0)}</Hold>} />
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

        {/* The setup for the next run: locked while one is going. */}
          <>
            <Group grow align="flex-start" wrap="wrap">
              <Select
                label={
                  <Label help="The experiment this run belongs to. It decides which directory the files go in, what number the run gets — numbering restarts inside each profile — and which channels the tables and charts below show. Edit profiles on the Module & profile tab.">
                    Profile
                  </Label>
                }
                placeholder={
                  profiles.length
                    ? "Pick one"
                    : "Make one on the Module & profile tab"
                }
                data={profiles.map((each) => ({
                  value: each.id,
                  label: each.name,
                }))}
                value={profileId}
                onChange={(value) => value && onProfile(value)}
                disabled={running || profiles.length === 0}
                allowDeselect={false}
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
              <Input.Wrapper
                label={
                  <Label
                  help={`Timed: the module stops itself after the time set. Continuous: runs until you press Stop (at most ${formatDuration(UNTIL_STOPPED)}, the longest the module accepts).`}
                >
                  Acquisition time
                </Label>
                }
              >
                <div>
                  <Choice
                    value={untilStopped ? "open" : "fixed"}
                    onChange={(value) => setUntilStopped(value === "open")}
                    disabled={running}
                    options={[
                      { value: "fixed", label: "Timed run" },
                      { value: "open", label: "Continuous run" },
                    ]}
                  />
                </div>
              </Input.Wrapper>

              {untilStopped ? (
                // An empty label in the Seconds field's place: picking either
                // length keeps the row the same height.
                <Input.Wrapper label={<span aria-hidden style={{ visibility: "hidden" }}>Seconds</span>}>
                  <Text c="dimmed" h="var(--neon-control)" style={{ display: "flex", alignItems: "center" }}>
                    Until you press Stop (at most {formatDuration(UNTIL_STOPPED)})
                  </Text>
                </Input.Wrapper>
              ) : (
                <>
                  <NumberInput
                    label={<Label help="In seconds.">Seconds</Label>}
                    min={1}
                    step={60}
                    value={acqTime}
                    onChange={(value) =>
                      setAcqTime(Math.max(1, Number(value) || 1))
                    }
                    disabled={running}
                    style={{ width: 150 }}
                  />
                  <Choice
                    options={ACQ_SHORTCUTS.map((seconds) => ({ value: seconds, label: formatDuration(seconds) }))}
                    value={acqTime}
                    onChange={setAcqTime}
                    disabled={running}
                  />
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
                  <Label help="Each run writes the profile's setup (down-scale, NIM/TTL) to the module only where it differs. Tick to write it all anyway — after a power cycle or firmware update.">
                    Force setup write
                  </Label>
                }
                checked={forceInit}
                onChange={(event) => setForceInit(event.currentTarget.checked)}
                disabled={running}
              />
            </Group>
          </>
      </Stack>
    </Paper>
  );
}

/** The run's state, in the one place the eye goes first; as wide as its longest word (rule 5). */
const RUN_STATES: Record<string, { tone: Tone; label: string }> = {
  idle: { tone: "idle", label: "idle" },
  starting: { tone: "ok", label: "opening…" },
  running: { tone: "ok", label: "running" },
  stopping: { tone: "warn", label: "closing…" },
  finished: { tone: "idle", label: "finished" },
  failed: { tone: "alarm", label: "failed" },
};

function RunState({ status }: { status: Status | null }) {
  const state = RUN_STATES[status?.state ?? "idle"] ?? RUN_STATES.idle;
  const label = status?.state === "running" && status.mode === "monitor" ? "monitoring" : state.label;
  return (
    <StateDot tone={state.tone} reserve={[...Object.values(RUN_STATES).map((each) => each.label), "monitoring"]}>
      {label}
    </StateDot>
  );
}
