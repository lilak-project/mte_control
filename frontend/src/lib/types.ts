/** What the API returns.  Names match the backend's JSON exactly. */

export interface DeviceState {
  present: boolean
  ok: boolean
  writable: boolean
  node: string | null
  bus: number | null
  address: number | null
  mode: string | null
  owner: string | null
  product: string | null
  manufacturer: string | null
  serial: string | null
  runner: string
  runner_ok: boolean
  problems: string[]
  remedy: string | null
  busy: boolean
}

export interface DeviceTest {
  ok: boolean
  opened: boolean
  exit_code: number
  seconds: number
  /** The setup the module was checked against, and whether it had to be written. */
  setup: {
    id: string
    name: string
    /** True when the module did not match and has been reconfigured. */
    rewrote: boolean
    mismatches: string[]
  }
  /** The module's own readback: down-scale and input level per channel. */
  readback: string[]
  output: string[]
}

/** One counter channel, as the live status reports it. */
export interface CounterRow {
  channel: number
  /** "Ch13 PMT top" — the number, and the profile's name for it when it has one. */
  label: string
  /** Counts in the latest counting period, exactly as the module reported. */
  count: number | null
  /** The same, per second. */
  rate: number | null
  /** Module clock of that reading, seconds since the run began. */
  at: number | null
  mean: number | null
  mean_rate: number | null
  min: number | null
  max: number | null
  samples: number
  /** Seconds the averaging window actually covers, which early on is less. */
  window_span: number
  run_mean: number | null
  run_mean_rate: number | null
  total: number
}

/** One time-stamp channel: how often it fired. */
export interface StampRow {
  channel: number
  label: string
  /** False for a channel that fired without being in the profile. */
  expected: boolean
  total: number
  rate: number | null
  /** The last second that finished; null until one has. */
  rate_1s: number | null
  /** Per second over the ten complete seconds before now. */
  rate_10s: number | null
  mean_rate: number | null
  first: number | null
  last: number | null
  recent: number[]
}

export type RunState = "idle" | "starting" | "running" | "stopping" | "finished" | "failed"

/** A named experiment: its channels, their names, and their levels. */
export interface Profile {
  id: string
  name: string
  note: string
  /** Channels this experiment reads. 1–10 are triggers, 11–20 counters. */
  selected: number[]
  names: Record<string, string>
  input_type: number[]
  down_scale: number[]
  updated_at: number
  /** Where this profile's runs live. */
  directory: string
  counter_channels: number[]
  trigger_channels: number[]
  labels: Record<string, string>
  live_channels?: number[]
  live_shown?: number[]
  /** Present on the profile list; absent on a run's stored snapshot. */
  next_run?: number
  run_count?: number
  setup_text?: string
}

export interface ProfileList {
  profiles: Profile[]
  channels: { all: number[]; trigger: number[]; counter: number[]; down_scale: number[] }
  defaults: { down_scale: number[]; input_type: number[] }
}

export interface Status {
  type?: "status"
  state: RunState
  mode: "idle" | "run" | "monitor"
  run_number: number | null
  name: string
  note: string
  started_at: number | null
  stopped_at: number | null
  elapsed: number | null
  acq_time_sec: number | null
  count_period_ms: number | null
  /** The profile this run belongs to: its files, its numbering, its channels. */
  profile: Profile | null
  sid: number | null
  command: string
  error: string | null
  exit_code: number | null
  average_seconds: number
  /** Newest module clock seen, seconds since the run began. */
  module_time: number
  rows: number
  stamp_events: number
  malformed: number
  skipped_bytes: number
  counters: CounterRow[]
  stamps: StampRow[]
  /** The last few counting periods, as the runner prints them. */
  counter_print: CounterPrint
  /** Hits per second per channel, for the last few complete seconds. */
  stamp_print: StampPrint
  /** How many rows and seconds those two cover. */
  print_rows: number
  log: string[]
}

export interface CounterPrint {
  channels: number[]
  labels: string[]
  rows: { index: number; time: number; stamps: number; counts: number[] }[]
}

export interface StampPrint {
  channels: number[]
  labels: string[]
  rows: { second: number; counts: number[] }[]
}

/** One line on a chart.  `t` is the module clock, in seconds. */
export interface SeriesChannel {
  channel: number
  label: string
  t: number[]
  v: number[]
  /** Samples in the window before decimation. */
  total: number
  dropped: number
}

export interface SeriesResponse {
  channels: SeriesChannel[]
  period?: number
  rows?: number
  span?: [number, number] | null
  events?: number
  malformed?: number
  skipped_bytes?: number
}

export interface RunFiles {
  raw_dir: string | null
  converted_dir: string | null
  counter_txt: string | null
  stamp_txt: string | null
  counter_dat: string | null
  stamp_dat: string | null
  sizes: Record<string, number>
  total_bytes: number
}

export interface Run {
  number: number
  /** Half of a run's identity: numbering restarts inside each profile. */
  profile_id: string
  profile_name: string
  key: string
  name: string
  note: string
  started_at: number | null
  stopped_at: number | null
  /** The profile as it stood when the run was taken. */
  profile: Profile | null
  acq_time_sec: number | null
  count_period_ms: number | null
  exit_code: number | null
  /** "service" when this service started it, "disk" when it was found by scanning. */
  source: "service" | "disk"
  files: RunFiles
}

export interface RunCounterSummary {
  rows: number
  period: number
  span: [number, number] | null
  duration: number
  channels: {
    channel: number
    samples: number
    mean: number | null
    mean_rate: number | null
    min: number | null
    max: number | null
    total: number
  }[]
}

export interface RunStampSummary {
  events: number
  malformed: number
  skipped_bytes: number
  channels: {
    channel: number
    total: number
    mean_rate: number | null
    seconds_live: number
    first: number | null
    last: number | null
    recent: number[]
  }[]
}

export interface RunDetail extends Run {
  counters?: RunCounterSummary
  stamps?: RunStampSummary
}

export interface RunList {
  profile_id: string
  runs: Run[]
  directory: string
  next_number: number
  total: number
}

/** /api/me: who is looking, and whether they may control. */
export interface Me {
  name: string | null
  control: boolean
  /** Run without a portal: nobody to ask, so control is allowed. */
  standalone: boolean
}
