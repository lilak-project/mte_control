import { ActionIcon, Button, Group, Tooltip } from "@mantine/core"
import { ChevronLeft, ChevronRight, RotateCcw, ZoomIn, ZoomOut } from "lucide-react"

import { RUN_PRESETS, type RunWindowControl } from "./use-run-window"

/**
 * The window, as one row of buttons.
 *
 * The presets are widths; **All** is not -- it is however long the run is,
 * which can be a minute or a month. It is coloured differently for that reason:
 * it answers a different question from the ones beside it, and reaching for it
 * by accident when you wanted a minute is a chart you have to re-navigate.
 */
export function RangeControls({ range }: { range: RunWindowControl }) {
  return (
    <Group gap="sm" wrap="wrap">
      <Button.Group>
        {RUN_PRESETS.map((preset) => {
          const active = range.presetId === preset.id
          const everything = preset.seconds === null
          return (
            <Button
              key={preset.id}
              size="xs"
              px="sm"
              variant={active ? "filled" : "default"}
              color={everything ? "grape" : "blue"}
              onClick={() => range.choosePreset(preset.id)}
            >
              {preset.label}
            </Button>
          )
        })}
      </Button.Group>

      <Group gap={4}>
        {/* Greyed at the ends rather than sliding into blank axis: an empty
            chart reads as "the run stopped", not "there is nothing here". */}
        <IconButton
          label={range.atStart ? "This is the start of the run" : "Back one half window"}
          disabled={range.atStart}
          onClick={() => range.pan(-0.5)}
        >
          <ChevronLeft size={16} />
        </IconButton>
        <IconButton label="Zoom out" onClick={() => range.zoom(2)}>
          <ZoomOut size={15} />
        </IconButton>
        <IconButton label="Zoom in" onClick={() => range.zoom(0.5)}>
          <ZoomIn size={15} />
        </IconButton>
        <IconButton
          label={range.atEnd ? "This is the newest data there is" : "Forward one half window"}
          disabled={range.atEnd}
          onClick={() => range.pan(0.5)}
        >
          <ChevronRight size={16} />
        </IconButton>
        <IconButton label="Back to the preset window" onClick={range.reset}>
          <RotateCcw size={14} />
        </IconButton>
      </Group>
    </Group>
  )
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <Tooltip label={label}>
      {/* A disabled control fires no events, so the tooltip needs a wrapper
          that does -- otherwise the reason it is disabled is unreadable. */}
      <div>
        <ActionIcon size="md" variant="default" disabled={disabled} onClick={onClick} aria-label={label}>
          {children}
        </ActionIcon>
      </div>
    </Tooltip>
  )
}
