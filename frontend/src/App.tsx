import { useCallback, useEffect, useState } from "react"
import { Stack } from "@mantine/core"
import { Brand, Choice, Hold, ThemeSwitch, Screen, Spacer, Tabs, Total } from "@neon"

import { api } from "@/lib/api"
import { useAction } from "@/hooks/use-action"
import { useStatusStream } from "@/hooks/use-status-stream"
import { formatCount, formatRate } from "@/lib/format"
import type { DeviceState, Me, ProfileList, Status } from "@/lib/types"

import { FlowView } from "./components/flow/flow-view"
import { LivePanel, RunAlerts } from "./components/live-panel"
import { ModulePanel } from "./components/module-panel"
import { ProfilePanel } from "./components/profile-panel"
import { RunControls } from "./components/run-controls"
import { RunsPanel } from "./components/runs-panel"
import { StatusBar } from "./components/status-bar"

/** How often the module is re-probed.  It reads sysfs; it costs nothing. */
const DEVICE_INTERVAL = 5000

/** Remembered per browser: the averaging window this operator works in. */
const AVERAGE_KEY = "mte.average"

/** And which experiment they are on. */
const PROFILE_KEY = "mte.profile"

/** And which tab, so a reload during a run comes back watching it. */
const TAB_KEY = "mte.tab"

/** And whether someone who may control chose to just watch. */
const MODE_KEY = "mte.mode"
type Mode = "control" | "monitor"

/** A portal role change reaches the page within this. */
const ME_INTERVAL = 30000

function remembered(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    // Private window, or storage turned off. The defaults are all fine.
    return null
  }
}

function remember(key: string, value: string | null): void {
  try {
    if (value) window.localStorage.setItem(key, value)
    else window.localStorage.removeItem(key)
  } catch {
    /* nothing to do: the choice just will not survive a reload */
  }
}

function loadAverage(): number {
  const raw = Number(remembered(AVERAGE_KEY))
  return Number.isFinite(raw) && raw > 0 ? raw : 60
}

/**
 * Three tabs, by what you are doing rather than by what the data is.
 *
 *   Setup      the module, and the experiment it is wired for
 *   DAQ        start it, stop it, watch it
 *   Past runs  what it produced
 *
 * They are three different sittings: you set the module up once a week, watch
 * it for a shift, and read the archive afterwards. Putting them on one page
 * meant everything was always half-scrolled off.
 *
 * What does *not* go in a tab is the status strip beside them: whether the
 * module is there and whether a run is going are true regardless of what you
 * came to do, and both are things you can waste an hour not noticing.
 */
