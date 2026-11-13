import { Command, StateDot, type Tone } from "@neon"

import { formatRunClock } from "@/lib/format"
import type { DeviceState, Status } from "@/lib/types"

/**
 * The three things that must be true on every tab.
 *
 * Splitting the page into tabs buys room, and costs exactly this: on the
 * profile tab or the archive you can no longer see that a run is in progress,
 * or that the module has dropped off the bus. Both are things you can waste an
 * hour not noticing. So they come out of their panels and sit beside the tabs,
 * where they are visible whichever one is open.
 *
 * The stop button is here for the same reason. A run that needs stopping needs
 * stopping now, and "navigate to the DAQ tab first" is not a thing to ask of
 * someone who has just seen a number go wrong.
 */
export function StatusBar({
  device,
  status,
  live,
  stopping,
  onStop,
}: {
  device: DeviceState | null
  status: Status | null
  /** The status socket is open, i.e. the numbers are current. */
  live: boolean
  stopping: boolean
  /** Absent while monitoring: no Stop is drawn. */
  onStop?: () => void
}) {
  const running = status ? ["starting", "running", "stopping"].includes(status.state) : false

  const module: { tone: Tone; label: string } = !device
    ? { tone: "idle", label: "checking…" }
    : device.ok
      ? { tone: "ok", label: "module ready" }
      : device.present
        ? { tone: "alarm", label: "module error" }
        : { tone: "alarm", label: "no module" }

  const run = status?.mode === "monitor"
    ? "monitoring"
    : status?.state === "starting"
      ? "opening…"
      : status?.state === "stopping"
        ? "closing…"
        : `running · run ${status?.run_number ?? ""}`

  return (
    <>
      <StateDot
        tone={module.tone}
        reserve={["checking…", "module ready", "module error", "no module"]}
      >
        {module.label}
      </StateDot>
      {running ? (
        <>
          {/* The profile is on the run box's PROFILE tag; here the words have a
              longest form, and keep its room (NEON rule 5). */}
          <StateDot
            tone={status?.state === "stopping" ? "warn" : "ok"}
            blink
            reserve={["monitoring", "opening…", "closing…", "running · run 88888"]}
          >
            {run}
          </StateDot>
          <span className="num">{formatRunClock(status?.module_time ?? 0)}</span>
          {/* No confirm: a run that needs stopping needs stopping now. */}
          {onStop ? (
            <span title="Stop the run: the module is drained and the files closed">
              <Command small danger disabled={stopping} onRun={onStop}>
                {stopping ? "Stopping…" : "Stop"}
              </Command>
            </span>
          ) : null}
        </>
      ) : (
        <StateDot tone={status?.state === "failed" ? "alarm" : "idle"} reserve={["last run failed", "idle"]}>
          {status?.state === "failed" ? "last run failed" : "idle"}
        </StateDot>
      )}
      {/* The socket, not the module: a page that has stopped updating must say
          so, or a frozen reading is read as a steady one. */}
      {!live ? <span className="tone-text-warn">▲ reconnecting · numbers frozen</span> : null}
    </>
  )
}
