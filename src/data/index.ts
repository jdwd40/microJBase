// Public entry point for the data domain module.

export { DataError } from "./errors.js"
export {
  CANONICAL_UUID,
  DEFAULT_LIMIT,
  DEFAULT_OFFSET,
  MAX_LIMIT,
  MAX_OFFSET,
  MIN_LIMIT,
  MIN_OFFSET,
  assertKeysAllowed,
  isCanonicalUuid,
  isJsonValue,
  isPlainObject,
  requireCanonicalUuid,
  requireJsonDataRow,
  requireNonEmptyPlainObject,
  resolveLimit,
  resolveOffset,
} from "./validate.js"
export {
  DataServiceImpl,
  createDataService,
  type DataService,
} from "./service.js"
