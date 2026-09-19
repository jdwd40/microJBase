import { describe, expect, it } from "vitest"

import {
  DEFAULTS,
  parseConfig,
  redactSecrets,
  redactUrlPassword,
  safeConfigForLogging,
} from "../../../src/core/config.js"

describe("parseConfig", () => {
  it("parses required variables and applies defaults", () => {
    const config = parseConfig({
      DATABASE_URL: "postgres://user:pass@127.0.0.1:5432/db",
    })

    expect(config.databaseUrl).toBe("postgres://user:pass@127.0.0.1:5432/db")
    expect(config.migrationDatabaseUrl).toBeNull()
    expect(config.host).toBe(DEFAULTS.host)
    expect(config.port).toBe(DEFAULTS.port)
    expect(config.logLevel).toBe(DEFAULTS.logLevel)
    expect(config.sessionTtlSeconds).toBe(DEFAULTS.sessionTtlSeconds)
    expect(config.tables).toEqual([])
    expect(config.trustProxy).toBe(DEFAULTS.trustProxy)
    expect(config.maxBodyBytes).toBe(DEFAULTS.maxBodyBytes)
  })

  it("parses all explicit values", () => {
    const config = parseConfig({
      DATABASE_URL: "postgres://runtime:secret@127.0.0.1:5432/db",
      MIGRATION_DATABASE_URL: "postgres://admin:admin@127.0.0.1:5432/db",
      HOST: "0.0.0.0",
      PORT: "8080",
      LOG_LEVEL: "debug",
      SESSION_TTL_SECONDS: "3600",
      MICROJBASE_TABLES: "todos=public.todos,profiles=public.profiles",
      TRUST_PROXY: "true",
      MAX_BODY_BYTES: "524288",
    })

    expect(config.databaseUrl).toBe(
      "postgres://runtime:secret@127.0.0.1:5432/db",
    )
    expect(config.migrationDatabaseUrl).toBe(
      "postgres://admin:admin@127.0.0.1:5432/db",
    )
    expect(config.host).toBe("0.0.0.0")
    expect(config.port).toBe(8080)
    expect(config.logLevel).toBe("debug")
    expect(config.sessionTtlSeconds).toBe(3600)
    expect(config.tables).toEqual([
      { alias: "todos", schema: "public", table: "todos" },
      { alias: "profiles", schema: "public", table: "profiles" },
    ])
    expect(config.trustProxy).toBe(true)
    expect(config.maxBodyBytes).toBe(524288)
  })

  it("rejects missing DATABASE_URL", () => {
    expect(() => parseConfig({})).toThrow("DATABASE_URL is required")
  })

  it("rejects empty DATABASE_URL", () => {
    expect(() => parseConfig({ DATABASE_URL: "   " })).toThrow(
      "DATABASE_URL is required",
    )
  })

  it("rejects invalid PORT", () => {
    expect(() => parseConfig({ DATABASE_URL: "x", PORT: "0" })).toThrow(
      "PORT must be an integer between 1 and 65535",
    )
    expect(() => parseConfig({ DATABASE_URL: "x", PORT: "70000" })).toThrow(
      "PORT must be an integer between 1 and 65535",
    )
    expect(() => parseConfig({ DATABASE_URL: "x", PORT: "abc" })).toThrow(
      "PORT must be an integer between 1 and 65535",
    )
  })

  it("rejects invalid LOG_LEVEL", () => {
    expect(() =>
      parseConfig({ DATABASE_URL: "x", LOG_LEVEL: "verbose" }),
    ).toThrow("LOG_LEVEL must be one of")
  })

  it("rejects non-positive integers", () => {
    expect(() =>
      parseConfig({ DATABASE_URL: "x", SESSION_TTL_SECONDS: "0" }),
    ).toThrow("SESSION_TTL_SECONDS must be a positive integer")
    expect(() =>
      parseConfig({ DATABASE_URL: "x", MAX_BODY_BYTES: "-1" }),
    ).toThrow("MAX_BODY_BYTES must be a positive integer")
  })

  it("rejects invalid TRUST_PROXY", () => {
    expect(() =>
      parseConfig({ DATABASE_URL: "x", TRUST_PROXY: "maybe" }),
    ).toThrow("TRUST_PROXY must be a boolean")
  })

  it("accepts boolean aliases", () => {
    expect(
      parseConfig({ DATABASE_URL: "x", TRUST_PROXY: "1" }).trustProxy,
    ).toBe(true)
    expect(
      parseConfig({ DATABASE_URL: "x", TRUST_PROXY: "yes" }).trustProxy,
    ).toBe(true)
    expect(
      parseConfig({ DATABASE_URL: "x", TRUST_PROXY: "on" }).trustProxy,
    ).toBe(true)
    expect(
      parseConfig({ DATABASE_URL: "x", TRUST_PROXY: "0" }).trustProxy,
    ).toBe(false)
    expect(
      parseConfig({ DATABASE_URL: "x", TRUST_PROXY: "no" }).trustProxy,
    ).toBe(false)
    expect(
      parseConfig({ DATABASE_URL: "x", TRUST_PROXY: "off" }).trustProxy,
    ).toBe(false)
  })
})

