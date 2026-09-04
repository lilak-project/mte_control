import { Box, Text } from "@mantine/core"

/**
 * A label above a monospaced value.
 *
 * `size="hero"` is for the number the page is currently about -- the run clock
 * while a run is going -- and is read from across the room; everything else on
 * the panel exists to qualify it.
 */
export function Readout({
  label,
  value,
  unit,
  color,
  size = "md",
}: {
  label: string
  value: string
  unit?: string
  /** The series colour, when this readout belongs to a line on the chart. */
  color?: string
  size?: "md" | "hero"
}) {
  const type = size === "hero"
    ? { value: "2.2rem", unit: "1.1rem", label: "sm" as const }
    : { value: "1.15rem", unit: "0.85rem", label: "xs" as const }

  return (
    <Box>
      <Text size={type.label} c="dimmed" fw={500}>
        {/* The swatch ties the number to its trace, and is never the only
            thing carrying that -- the label is right beside it. */}
        {color ? <Box component="span" className="swatch" style={{ background: color }} /> : null}
        {label}
      </Text>
      <Text className="tabular" fz={type.value} fw={600} lh={1.15}>
        {value}
        {unit ? (
          <Text span fz={type.unit} c="dimmed" fw={400} ml={6}>
            {unit}
          </Text>
        ) : null}
      </Text>
    </Box>
  )
}
