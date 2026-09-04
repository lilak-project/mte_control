import { useCallback, useEffect, useRef, useState } from "react"
import { BASE } from "@/lib/portal-base"

import type { Status } from "@/lib/types"

export interface StatusStream {
  status: Status | null
  /** True while the socket is open, i.e. the readouts are current. */
  live: boolean
  /** Ask the backend to compute the means over a different trailing window. */
  setAverage: (seconds: number) => void
}

function socketUrl(): string {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:"
  // BASE is "" served directly; behind the portal the socket must carry the
  // same `/p/<name>` prefix — the portal proxies WebSockets there too.
  return `${scheme}//${window.location.host}${BASE}/ws/status`
}

/**
 * Subscribe to the backend's status broadcast.
 *
 * Only the present comes down this socket: each channel's latest count and its
 * mean over the chosen window. History is a query against a window, so a
 * browser watching a run that has been going for a day costs the same as one
 * watching a run that started a minute ago.
 *
 * The averaging window is sent up rather than applied here, because the samples
 * it averages are on the server -- the browser only ever sees the newest one.
 * Reconnects on its own with a capped backoff after a drop, and re-sends the
 * window when it does.
 */
export function useStatusStream(average: number): StatusStream {
  const [status, setStatus] = useState<Status | null>(null)
  const [live, setLive] = useState(false)
  const retryRef = useRef(0)
  const socketRef = useRef<WebSocket | null>(null)
  const averageRef = useRef(average)
  averageRef.current = average

  useEffect(() => {
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let closed = false

    const connect = () => {
      const socket = new WebSocket(socketUrl())
      socketRef.current = socket

      socket.onopen = () => {
        retryRef.current = 0
        setLive(true)
        socket.send(JSON.stringify({ average: averageRef.current }))
      }

      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as Status
          if (message.type === "status") setStatus(message)
        } catch {
          /* a malformed frame is not worth tearing the socket down for */
        }
      }

      socket.onclose = () => {
        setLive(false)
        if (closed) return
        // 0.5s, 1s, 2s, 4s, capped at 5s.
        const delay = Math.min(500 * 2 ** retryRef.current, 5000)
        retryRef.current += 1
        retryTimer = setTimeout(connect, delay)
      }

      socket.onerror = () => socket.close()
    }

    connect()
    return () => {
      closed = true
      clearTimeout(retryTimer)
      socketRef.current?.close()
    }
  }, [])

  const setAverage = useCallback((seconds: number) => {
    const socket = socketRef.current
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ average: seconds }))
    }
  }, [])

  useEffect(() => {
    setAverage(average)
  }, [average, setAverage])

  return { status, live, setAverage }
}
