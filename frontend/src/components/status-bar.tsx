import { Badge, Button, Group, Text, Tooltip } from "@mantine/core"
import { CircleCheck, CircleX, Plug, Square, WifiOff } from "lucide-react"

import { formatRunClock } from "@/lib/format"
import type { DeviceState, Profile, Status } from "@/lib/types"

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
  profile,
  live,
  stopping,
  onStop,
}: {
  device: DeviceState | null
  status: Status | null
  profile: Profile | null
  /** The status socket is open, i.e. the numbers are current. */
  live: boolean
  stopping: boolean
  onStop: () => void
}) {
  const running = status ? ["starting", "running", "stopping"].includes(status.state) : false

  const module = !device
    ? { color: "gray", label: "Checking the module…", icon: <Plug size={13} /> }
    : device.ok
      ? { color: "teal", label: "Module ready", icon: <CircleCheck size={13} /> }
      : device.present
        ? { color: "red", label: "Module cannot be opened", icon: <CircleX size={13} /> }
        : { color: "red", label: "Module not connected", icon: <Plug size={13} /> }

  return (
    <Group gap="sm" wrap="wrap">
      <Badge color={module.color} variant="light" leftSection={module.icon}>
        {module.label}
      </Badge>

      {running ? (
        <>
          <Badge color={status?.state === "stopping" ? "orange" : "teal"} variant="filled">
            {status?.mode === "monitor"
              ? "Monitoring"
              : status?.state === "starting"
                ? "Opening the module…"
                : status?.state === "stopping"
                  ? "Draining and closing…"
                  : `Running · ${profile?.name ?? ""} run ${status?.run_number ?? ""}`}
          </Badge>
          <Text size="sm" className="tabular" fw={600}>
            {formatRunClock(status?.module_time ?? 0)}
          </Text>
          <Tooltip label="Stop the run: the module is drained and the files closed">
            <Button
              size="compact-xs"
              color="red"
              leftSection={<Square size={12} />}
              loading={stopping}
              onClick={onStop}
            >
              Stop
            </Button>
          </Tooltip>
        </>
      ) : (
        <Badge color="gray" variant="light">
          {status?.state === "failed" ? "Last run failed" : "Idle"}
        </Badge>
      )}

      {/* The socket, not the module: a page that has stopped updating must say
          so, or a frozen reading is read as a steady one. */}
      {!live ? (
        <Badge color="orange" leftSection={<WifiOff size={13} />}>
          Reconnecting — these numbers are frozen
        </Badge>
      ) : null}
    </Group>
  )
}
