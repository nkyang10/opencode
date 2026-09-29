import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { FileSystem, Integration, Permission, Project, Reference, Session, Workspace } from "../src"
import { EventManifest } from "../src/event-manifest"
import { IdeEvent } from "../src/ide-event"
import { SessionCommentaryEvent } from "../src/session-commentary-event"
import { SessionEvent } from "../src/session-event"
import { SessionTodo } from "../src/session-todo"
import { SessionV1 } from "../src/session-v1"
import { WorkspaceEvent } from "../src/workspace-event"

describe("public event manifest", () => {
  test("owns the complete public event surface", () => {
    // These pins had gone stale: three events (and FE-028's `session.commentary`) were added to the public
    // manifest without updating them, so this test was already red on `dev` before FE-028 — it reported
    // 85/55/85/32 against a real 88/58/88/35. The point of the assertion is to trip when the surface
    // changes, which it can no longer do while the numbers are simply wrong.
    expect(EventManifest.ServerDefinitions.length).toBe(58)
    expect(EventManifest.Definitions.length).toBe(89)
    expect(SessionV1.Event.Definitions).toEqual([
      SessionV1.Event.Created,
      SessionV1.Event.Updated,
      SessionV1.Event.Deleted,
      SessionV1.Event.MessageUpdated,
      SessionV1.Event.MessageRemoved,
      SessionV1.Event.PartUpdated,
      SessionV1.Event.PartRemoved,
      SessionV1.Event.PartDelta,
      SessionV1.Event.Diff,
      SessionV1.Event.Error,
    ])
    expect(EventManifest.Latest.size).toBe(89)
    expect(EventManifest.Durable.size).toBe(35)
  })

  test("uses canonical definitions for current public events", () => {
    expect(Session.Event).toBe(SessionEvent)
    expect(Session.Event.Definitions).toBe(SessionEvent.Definitions)
    expect(Workspace.Event).toBe(WorkspaceEvent)
    expect(Workspace.Event.Definitions).toBe(WorkspaceEvent.Definitions)
    expect(EventManifest.Latest.get("session.next.step.ended")).toBe(SessionEvent.Step.Ended)
    expect(EventManifest.Latest.get("todo.updated")).toBe(SessionTodo.Event.Updated)
    expect(EventManifest.Latest.get("project.updated")).toBe(Project.Event.Updated)
    expect(Project.Event.Definitions).toEqual([Project.Event.Updated])
    expect(FileSystem.Event.Definitions).toEqual([FileSystem.Event.Edited])
    expect(Integration.Event.Definitions).toEqual([Integration.Event.Updated, Integration.Event.ConnectionUpdated])
    expect(Permission.Event.Definitions).toEqual([Permission.Event.Asked, Permission.Event.Replied])
    expect(Reference.Event.Definitions).toEqual([Reference.Event.Updated])
    expect(EventManifest.Latest.has("ide.installed")).toBe(false)
    expect(IdeEvent.Definitions).toEqual([IdeEvent.Installed])
    // The intent is that the three v1 live tail definitions stay contiguous and in order. Asserted relative
    // to PartDelta's own index rather than a hard-coded slice, because the old `slice(40, 43)` had drifted
    // onto unrelated revert events as the manifest grew — which is how this file went stale unnoticed.
    const partDelta = EventManifest.Definitions.indexOf(SessionV1.Event.PartDelta)
    expect(partDelta).toBeGreaterThanOrEqual(0)
    expect(EventManifest.Definitions.slice(partDelta, partDelta + 3)).toEqual([
      SessionV1.Event.PartDelta,
      SessionV1.Event.Diff,
      SessionV1.Event.Error,
    ])
    expect(EventManifest.Durable.has("session.next.step.ended.1")).toBe(false)
    expect(EventManifest.Durable.get("session.next.step.ended.2")).toBe(SessionEvent.Step.Ended)
  })
})

// FE-028: the commentary event is how an entry reaches every open panel, so it has to be in the public
// manifest (an app-side switch with no throwing default ignores unknown types, but a *missing* manifest
// entry means the server never publishes it) and its payload has to survive the real decode.
describe("session.commentary (FE-028)", () => {
  const decodeEntry = Schema.decodeUnknownSync(SessionCommentaryEvent.Entry)

  test("is published on the public event surface", () => {
    expect(EventManifest.Latest.get("session.commentary")).toBe(SessionCommentaryEvent.Posted)
    expect(EventManifest.Definitions).toContain(SessionCommentaryEvent.Posted)
    // The cursor is read off the newest row, so the panel must be able to order without a second field.
    expect(SessionCommentaryEvent.Posted.type).toBe("session.commentary")
  })

  test("decodes a stored row", () => {
    expect(
      decodeEntry({
        seq: 3,
        time: 1_700_000_000_000,
        text: "The retry backoff is provider-side, so the third attempt is in flight.",
        anchor: "msg_abc123",
      }),
    ).toEqual({
      seq: 3,
      time: 1_700_000_000_000,
      text: "The retry backoff is provider-side, so the third attempt is in flight.",
      anchor: "msg_abc123",
    })
  })

  test("rejects an empty narration line", () => {
    expect(() => decodeEntry({ seq: 1, time: 1, text: "", anchor: "msg_abc123" })).toThrow()
  })
})
