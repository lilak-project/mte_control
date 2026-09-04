import { useCallback, useState } from "react"
import { notifications } from "@mantine/notifications"

import { errorMessage } from "@/lib/api"

/**
 * Run one operator action at a time, and say how it went.
 *
 * Starting a run writes the setup into the module and waits for it to open;
 * stopping one waits for the module to drain. Both are slow enough that a
 * second click would land before the first finished, so the key of the running
 * action is exposed and the buttons that would collide with it are disabled.
 */
export function useAction() {
  const [pending, setPending] = useState<string | null>(null)

  const run = useCallback(
    async (key: string, action: () => Promise<unknown>, success?: string) => {
      setPending(key)
      try {
        await action()
        if (success) notifications.show({ message: success, color: "teal" })
        return true
      } catch (error) {
        // Verbatim: the backend's message names the device node or the run
        // number, and a rewritten one would lose that.
        notifications.show({
          title: "That did not work",
          message: errorMessage(error),
          color: "red",
          autoClose: 12000,
          style: { whiteSpace: "pre-wrap" },
        })
        return false
      } finally {
        setPending(null)
      }
    },
    [],
  )

  return { pending, run }
}
