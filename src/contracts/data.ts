// Frozen data contracts for microJBase v0.1 (see CONTRACTS.md).
// Architect-owned: proposed changes require the CONTRACTS.md change process.

import type { UserId } from "./auth.js"

export interface ExposedTable {
  alias: string
  schema: string
  table: string
  primaryKey: "id"
  readableColumns: readonly string[]
  insertableColumns: readonly string[]
  updatableColumns: readonly string[]
  /** Private adapter metadata: PostgreSQL type name per exposed column. */
  columnTypes: { readonly [column: string]: string }
}

export interface TableRegistry {
  get(alias: string): ExposedTable | null
  list(): readonly ExposedTable[]
}

// The data repository boundary uses JSON-ready values. PostgreSQL-to-JSON
// conversion rules are fixed in docs/database-spec.md.
export type JsonPrimitive = string | number | boolean | null
export type JsonValue =
  JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type DataRow = Record<string, JsonValue>

export interface Page<T> {
  items: T[]
  limit: number
  offset: number
}

export interface RequestIdentity {
  userId: UserId
}

export interface DataRepository {
  list(input: {
    identity: RequestIdentity
    table: ExposedTable
    limit: number
    offset: number
  }): Promise<Page<DataRow>>

  findById(input: {
    identity: RequestIdentity
    table: ExposedTable
    id: string
  }): Promise<DataRow | null>

  create(input: {
    identity: RequestIdentity
    table: ExposedTable
    values: DataRow
  }): Promise<DataRow>

  updateById(input: {
    identity: RequestIdentity
    table: ExposedTable
    id: string
    values: DataRow
  }): Promise<DataRow | null>

  deleteById(input: {
    identity: RequestIdentity
    table: ExposedTable
    id: string
  }): Promise<boolean>
}
