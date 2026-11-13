import { useState, type ReactNode as Node } from "react"
import { Box, Stack, Text } from "@mantine/core"
import type { ReactNode } from "react"

/**
 * A titled block with no border of its own.
 *
 * The heading and the whitespace do the separating, so the page stays free of
 * nested boxes.
 */
export function Section({
  title,
  description,
  action,
  children,
}: {
  title: string
  description?: ReactNode
  action?: ReactNode
  children: ReactNode
}) {
  return (
    // The class names are for a stylesheet that draws a section differently
    // (NEON writes the title on a box's top rule and drops the description).
    <Box className="mte-section">
      <Box
        className="mte-section-head"
        style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}
        mb={description ? 2 : "sm"}
      >
        <Text fw={600} size="lg" className="mte-section-title">
          {title}
        </Text>
        {action}
      </Box>
      {description ? (
        <Text size="sm" c="dimmed" mb="sm" className="mte-section-desc">
          {description}
        </Text>
      ) : null}
      <Stack gap="md">{children}</Stack>
    </Box>
  )
}

/**
 * A two-column list of facts.
 *
 * Every "what is this run" answer is of this shape -- a short label and a value
 * that is usually a path, a number or a time -- so they all get the same grid
 * and line up down the panel.
 */
export function FactGrid({ children }: { children: ReactNode }) {
  return <dl className="fact-grid">{children}</dl>
}

export function Fact({
  label,
  children,
  mono,
}: {
  label: string
  children: ReactNode
  /** For paths, commands and anything else that is literally code. */
  mono?: boolean
}) {
  if (children == null || children === "" || children === false) return null
  return (
    <>
      <dt>{label}</dt>
      <dd className={mono ? "tabular" : undefined}>{children}</dd>
    </>
  )
}


/**
 * A line that is always there (NEON rule 5): quiet it says so faintly; when
 * something is wrong it says that on the same line, in its tone, instead of
 * a box appearing and pushing the page down. The rest opens under it only
 * when asked for.
 */
export function HeldLine({
  tone,
  text,
  more,
}: {
  tone: "warn" | "alarm" | null
  text: string
  more?: Node
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mte-alerts">
      <div className={`mte-alertline ${tone ? `tone-text-${tone}` : "faint"}`} role={tone ? "alert" : undefined}>
        <span className="mte-alerttext" title={text}>
          {tone ? (tone === "alarm" ? "■ " : "▲ ") : ""}
          {text}
        </span>
        {more ? (
          <button type="button" className="neon-command small" onClick={() => setOpen((v) => !v)}>
            {open ? "hide" : "details"}
          </button>
        ) : null}
      </div>
      {open && more ? <div className="mte-alertmore">{more}</div> : null}
    </div>
  )
}
