import type {
  Me,
  DeviceState,
  DeviceTest,
  Profile,
  ProfileList,
  RunDetail,
  RunList,
  SeriesResponse,
  Status,
} from "./types"

import { url } from "@/lib/portal-base"

/** Error carrying the backend's message so the UI can show it verbatim. */
export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = "ApiError"
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url(path), {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  })
  if (!response.ok) throw new ApiError(await readErrorMessage(response), response.status)
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json()
    // FastAPI puts a string in `detail` for HTTPException and a list for
    // request-validation failures.
    if (typeof body?.detail === "string") return body.detail
    if (Array.isArray(body?.detail)) {
      return body.detail.map((item: { msg?: string }) => item.msg ?? "Invalid value").join("; ")
    }
  } catch {
    /* fall through to the status text */
  }
  return response.statusText || `Request failed (${response.status})`
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) })

interface WindowQuery {
  channels?: number[]
  start?: number | null
  end?: number | null
  maxPoints?: number
}

function windowSearch(query: WindowQuery): string {
  const params = new URLSearchParams()
  if (query.channels?.length) params.set("channels", query.channels.join(","))
  if (query.start != null) params.set("start", String(query.start))
  if (query.end != null) params.set("end", String(query.end))
  if (query.maxPoints != null) params.set("max_points", String(query.maxPoints))
  const search = params.toString()
  return search ? `?${search}` : ""
}

export interface StartOptions {
  name?: string
  note?: string
  profile_id?: string | null
  run_number?: number | null
  acq_time_sec: number
  count_period_ms: number
  monitor?: boolean
  force_init?: boolean
}

export interface ProfileBody {
  id?: string | null
  name: string
  selected: number[]
  names: Record<string, string>
  input_type: number[]
  down_scale: number[]
  note?: string
  /** Channels the portal's live tiles show; empty = first counter + first trigger. */
  live_channels?: number[]
}

const profilePath = (id: string) => `/api/profiles/${encodeURIComponent(id)}`

export const api = {
  /** Who is looking, and whether they may control. */
  me: () => request<Me>("/api/me"),

  /** Is the module there and openable?  Reads sysfs; never touches the module. */
  device: () => request<DeviceState>("/api/device"),

  /** Actually open the module for two seconds and report what it said. */
  testDevice: (profileId?: string | null) =>
    request<DeviceTest>(
      `/api/device/test${profileId ? `?profile_id=${encodeURIComponent(profileId)}` : ""}`,
      { method: "POST" },
    ),

  status: (average: number) => request<Status>(`/api/status?average=${average}`),

  start: (options: StartOptions) =>
    request<Status>("/api/run/start", { method: "POST", ...json(options) }),

  stop: () => request<Status>("/api/run/stop", { method: "POST" }),

  /** The live counter buffers, decimated to what a chart can show. */
  liveCounters: (query: WindowQuery) =>
    request<SeriesResponse>(`/api/live/counters${windowSearch(query)}`),

  liveStamps: (query: WindowQuery) =>
    request<SeriesResponse>(`/api/live/stamps${windowSearch(query)}`),

  // -- runs, always within a profile -------------------------------------

  listRuns: (profileId: string, search = "", limit = 500) =>
    request<RunList>(
      `${profilePath(profileId)}/runs?limit=${limit}&search=${encodeURIComponent(search)}`,
    ),

  run: (profileId: string, number: number) =>
    request<RunDetail>(`${profilePath(profileId)}/runs/${number}`),

  /** Metadata only -- no file is moved or rewritten. */
  rename: (profileId: string, number: number, name: string, note: string) =>
    request<RunDetail>(`${profilePath(profileId)}/runs/${number}`, {
      method: "PATCH",
      ...json({ name, note }),
    }),

  runCounters: (profileId: string, number: number, query: WindowQuery) =>
    request<SeriesResponse>(
      `${profilePath(profileId)}/runs/${number}/counters${windowSearch(query)}`,
    ),

  runStamps: (profileId: string, number: number, query: WindowQuery) =>
    request<SeriesResponse>(
      `${profilePath(profileId)}/runs/${number}/stamps${windowSearch(query)}`,
    ),

  // Used as an <a href> (runs-panel), not fetched — so it carries the prefix itself.
  fileUrl: (profileId: string, number: number, which: string) =>
    url(`${profilePath(profileId)}/runs/${number}/file/${which}`),

  preview: async (profileId: string, number: number, which: string): Promise<string> => {
    const response = await fetch(
      url(`${profilePath(profileId)}/runs/${number}/file/${which}?preview=true`),
    )
    if (!response.ok) throw new ApiError(await readErrorMessage(response), response.status)
    return response.text()
  },

  // -- profiles ----------------------------------------------------------

  profiles: () => request<ProfileList>("/api/profiles"),

  saveProfile: (profile: ProfileBody) =>
    request<Profile>("/api/profiles", { method: "PUT", ...json(profile) }),

  importSetup: (name: string, text: string) =>
    request<Profile>("/api/profiles/import", { method: "POST", ...json({ name, text }) }),

  /** Forgets the profile; its runs stay on disk. */
  deleteProfile: (id: string) =>
    request<{ deleted: string; runs_left_on_disk: number }>(profilePath(id), { method: "DELETE" }),
}

/** Message the operator should actually read, from any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
