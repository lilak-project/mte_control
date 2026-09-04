"""The live status socket.

Only the present goes over this socket: each channel's latest count, its mean
over the window the browser asked for, and the state of the run. History is a
query against a window, so a browser watching a run that has been going for a
day costs the same as one watching a run that started a minute ago.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..acquisition import acquisition
from ..config import BROADCAST_INTERVAL

log = logging.getLogger("mte.status")
router = APIRouter()


class StatusBroadcaster:
    """One snapshot per tick, to every browser watching.

    Each client carries its own averaging window, because two people can
    reasonably watch the same run over ten seconds and over five minutes. The
    snapshot is cheap -- means over a window are a slice and a sum -- so it is
    built per client rather than shared.
    """

    def __init__(self, interval: float = BROADCAST_INTERVAL) -> None:
        self.interval = interval
        self._clients: dict[WebSocket, float] = {}
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._run(), name="mte-status-broadcast")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    async def subscribe(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self._clients[websocket] = 60.0
        # At once, so a fresh tab is not blank for up to one interval.
        await websocket.send_json(self._payload(60.0))

    def unsubscribe(self, websocket: WebSocket) -> None:
        self._clients.pop(websocket, None)

    def set_window(self, websocket: WebSocket, seconds: float) -> None:
        if websocket in self._clients:
            self._clients[websocket] = max(1.0, min(86400.0, seconds))

    @staticmethod
    def _payload(average_seconds: float) -> dict:
        snapshot = acquisition.snapshot(average_seconds=average_seconds)
        snapshot["type"] = "status"
        return snapshot

    async def _run(self) -> None:
        while True:
            await asyncio.sleep(self.interval)
            for websocket, window in list(self._clients.items()):
                try:
                    await websocket.send_json(self._payload(window))
                except Exception:
                    self.unsubscribe(websocket)


broadcaster = StatusBroadcaster()


@router.websocket("/ws/status")
async def status_stream(websocket: WebSocket) -> None:
    await broadcaster.subscribe(websocket)
    try:
        while True:
            # The only thing a client ever sends is the averaging window it
            # wants its means computed over.
            message = await websocket.receive_json()
            if isinstance(message, dict) and "average" in message:
                broadcaster.set_window(websocket, float(message["average"]))
    except WebSocketDisconnect:
        pass
    except Exception:
        log.debug("status websocket closed unexpectedly", exc_info=True)
    finally:
        broadcaster.unsubscribe(websocket)
