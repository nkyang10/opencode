import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { ServerScope } from "@/utils/server-scope"
import { TurnProgressState } from "./turn-progress"

const remote = "https://remote.example" as ServerScope

describe("turn progress", () => {
  test("records a submitted turn until the server settles it", () => {
    createRoot((dispose) => {
      TurnProgressState.begin(ServerScope.local, "ses_1", "msg_1")
      expect(TurnProgressState.read(ServerScope.local, "ses_1")).toEqual({
        sessionID: "ses_1",
        messageID: "msg_1",
      })
      TurnProgressState.settle(ServerScope.local, "ses_1")
      expect(TurnProgressState.read(ServerScope.local, "ses_1")).toBeUndefined()
      dispose()
    })
  })

  test("keeps sessions and servers apart", () => {
    createRoot((dispose) => {
      TurnProgressState.begin(ServerScope.local, "ses_1", "msg_1")
      TurnProgressState.begin(remote, "ses_1", "msg_2")
      expect(TurnProgressState.read(remote, "ses_1")?.messageID).toBe("msg_2")

      TurnProgressState.settle(remote, "ses_1")
      expect(TurnProgressState.read(remote, "ses_1")).toBeUndefined()
      expect(TurnProgressState.read(ServerScope.local, "ses_1")?.messageID).toBe("msg_1")

      expect(TurnProgressState.hasPending(ServerScope.local)).toBe(true)
      expect(TurnProgressState.hasPending(remote)).toBe(false)

      TurnProgressState.settle(ServerScope.local, "ses_1")
      expect(TurnProgressState.hasPending(ServerScope.local)).toBe(false)
      dispose()
    })
  })

  test("re-submitting a session replaces the pending message", () => {
    createRoot((dispose) => {
      TurnProgressState.begin(ServerScope.local, "ses_4", "msg_4")
      TurnProgressState.begin(ServerScope.local, "ses_4", "msg_5")
      expect(TurnProgressState.read(ServerScope.local, "ses_4")?.messageID).toBe("msg_5")
      TurnProgressState.settle(ServerScope.local, "ses_4")
      dispose()
    })
  })

  test("settles only the submissions the server does not list as running", () => {
    createRoot((dispose) => {
      TurnProgressState.begin(ServerScope.local, "ses_running", "msg_6")
      TurnProgressState.begin(ServerScope.local, "ses_lost", "msg_7")
      TurnProgressState.begin(remote, "ses_remote", "msg_8")

      TurnProgressState.settleUnacknowledged(ServerScope.local, (sessionID) => sessionID === "ses_running")

      expect(TurnProgressState.read(ServerScope.local, "ses_running")?.messageID).toBe("msg_6")
      expect(TurnProgressState.read(ServerScope.local, "ses_lost")).toBeUndefined()
      expect(TurnProgressState.read(remote, "ses_remote")?.messageID).toBe("msg_8")

      TurnProgressState.settle(ServerScope.local, "ses_running")
      TurnProgressState.settle(remote, "ses_remote")
      dispose()
    })
  })
})
