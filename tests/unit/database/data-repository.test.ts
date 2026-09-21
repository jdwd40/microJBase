// Direct error-translation unit coverage for the PostgreSQL data repository.
//
// These tests exercise translateDataError only — no database required. The
// security-critical property: RLS/policy rejections (SQLSTATE 42501) and
// constraint conflicts surface as the generic safe 409 CONFLICT envelope,
// never as 500s and never with PostgreSQL internals.

import { describe, expect, it } from "vitest"

import { AppError } from "../../../src/core/index.js"
import { translateDataError } from "../../../src/database/data-repository.js"

function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

describe("translateDataError", () => {
  it("maps RLS 42501 rejections to the generic safe 409 CONFLICT", () => {
    const translated = translateDataError(
      pgError(
        "42501",
        'new row for relation "todos" violates row-level security policy',
      ),
    )
    expect(translated.code).toBe("CONFLICT")
    expect(translated.status).toBe(409)
    expect(translated.message).toBe("A conflict occurred")
    expect(translated.details).toBeUndefined()
  })

  it("does not leak policy names, SQLSTATE, or PostgreSQL message text", () => {
    const translated = translateDataError(
      pgError("42501", 'row-level security policy "todos_owner_all" violated'),
    )
    expect(JSON.stringify(translated)).not.toMatch(
      /42501|todos_owner_all|policy|row-level|violat/i,
    )
  })

  it("keeps mapping unique violations to the same generic 409", () => {
    const translated = translateDataError(
      pgError("23505", "duplicate key value violates unique constraint"),
    )
    expect(translated).toMatchObject({
      code: "CONFLICT",
      status: 409,
      message: "A conflict occurred",
    })
  })

  it("passes AppError instances through unchanged", () => {
    const original = new AppError("ROW_NOT_FOUND", "Row not found", 404)
    expect(translateDataError(original)).toBe(original)
  })

  it("maps unknown SQLSTATEs to INTERNAL_ERROR, not CONFLICT", () => {
    const translated = translateDataError(
      pgError("XX000", "some internal postgres failure"),
    )
    expect(translated.code).toBe("INTERNAL_ERROR")
    expect(translated.status).toBe(500)
  })

  it("maps non-PostgreSQL errors through the pool translation", () => {
    const translated = translateDataError(new Error("boom"))
    expect(translated.code).toBe("INTERNAL_ERROR")
    expect(translated.status).toBe(500)
  })
})
