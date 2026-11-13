import { useState } from "react"
import { Alert, Badge, Button, Code, Group, Paper, Stack, Text } from "@mantine/core"
import { CircleCheck, CircleX, Plug, RefreshCw, Usb } from "lucide-react"

import { api } from "@/lib/api"
import { useAction } from "@/hooks/use-action"
import type { DeviceState, DeviceTest } from "@/lib/types"

import { Fact, FactGrid, HeldLine } from "./section"

/**
 * Is the module connected, and may we open it?
 *
 * Two questions, and for this module they have had different answers for a long
 * time: the SCALER has always been plugged in, and opening it has always needed
 * root -- which is the whole reason the runner lives behind `sudo -i`. So the
 * panel answers them separately and, when the second one is no, prints the
 * command that fixes it rather than a shrug.
 */
export function ModulePanel({
  device,
  onRefresh,
  disabled,
  profileId,
}: {
  device: DeviceState | null
  onRefresh: () => void
  /** True while a run holds the module: testing it would interrupt the run. */
  disabled: boolean
  /** The profile the module is checked against; the runner cannot open it without one. */
  profileId: string | null
}) {
  const { pending, run } = useAction()
  const [test, setTest] = useState<DeviceTest | null>(null)

  const state = !device
    ? { color: "gray", label: "Checking…", icon: <Usb size={14} /> }
    : device.ok
      ? { color: "teal", label: "Module ready", icon: <CircleCheck size={14} /> }
      : device.present
        ? { color: "red", label: "Cannot be opened", icon: <CircleX size={14} /> }
        : { color: "red", label: "Not connected", icon: <Plug size={14} /> }

  return (
    <Paper withBorder p="md">
      <Stack gap="sm">
        <Group justify="space-between" wrap="wrap" gap="sm">
          <Group gap="sm">
            <Badge color={state.color} size="lg" leftSection={state.icon}>
              {state.label}
            </Badge>
            {device?.present ? (
              <Text size="sm" c="dimmed">
                {[device.manufacturer, device.product].filter(Boolean).join(" ") || "SCALER"} · bus{" "}
                {device.bus} address {device.address}
              </Text>
            ) : null}
          </Group>
          <Group gap="xs">
            <Button
              variant="default"
              size="xs"
              leftSection={<RefreshCw size={14} />}
              onClick={onRefresh}
            >
              Re-check
            </Button>
            <Button
              variant="default"
              size="xs"
              disabled={disabled || !device?.writable}
              loading={pending === "test"}
              onClick={() =>
                run(
                  "test",
                  async () => setTest(await api.testDevice(profileId)),
                  "The module answered.",
                )
              }
              // Worth spelling out: this is not a passive check.
              title={
                disabled
                  ? "A run is in progress; stop it first."
                  : "Open the module for two seconds. This resets the scaler, and " +
                    "writes the chosen setup into it if the module does not already match."
              }
            >
              Open it and see
            </Button>
          </Group>
        </Group>

        {/* Held (NEON rule 5): the module dropping out fills this line in
            place instead of pushing the page. */}
        <HeldLine
          tone={device && !device.ok ? "alarm" : null}
          text={
            !device
              ? "Checking the module…"
              : device.ok
                ? "The module is usable"
                : `The module is not usable: ${device.problems[0] ?? ""}`
          }
          more={
            device && !device.ok ? (
              <Stack gap="xs">
                {device.problems.map((problem) => (
                  <Text size="sm" key={problem}>
                    {problem}
                  </Text>
                ))}
                {device.remedy ? (
                  <>
                    <Text size="sm" fw={600}>
                      This is fixed once, not per run:
                    </Text>
                    <Code block>{device.remedy}</Code>
                  </>
                ) : null}
              </Stack>
            ) : undefined
          }
        />

        {device?.present ? (
          <FactGrid>
            <Fact label="Device node" mono>
              {device.node} {device.mode} {device.owner}
            </Fact>
            <Fact label="Runner" mono>
              {device.runner}
              {device.runner_ok ? "" : "  (not executable)"}
            </Fact>
            {device.serial ? (
              <Fact label="Serial" mono>
                {device.serial}
              </Fact>
            ) : null}
          </FactGrid>
        ) : null}

        {test ? (
          // neon:allow — appears because Test was pressed, not on its own (rule 5 is about changes nobody asked for)
          <Alert
            color={test.ok ? "teal" : "red"}
            title={test.ok ? "The module answered" : "It did not"}
            // Twenty-eight lines of readback is worth reading once and then
            // getting out of the way of the run controls underneath.
            withCloseButton
            onClose={() => setTest(null)}
          >
            <Stack gap="xs">
              <Text size="xs" c="dimmed">
                {test.seconds} s · runner exited {test.exit_code}
                {test.setup?.name ? ` · checked against "${test.setup.name}"` : ""}
              </Text>

              {/* The one side effect worth putting in front of someone rather
                  than leaving in the log: the module's configuration changed. */}
              {test.setup?.rewrote ? (
                <Text size="sm" fw={600} c="orange.8">
                  The module did not match that setup, so it has been written into it.
                  {test.setup.mismatches.length > 0
                    ? ` (${test.setup.mismatches.length} channel${
                        test.setup.mismatches.length === 1 ? "" : "s"
                      } differed)`
                    : ""}
                </Text>
              ) : test.opened ? (
                <Text size="sm">The module was already configured that way; nothing was changed.</Text>
              ) : null}

              <div className="log">{test.output.join("\n")}</div>
            </Stack>
          </Alert>
        ) : null}
      </Stack>
    </Paper>
  )
}
