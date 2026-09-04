/**
 * Series colours.
 *
 * The validated categorical set, in its fixed order. Colours are assigned to a
 * channel by its position in the channel list and never cycled or re-ordered:
 * the order is what makes the set safe for red-green colour blindness, and a
 * chart that repainted its lines when you unticked a channel would be worse
 * than one with fewer colours.
 *
 * Checked with the palette validator against this page's white surface:
 * lightness band, chroma floor, contrast, and colour-vision separation all
 * pass -- worst adjacent pair ΔE 9.1 under protanopia, 19.6 under normal
 * vision. Three of them (aqua, yellow, magenta) sit below 3:1 contrast on
 * white, which is allowed here only because no value is ever carried by the
 * colour alone: the table beside the chart names every channel and its number,
 * and the chart's own legend repeats them live at the cursor.
 */
export const SERIES_COLORS = [
  "#2a78d6", // blue
  "#eb6834", // orange
  "#1baf7a", // aqua
  "#eda100", // yellow
  "#e87ba4", // magenta
  "#008300", // green
  "#4a3aa7", // violet
  "#e34948", // red
] as const

/**
 * The most series one chart will draw.
 *
 * The scaler has ten counter channels and the palette guarantees eight. Rather
 * than invent a ninth hue -- which is where a categorical set stops being
 * distinguishable and the guarantee quietly becomes false -- the chart takes
 * eight and the table carries all ten.
 */
export const MAX_SERIES = SERIES_COLORS.length

/** The colour for the `position`-th line on a chart.  Never cycles. */
export function seriesColor(position: number): string {
  return SERIES_COLORS[position] ?? "#868e96"
}

/** Chart chrome, one step off the surface so it stays recessive. */
export const AXIS_COLOR = "#868e96"
export const GRID_COLOR = "#e9ecef"
export const TICK_COLOR = "#dee2e6"
