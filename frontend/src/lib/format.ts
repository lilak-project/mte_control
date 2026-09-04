/** Turning numbers into the strings on the screen. */

/** "1 234 567" -- a count, grouped so eight digits can be read at a glance. */
export function formatCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—"
  return Math.round(value).toLocaleString("en-US").replace(/,/g, " ")
}

/**
 * A rate, in whichever unit keeps it to three or four significant figures.
 *
 * A scaler channel runs from nothing to a few hundred kilohertz in the same
 * table, and a column of raw counts-per-second at both ends is unreadable. The
 * unit is part of the returned string rather than a column heading for exactly
 * that reason: the rows do not share one.
 */
export function formatRate(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—"
  const magnitude = Math.abs(value)
  if (magnitude === 0) return "0"
  if (magnitude >= 1e6) return `${(value / 1e6).toFixed(2)} M`
  if (magnitude >= 1e3) return `${(value / 1e3).toFixed(magnitude >= 1e5 ? 1 : 2)} k`
  if (magnitude >= 10) return value.toFixed(1)
  if (magnitude >= 1) return value.toFixed(2)
  return value.toFixed(3)
}

/** An axis tick.  Same idea as `formatRate`, without a trailing space. */
export function formatTick(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return ""
  const magnitude = Math.abs(value)
  if (magnitude >= 1e6) return `${(value / 1e6).toFixed(1)}M`
  if (magnitude >= 1e3) return `${(value / 1e3).toFixed(magnitude >= 1e4 ? 0 : 1)}k`
  if (magnitude >= 10 || magnitude === 0) return value.toFixed(0)
  if (magnitude >= 1) return value.toFixed(1)
  return value.toPrecision(2)
}

/**
 * A point on the module's own clock: seconds since the run started.
 *
 * Never a wall clock. The module counts from zero at SCALER_start and every
 * number in both data files is on that clock; showing them as times of day
 * would mean adding an offset the module does not know about, and being wrong
 * by however long the runner took to open the device.
 */
export function formatRunClock(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—"
  const whole = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const rest = whole % 60
  const pad = (value: number) => String(value).padStart(2, "0")
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`
}

/** "3.2 h" -- a span, in whichever unit keeps it to two or three characters. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—"
  if (seconds < 1) return `${(seconds * 1000).toFixed(0)} ms`
  if (seconds < 90) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`
  if (seconds < 5400) return `${(seconds / 60).toFixed(0)} min`
  if (seconds < 172800) return `${(seconds / 3600).toFixed(1)} h`
  return `${(seconds / 86400).toFixed(1)} d`
}

const pad = (value: number) => String(value).padStart(2, "0")

/** "2026-08-30 14:32" -- a wall clock, for when a run was taken. */
export function formatStamp(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—"
  const date = new Date(seconds * 1000)
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

/** "4 s ago" -- how stale something is, which is often the thing worth knowing. */
export function formatAgo(at: number | null | undefined, now = Date.now() / 1000): string {
  if (at == null || !Number.isFinite(at)) return "never"
  const seconds = now - at
  if (seconds < 2) return "just now"
  return `${formatDuration(seconds)} ago`
}

/** "1.4 MB" -- a file size. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "—"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} kB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

/** How a run is referred to: its number, and its name when it has one. */
export function runTitle(run: { number: number; name?: string }): string {
  return run.name ? `Run ${run.number} · ${run.name}` : `Run ${run.number}`
}
