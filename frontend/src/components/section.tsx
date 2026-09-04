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
    <Box>
      <Box
        style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}
        mb={description ? 2 : "sm"}
      >
        <Text fw={600} size="lg">
          {title}
        </Text>
        {action}
      </Box>
      {description ? (
        <Text size="sm" c="dimmed" mb="sm">
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
