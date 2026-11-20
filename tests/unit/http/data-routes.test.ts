import type { FastifyInstance } from "fastify"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { DataError } from "../../../src/data/index.js"
import { buildServer } from "../../../src/http/index.js"
import { serviceSpies } from "./service-spies.js"

const token = "issued-token"
const user = {
  id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  email: "alice@example.com",
}
const id = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
const route = "/v1/data/items"
const headers = { authorization: `Bearer ${token}` }
const target = { identity: { userId: user.id }, tableAlias: "items" }

describe("data routes", () => {
  let app: FastifyInstance
  let services: ReturnType<typeof serviceSpies>

  beforeEach(async () => {
    services = serviceSpies()
    services.authService.authenticate.mockResolvedValue(user)
    app = await buildServer(services, { disableRequestLogging: true })
  })
  afterEach(async () => {
    await app.close()
  })

  it("parses pagination and returns the page and metadata", async () => {
    const rows = [{ id, name: "first" }]
    services.dataService.list.mockResolvedValue({
      items: rows,
      limit: 1,
      offset: 0,
    })
    const response = await app.inject({
      method: "GET",
      url: route + "?limit=1&offset=0",
      headers,
    })
    expect(services.authService.authenticate).toHaveBeenCalledExactlyOnceWith(
      token,
    )
    expect(services.dataService.list).toHaveBeenCalledExactlyOnceWith({
      ...target,
      limit: 1,
      offset: 0,
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      data: rows,
      error: null,
      meta: { limit: 1, offset: 0 },
    })
  })

  it("gets the row identified by the path", async () => {
    const row = { id, name: "item" }
    services.dataService.get.mockResolvedValue(row)
    const response = await app.inject({
      method: "GET",
      url: route + "/" + id,
      headers,
    })
    expect(services.dataService.get).toHaveBeenCalledExactlyOnceWith({
      ...target,
      id,
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ data: row, error: null })
  })

  it("sends the posted values to create and returns the stored row", async () => {
    const values = { name: "new item" }
    const row = { id, ...values }
    services.dataService.create.mockResolvedValue(row)
    const response = await app.inject({
      method: "POST",
      url: route,
      headers,
      payload: values,
    })
    expect(services.dataService.create).toHaveBeenCalledExactlyOnceWith({
      ...target,
      values,
    })
    expect(response.statusCode).toBe(201)
    expect(response.json()).toEqual({ data: row, error: null })
  })

  it("patches the identified row and returns the stored result", async () => {
    const values = { name: "updated" }
    const row = { id, ...values }
    services.dataService.update.mockResolvedValue(row)
    const response = await app.inject({
      method: "PATCH",
      url: route + "/" + id,
      headers,
      payload: values,
    })
    expect(services.dataService.update).toHaveBeenCalledExactlyOnceWith({
      ...target,
      id,
      values,
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ data: row, error: null })
  })

  it("deletes the identified row and returns an empty 204", async () => {
    services.dataService.delete.mockResolvedValue(undefined)
    const response = await app.inject({
      method: "DELETE",
      url: route + "/" + id,
      headers,
    })
    expect(services.dataService.delete).toHaveBeenCalledExactlyOnceWith({
      ...target,
      id,
    })
    expect(response.statusCode).toBe(204)
    expect(response.body).toBe("")
  })

  it("omits unspecified pagination and maps an unexposed table to 404", async () => {
    services.dataService.list.mockRejectedValue(
      new DataError("TABLE_NOT_FOUND", "Table not found", 404),
    )
    const response = await app.inject({
      method: "GET",
      url: "/v1/data/unknown",
      headers,
    })
    expect(services.dataService.list).toHaveBeenCalledExactlyOnceWith({
      ...target,
      tableAlias: "unknown",
    })
    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({
      data: null,
      error: { code: "TABLE_NOT_FOUND" },
    })
  })

  it("maps an invisible row to the public row error", async () => {
    services.dataService.get.mockRejectedValue(
      new DataError("ROW_NOT_FOUND", "Row not found", 404),
    )
    const response = await app.inject({
      method: "GET",
      url: route + "/" + id,
      headers,
    })
    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({
      data: null,
      error: { code: "ROW_NOT_FOUND" },
    })
  })

  it("rejects a missing bearer before accessing data", async () => {
    const response = await app.inject({ method: "GET", url: route })
    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({
      data: null,
      error: { code: "AUTH_REQUIRED" },
    })
    expect(services.dataService.list).not.toHaveBeenCalled()
  })
})
