import type { ReactNode } from "react"
import { Text, Tooltip } from "@mantine/core"
import { Info } from "lucide-react"

/**
 * A field label with its explanation behind a small (i).
 *
 * The explanations are worth having and worth reading once. Printed under
 * every box they are a paragraph of grey text between the operator and the
 * controls, on a panel whose whole job is to be quick; on the icon they cost
 * nothing until wanted.
 *
 * Everything a reader needs to *act* stays in the label itself -- the unit, in
 * particular. A tooltip is for what the field means, never for what it takes.
 */
export function Label({ children, help }: { children: ReactNode; help: ReactNode }) {
  return (
    <Text component="span" size="sm" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      {children}
      <Tooltip
        label={help}
        multiline
        w={330}
        withArrow
        // Tooltips on a lab screen are read slowly and at arm's length; the
        // default delay-free flicker as the pointer crosses a form is worse
        // than useless.
        openDelay={200}
        events={{ hover: true, focus: true, touch: true }}
      >
        <Text component="span" c="dimmed" style={{ display: "inline-flex", cursor: "help" }}>
          <Info size={13} />
        </Text>
      </Tooltip>
    </Text>
  )
}
