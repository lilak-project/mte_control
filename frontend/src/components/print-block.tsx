import { Group, Paper, Text } from "@mantine/core"

/**
 * The runner's own printout, as it has always scrolled past in a terminal.
 *
 * A table rather than a block of preformatted text -- the columns still line
 * up, but they can be selected, they reflow, and a screen reader can follow
 * them. What is kept from the terminal is what mattered about it: a fixed
 * handful of the most recent rows, newest at the bottom, in a monospace grid
 * where a column that changes shape is visible before any average has moved.
 *
 * This is the fast view. The chart above it shows a shift; the table beside it
 * shows a minute; this shows the last ten periods, which is where a channel
 * that has just stopped counting actually announces itself.
 */
export function PrintBlock({
  title,
  hint,
  first,
  columns,
  rows,
  empty,
}: {
  title: string
  hint?: string
  /** The leading, non-channel columns: event number, clock, and so on. */
  first: { label: string; values: string[] }[]
  /** One per channel. */
  columns: string[]
  /** Already formatted, newest last. */
  rows: string[][]
  empty: string
}) {
  return (
    <Paper withBorder p={0} style={{ overflow: "hidden" }}>
      <Group justify="space-between" align="baseline" px="xs" py={6} wrap="wrap" gap="xs">
        <Text fw={600} size="sm">
          {title}
        </Text>
        {hint ? (
          <Text size="xs" c="dimmed">
            {hint}
          </Text>
        ) : null}
      </Group>

      {rows.length === 0 ? (
        <Text size="sm" c="dimmed" ta="center" py="lg">
          {empty}
        </Text>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="grid print">
            <thead>
              <tr>
                {first.map((column) => (
                  <th key={column.label}>{column.label}</th>
                ))}
                {columns.map((column) => (
                  <th key={column}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                // The newest row is the one being read; the rest are context.
                <tr key={index} className={index === rows.length - 1 ? "is-newest" : undefined}>
                  {first.map((column) => (
                    <td key={column.label} className="tabular dim">
                      {column.values[index] ?? ""}
                    </td>
                  ))}
                  {row.map((cell, position) => (
                    <td key={position} className={`tabular${cell === "0" ? " quiet" : ""}`}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Paper>
  )
}
