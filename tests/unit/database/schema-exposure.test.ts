// Unit tests for the V02-13 swappable table registry holder.

import { describe, expect, it } from "vitest"

import type {
  ExposedTable,
  TableRegistry,
} from "../../../src/contracts/index.js"
import { createSwappableTableRegistry } from "../../../src/database/index.js"

function table(alias: string): ExposedTable {
  return {
    alias,
    schema: "public",
    table: alias,
    primaryKey: "id",
    readableColumns: ["id"],
    insertableColumns: ["id"],
    updatableColumns: ["id"],
  }
}

function registryOf(aliases: string[]): TableRegistry {
  const tables = new Map(aliases.map((alias) => [alias, table(alias)]))
  return {
    get: (alias) => tables.get(alias) ?? null,
    list: () => [...tables.values()],
  }
}

describe("createSwappableTableRegistry", () => {
  it("delegates get/list to the current registry", () => {
    const holder = createSwappableTableRegistry(registryOf(["a", "b"]))
    expect(holder.get("a")?.table).toBe("a")
    expect(holder.get("missing")).toBeNull()
    expect(holder.list().map((entry) => entry.alias)).toEqual(["a", "b"])
  })

  it("serves the new snapshot after an atomic replace", () => {
    const holder = createSwappableTableRegistry(registryOf(["a"]))
    holder.replace(registryOf(["c"]))
    expect(holder.get("a")).toBeNull()
    expect(holder.get("c")?.table).toBe("c")
    expect(holder.list().map((entry) => entry.alias)).toEqual(["c"])
  })

  it("supports unexpose-then-expose sequences across swaps", () => {
    const holder = createSwappableTableRegistry(registryOf(["a"]))
    holder.replace(registryOf([]))
    expect(holder.list()).toEqual([])
    holder.replace(registryOf(["a", "b"]))
    expect(holder.list()).toHaveLength(2)
  })
})
