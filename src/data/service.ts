// DataService implementation — domain only; no pg/Fastify.

import type {
  DataRepository,
  DataRow,
  Page,
  RequestIdentity,
  TableRegistry,
} from "../contracts/index.js"

import { DataError } from "./errors.js"
import {
  assertKeysAllowed,
  isCanonicalUuid,
  requireCanonicalUuid,
  requireNonEmptyPlainObject,
  resolveLimit,
  resolveOffset,
} from "./validate.js"

export interface DataService {
  list(input: {
    identity: RequestIdentity
    tableAlias: string
    limit?: number
    offset?: number
  }): Promise<Page<DataRow>>

  get(input: {
    identity: RequestIdentity
    tableAlias: string
    id: string
  }): Promise<DataRow>

  create(input: {
    identity: RequestIdentity
    tableAlias: string
    values: unknown
  }): Promise<DataRow>

  update(input: {
    identity: RequestIdentity
    tableAlias: string
    id: string
    values: unknown
  }): Promise<DataRow>

  delete(input: {
    identity: RequestIdentity
    tableAlias: string
    id: string
  }): Promise<void>
}

export class DataServiceImpl implements DataService {
  constructor(
    private readonly registry: TableRegistry,
    private readonly repository: DataRepository,
  ) {}

  private resolveTable(tableAlias: string) {
    const table = this.registry.get(tableAlias)
    if (table === null) {
      throw new DataError("TABLE_NOT_FOUND", "Table not found", 404)
    }
    return table
  }

  async list(input: {
    identity: RequestIdentity
    tableAlias: string
    limit?: number
    offset?: number
  }): Promise<Page<DataRow>> {
    const table = this.resolveTable(input.tableAlias)
    const limit = resolveLimit(input.limit)
    const offset = resolveOffset(input.offset)
    return this.repository.list({
      identity: input.identity,
      table,
      limit,
      offset,
    })
  }

  async get(input: {
    identity: RequestIdentity
    tableAlias: string
    id: string
  }): Promise<DataRow> {
    const table = this.resolveTable(input.tableAlias)
    const id = requireCanonicalUuid(input.id)
    const row = await this.repository.findById({
      identity: input.identity,
      table,
      id,
    })
    if (row === null) {
      throw new DataError("ROW_NOT_FOUND", "Row not found", 404)
    }
    return row
  }

  async create(input: {
    identity: RequestIdentity
    tableAlias: string
    values: unknown
  }): Promise<DataRow> {
    const table = this.resolveTable(input.tableAlias)
    const values = requireNonEmptyPlainObject(input.values)
    assertKeysAllowed(values, table.insertableColumns, "insertable")

    if (Object.prototype.hasOwnProperty.call(values, "id")) {
      const idValue = values["id"]
      if (typeof idValue !== "string" || !isCanonicalUuid(idValue)) {
        throw new DataError(
          "VALIDATION_ERROR",
          "Request validation failed",
          400,
          { id: "Must be a canonical UUID" },
        )
      }
    }

    // Pass only the validated values object; do not invent columns.
    return this.repository.create({
      identity: input.identity,
      table,
      values: values as DataRow,
    })
  }

  async update(input: {
    identity: RequestIdentity
    tableAlias: string
    id: string
    values: unknown
  }): Promise<DataRow> {
    const table = this.resolveTable(input.tableAlias)
    const id = requireCanonicalUuid(input.id)
    const values = requireNonEmptyPlainObject(input.values)

    if (Object.prototype.hasOwnProperty.call(values, "id")) {
      throw new DataError(
        "VALIDATION_ERROR",
        "Request validation failed",
        400,
        { id: "Primary key is immutable" },
      )
    }

    assertKeysAllowed(values, table.updatableColumns, "updatable")

    const row = await this.repository.updateById({
      identity: input.identity,
      table,
      id,
      values: values as DataRow,
    })
    if (row === null) {
      throw new DataError("ROW_NOT_FOUND", "Row not found", 404)
    }
    return row
  }

  async delete(input: {
    identity: RequestIdentity
    tableAlias: string
    id: string
  }): Promise<void> {
    const table = this.resolveTable(input.tableAlias)
    const id = requireCanonicalUuid(input.id)
    const deleted = await this.repository.deleteById({
      identity: input.identity,
      table,
      id,
    })
    if (!deleted) {
      throw new DataError("ROW_NOT_FOUND", "Row not found", 404)
    }
  }
}

export function createDataService(
  registry: TableRegistry,
  repository: DataRepository,
): DataService {
  return new DataServiceImpl(registry, repository)
}