export default function App() {
  const [average, setAverage] = useState(loadAverage)
  const { status, live } = useStatusStream(average)
  const { pending, run: act } = useAction()

  const [device, setDevice] = useState<DeviceState | null>(null)
  const [profiles, setProfiles] = useState<ProfileList | null>(null)
  const [profileId, setProfileId] = useState<string | null>(() => remembered(PROFILE_KEY))
  const [tab, setTab] = useState<string>(() => remembered(TAB_KEY) ?? "daq")
  /** Bumped whenever a run starts or stops, so the catalog re-reads. */
  const [generation, setGeneration] = useState(0)

  // Control or monitoring (what mte_monitoring used to be). Who may control is
  // the server's call (/api/me, enforced on every write); anyone who may can
  // also step down to monitoring, where nothing that starts, stops or
  // configures the module is drawn.
  const [me, setMe] = useState<Me | null>(null)
  const [chosen, setChosen] = useState<Mode>(() => (remembered(MODE_KEY) === "monitor" ? "monitor" : "control"))
  const mayControl = me?.control ?? false
  const control = mayControl && chosen === "control"
  useEffect(() => {
    const ask = () => api.me().then(setMe).catch(() => undefined)
    ask()
    const timer = setInterval(ask, ME_INTERVAL)
    return () => clearInterval(timer)
  }, [])
  const chooseMode = (next: Mode) => {
    setChosen(next)
    remember(MODE_KEY, next)
  }
  // There is no Profile tab to be on while monitoring.
  const shown = !control && tab === "setup" ? "daq" : tab

  const refreshDevice = useCallback(() => {
    api
      .device()
      .then(setDevice)
      .catch(() => setDevice(null))
  }, [])

  /** Returns the promise, so a caller can wait for the list to include what it
   *  just created before selecting it. */
  const refreshProfiles = useCallback(
    () =>
      api
        .profiles()
        .then((answer) => {
          setProfiles(answer)
          return answer
        })
        .catch(() => {
          setProfiles(null)
          return null
        }),
    [],
  )

  useEffect(() => {
    refreshDevice()
    const timer = setInterval(refreshDevice, DEVICE_INTERVAL)
    return () => clearInterval(timer)
  }, [refreshDevice])

  useEffect(() => {
    refreshProfiles()
  }, [refreshProfiles, generation])

  const chooseProfile = useCallback((id: string | null) => {
    setProfileId(id)
    remember(PROFILE_KEY, id)
  }, [])

  // Fall back to the first profile when none is chosen, or when the remembered
  // one has been deleted -- an empty picker with profiles behind it is a dead
  // end the operator has to guess their way out of.
  //
  // Deliberately keyed on the profile *list* and not on the selection. Keyed on
  // both, this fires the instant anything selects a profile the last-fetched
  // list has not caught up with -- and puts the selection straight back. That
  // is a real thing that happened twice: it made New look like a dead button,
  // and it threw away a just-created profile's channels. A stale list is the
  // wrong thing to judge a selection against, so this only judges a fresh one.
  useEffect(() => {
    const saved = profiles?.profiles ?? []
    if (saved.length === 0) return
    if (profileId && saved.some((profile) => profile.id === profileId)) return
    chooseProfile(saved[0].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles])

  // Monitoring follows the run: when one starts under another profile, this
  // page looks at that profile, not at whatever was last picked here.
  const runningProfile = status?.profile?.id
  useEffect(() => {
    if (!control && runningProfile && runningProfile !== profileId) chooseProfile(runningProfile)
  }, [control, runningProfile, profileId, chooseProfile])

  // A run ending is when the archive gains a row worth re-reading -- also when
  // somebody else ended it.
  const runState = status?.state
  useEffect(() => {
    if (runState === "finished" || runState === "failed") setGeneration((value) => value + 1)
  }, [runState])

  const chooseTab = useCallback((value: string) => {
    setTab(value)
    remember(TAB_KEY, value)
  }, [])

  const chooseAverage = useCallback((seconds: number) => {
    setAverage(seconds)
    remember(AVERAGE_KEY, String(seconds))
  }, [])

  const onRunChanged = useCallback(() => {
    setGeneration((value) => value + 1)
    refreshDevice()
  }, [refreshDevice])

  const stop = useCallback(
    () =>
      act(
        "stop",
        async () => {
          await api.stop()
          onRunChanged()
        },
        "Stopped. The module was drained and the files closed.",
      ),
    [act, onRunChanged],
  )

  const running = status ? ["starting", "running", "stopping"].includes(status.state) : false
  const profile = profiles?.profiles.find((each) => each.id === profileId) ?? null

  const counting = (status?.counters ?? []).some((row) => row.rate != null)
  const total = (status?.counters ?? []).reduce((sum, row) => sum + (row.rate ?? 0), 0)

  return (
    <Screen
      top={
        <>
          <Brand name="MTE DAQ" readOnly={!control} />
          <Tabs
            items={[
              ...(control ? [{ value: "setup", label: "Profile" }] : []),
              { value: "daq", label: control ? "DAQ" : "Live" },
              { value: "runs", label: "Past runs" },
            ]}
            value={shown}
            onChange={chooseTab}
          />
          <Spacer />
          <StatusBar
            device={device}
            status={status}
            live={live}
            stopping={pending === "stop"}
            onStop={control ? stop : undefined}
          />
          <Total label="total" value={<Hold reserve={["888.88 k"]}>{counting ? formatRate(total) : "—"}</Hold>} unit="/s" />
          {mayControl ? (
            <Choice
              small
              options={[
                { value: "control", label: "Control" },
                { value: "monitor", label: "Monitor" },
              ]}
              value={control ? "control" : "monitor"}
              onChange={chooseMode}
            />
          ) : null}
          <ThemeSwitch />
        </>
      }
      status={
        <>
          <span>NoticeKOREA CENS scaler</span>
          <span className="num">periods {formatCount(status?.rows ?? 0)}</span>
          <span className="num">stamps {formatCount(status?.stamp_events ?? 0)}</span>
          {status?.malformed ? <span className="tone-text-warn num">malformed {formatCount(status.malformed)}</span> : null}
        </>
      }
    >
      {shown === "setup" ? (
        <Stack gap="xl">
          <ModulePanel device={device} onRefresh={refreshDevice} disabled={running} profileId={profileId} />
          <ProfilePanel list={profiles} selectedId={profileId} onSelect={chooseProfile} onChanged={refreshProfiles} locked={running} />
        </Stack>
      ) : shown === "daq" ? (
        <div className="mte-daq">
          {control ? (
            <RunControls
              status={status}
              device={device}
              profiles={profiles?.profiles ?? []}
              profileId={profileId}
              onProfile={chooseProfile}
              onChanged={onRunChanged}
            />
          ) : (
            <RunSummary status={status} profileName={profile?.name ?? ""} />
          )}
          <RunAlerts status={status} />
          <FlowView status={status} profile={profile} />
          {/* Everything the tiles leave out: the averaging window, the tables,
              several channels on one chart over the whole run, the raw rows. */}
          <LivePanel status={status} profile={profile} averageSeconds={average} onAverage={chooseAverage} alerts={false} />
        </div>
      ) : (
        <RunsPanel profileId={profileId} profileName={profile?.name ?? ""} refreshKey={generation} readOnly={!control} />
      )}
    </Screen>
  )
}

/**
 * What is being watched, in words.
 *
 * The control page has this implicitly, in the form you just filled in. Here
 * there is no form, so a reader who walked up to the screen has nothing else
 * telling them which run these numbers belong to.
 */
function RunSummary({ status, profileName }: { status: Status | null; profileName: string }) {
  // One line of one height whatever the run is doing (NEON rule 5): a run
  // starting or ending changes its words, never what is below it.
  const running = !!status && ["starting", "running", "stopping"].includes(status.state)
  const words = !status
    ? "…"
    : running
      ? [
          `${profileName}${status.run_number != null ? ` · run ${status.run_number}` : " · monitor"}`,
          `${status.rows} counting periods · ${status.stamp_events} time stamps · ${status.count_period_ms} ms period`,
          status.note ? `“${status.note}”` : "",
        ].filter(Boolean).join("   ")
      : `No run is in progress. The numbers below are the last run's, left as they finished${
          status.run_number != null ? ` — ${profileName} run ${status.run_number}` : ""
        }.`
  return (
    <div className={`mte-summary${running ? "" : " faint"}`} title={words}>
      {words}
    </div>
  )
}
