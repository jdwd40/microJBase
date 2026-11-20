import { vi } from "vitest"
import type { AuthService } from "../../../src/contracts/index.js"
import type { DataService } from "../../../src/data/index.js"

function unexpectedCall(): never {
  throw new Error("Unexpected service call from HTTP handler")
}

export function serviceSpies() {
  return {
    authService: {
      register: vi.fn<AuthService["register"]>(unexpectedCall),
      login: vi.fn<AuthService["login"]>(unexpectedCall),
      authenticate: vi.fn<AuthService["authenticate"]>(unexpectedCall),
      logout: vi.fn<AuthService["logout"]>(unexpectedCall),
    },
    dataService: {
      list: vi.fn<DataService["list"]>(unexpectedCall),
      get: vi.fn<DataService["get"]>(unexpectedCall),
      create: vi.fn<DataService["create"]>(unexpectedCall),
      update: vi.fn<DataService["update"]>(unexpectedCall),
      delete: vi.fn<DataService["delete"]>(unexpectedCall),
    },
  }
}