describe("parseConfig table mappings", () => {
  it("parses a single mapping", () => {
    const config = parseConfig({
      DATABASE_URL: "x",
      MICROJBASE_TABLES: "todos=public.todos",
    })
    expect(config.tables).toEqual([
      { alias: "todos", schema: "public", table: "todos" },
    ])
  })

  it("trims whitespace", () => {
    const config = parseConfig({
      DATABASE_URL: "x",
      MICROJBASE_TABLES: "  todos = public.todos , profiles = public.profiles ",
    })
    expect(config.tables).toEqual([
      { alias: "todos", schema: "public", table: "todos" },
      { alias: "profiles", schema: "public", table: "profiles" },
    ])
  })

  it("rejects malformed entries", () => {
    expect(() =>
      parseConfig({ DATABASE_URL: "x", MICROJBASE_TABLES: "todos" }),
    ).toThrow(
      'MICROJBASE_TABLES entry "todos" must be in the form alias=schema.table',
    )
    expect(() =>
      parseConfig({ DATABASE_URL: "x", MICROJBASE_TABLES: "=public.todos" }),
    ).toThrow(
      'MICROJBASE_TABLES entry "=public.todos" must be in the form alias=schema.table',
    )
    expect(() =>
      parseConfig({ DATABASE_URL: "x", MICROJBASE_TABLES: "todos=" }),
    ).toThrow(
      'MICROJBASE_TABLES entry "todos=" must be in the form alias=schema.table',
    )
  })

  it("rejects missing schema.table", () => {
    expect(() =>
      parseConfig({ DATABASE_URL: "x", MICROJBASE_TABLES: "todos=todos" }),
    ).toThrow('MICROJBASE_TABLES target "todos" must be schema.table')
    expect(() =>
      parseConfig({ DATABASE_URL: "x", MICROJBASE_TABLES: "todos=public." }),
    ).toThrow('MICROJBASE_TABLES target "public." must be schema.table')
  })

  it("rejects invalid aliases", () => {
    expect(() =>
      parseConfig({
        DATABASE_URL: "x",
        MICROJBASE_TABLES: "Todos=public.todos",
      }),
    ).toThrow('MICROJBASE_TABLES alias "Todos" must match')
    expect(() =>
      parseConfig({
        DATABASE_URL: "x",
        MICROJBASE_TABLES: "1todos=public.todos",
      }),
    ).toThrow('MICROJBASE_TABLES alias "1todos" must match')
  })

  it("rejects duplicate aliases", () => {
    expect(() =>
      parseConfig({
        DATABASE_URL: "x",
        MICROJBASE_TABLES: "todos=public.todos,todos=public.tasks",
      }),
    ).toThrow('MICROJBASE_TABLES alias "todos" is defined more than once')
  })

  it("rejects forbidden schemas", () => {
    expect(() =>
      parseConfig({
        DATABASE_URL: "x",
        MICROJBASE_TABLES: "users=microjbase.users",
      }),
    ).toThrow('MICROJBASE_TABLES schema "microjbase" cannot be exposed')
    expect(() =>
      parseConfig({
        DATABASE_URL: "x",
        MICROJBASE_TABLES: "users=pg_catalog.users",
      }),
    ).toThrow('MICROJBASE_TABLES schema "pg_catalog" cannot be exposed')
    expect(() =>
      parseConfig({
        DATABASE_URL: "x",
        MICROJBASE_TABLES: "users=information_schema.users",
      }),
    ).toThrow('MICROJBASE_TABLES schema "information_schema" cannot be exposed')
  })
})

describe("redactSecrets", () => {
  it("redacts secret keys in objects", () => {
    expect(redactSecrets({ password: "secret", token: "abc" })).toEqual({
      password: "***",
      token: "***",
    })
  })

  it("redacts nested secrets", () => {
    expect(redactSecrets({ nested: { apiKey: "key" }, safe: "value" })).toEqual(
      {
        nested: { apiKey: "***" },
        safe: "value",
      },
    )
  })

  it("redacts secrets in JSON strings", () => {
    expect(redactSecrets('{"password":"secret","user":"alice"}')).toBe(
      '{"password":"***","user":"alice"}',
    )
  })

  it("leaves non-secret values unchanged", () => {
    expect(redactSecrets({ host: "127.0.0.1", port: 3000 })).toEqual({
      host: "127.0.0.1",
      port: 3000,
    })
  })
})

describe("redactUrlPassword", () => {
  it("masks database URL password", () => {
    expect(redactUrlPassword("postgres://user:secret@host:5432/db")).toBe(
      "postgres://user:***@host:5432/db",
    )
  })

  it("masks invalid input", () => {
    expect(redactUrlPassword("not a url")).toBe("***")
  })
})

describe("safeConfigForLogging", () => {
  it("redacts database passwords", () => {
    const config = parseConfig({
      DATABASE_URL: "postgres://runtime:secret@127.0.0.1:5432/db",
      MIGRATION_DATABASE_URL: "postgres://admin:admin@127.0.0.1:5432/db",
    })
    const safe = safeConfigForLogging(config)
    expect(safe.databaseUrl).toBe("postgres://runtime:***@127.0.0.1:5432/db")
    expect(safe.migrationDatabaseUrl).toBe(
      "postgres://admin:***@127.0.0.1:5432/db",
    )
  })
})
