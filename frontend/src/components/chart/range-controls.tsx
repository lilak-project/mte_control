import { ActionIcon, Group, Tooltip } from "@mantine/core"
import { ChevronLeft, ChevronRight, RotateCcw, ZoomIn, ZoomOut } from "lucide-react"

import { Choice } from "@neon"

import { RUN_PRESETS, type RunWindowControl } from "./use-run-window"

/**
 * The window, as one row of buttons.
 *
 * The presets are widths; **All** is not -- it is however long the run is,
 * which can be a minute or a month. It sits last, at the end of the row.
 */
export function RangeControls({ range }: { range: RunWindowControl }) {
  return (
    <Group gap="sm" wrap="wrap">
      <Choice
        options={RUN_PRESETS.map((preset) => ({ value: preset.id, label: preset.label }))}
        value={range.presetId}
        onChange={range.choosePreset}
      />

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
