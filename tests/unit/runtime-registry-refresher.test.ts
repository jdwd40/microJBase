// Unit tests for the ticketed runtime-registry refresher (JDW-27 finding 2).
//
// The refresher rebuilds the verified runtime snapshot after every exposure
// change. Rebuilds are asynchronous, and without a generation guard a slower
// older read could finish last and replace a fresh snapshot with a stale one.
// Each refresh captures a monotonic ticket first and swaps only while it is
// still the newest refresh.

import { describe, expect, it } from "vitest"

import type { TableRegistry } from "../../src/contracts/index.js"
import { createSwappableTableRegistry } from "../../src/database/index.js"
import { createRuntimeRegistryRefresher } from "../../src/main.js"

function registryTag(tag: string): TableRegistry {
  return {
    get: (alias) =>
      alias === tag
        ? {
            alias,
            schema: "app",
            table: tag,
            primaryKey: "id",
            readableColumns: ["id"],
            insertableColumns: ["id"],
            updatableColumns: ["id"],
          }
        : null,
    list: () => [],
  }
}

describe("createRuntimeRegistryRefresher", () => {
  it("installs the snapshot when it is the newest refresh", async () => {
    const holder = createSwappableTableRegistry(registryTag("initial"))
    const refresh = createRuntimeRegistryRefresher({
      rebuild: async () => registryTag("notes"),
      registry: holder,
    })
    await refresh()
    expect(holder.get("notes")).not.toBeNull()
    expect(holder.get("initial")).toBeNull()
  })

  it("does not install a stale snapshot when an older refresh resolves last", async () => {
    const holder = createSwappableTableRegistry(registryTag("initial"))
    let releaseOlder!: () => void
    const olderGate = new Promise<void>((resolve) => {
      releaseOlder = resolve
    })
    let call = 0
    const refresh = createRuntimeRegistryRefresher({
      rebuild: async () => {
        call += 1
        if (call === 1) {
          // The older read stalls; the newer refresh overtakes it.
          await olderGate
          return registryTag("stale")
        }
        return registryTag("fresh")
      },
      registry: holder,
    })
    const older = refresh()
    const newer = refresh()
    await newer
    releaseOlder()
    await older
    expect(holder.get("fresh")).not.toBeNull()
    expect(holder.get("stale")).toBeNull()
  })

  it("still discards the stale read when the newer refresh fails", async () => {
    const holder = createSwappableTableRegistry(registryTag("initial"))
    let releaseOlder!: () => void
    const olderGate = new Promise<void>((resolve) => {
      releaseOlder = resolve
    })
    let call = 0
    const refresh = createRuntimeRegistryRefresher({
      rebuild: async () => {
        call += 1
        if (call === 1) {
          await olderGate
          return registryTag("stale")
        }
        throw new Error("fresh read failed")
      },
      registry: holder,
    })
    const older = refresh()
    const newer = refresh().then(
      () => undefined,
      () => undefined,
    )
    await newer
    releaseOlder()
    await older
    // The failed newest refresh left the previous snapshot in place; the
    // stale older read must not overwrite it.
    expect(holder.get("stale")).toBeNull()
    expect(holder.get("initial")).not.toBeNull()
  })
})
