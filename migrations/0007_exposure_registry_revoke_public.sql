-- Migration 0007: close the PUBLIC EXECUTE gap on the one-time exposure
-- import (R5 review on JDW-22, remediated under JDW-23).
--
-- Migration 0006 created microjbase.import_exposure_registry as
-- SECURITY DEFINER but left PostgreSQL's default function ACL in place:
-- with proacl NULL, EXECUTE is granted to PUBLIC. Until the out-of-band
-- GRANT EXECUTE to the runtime role runs, ANY login role holding CONNECT on
-- the database and USAGE on schema microjbase could win the one-time import
-- and decide the exposure set (or initialize it empty, permanently disabling
-- the MICROJBASE_TABLES seed). Reproduced on PostgreSQL 18.6 during the R5
-- review.
--
-- This migration revokes the default grant. The documented out-of-band
-- contract from 0006 is unchanged and now mandatory: only the runtime role
-- receives GRANT EXECUTE ON FUNCTION
-- microjbase.import_exposure_registry(jsonb). The schema-admin lane never
-- calls the function (expose/unexpose writes go through the compiled
-- registry plans), so it needs no EXECUTE.
--
-- Forward-only and immutable after merge. REVOKE is idempotent, so this is
-- safe on databases where 0006 was applied earlier.

REVOKE ALL ON FUNCTION microjbase.import_exposure_registry(jsonb) FROM PUBLIC;

COMMENT ON FUNCTION microjbase.import_exposure_registry(JSONB) IS
  'One-time validated import of MICROJBASE_TABLES into the durable exposure registry; refuses re-initialization (D-018). PUBLIC EXECUTE revoked by migration 0007; only the runtime role holds EXECUTE via out-of-band grant.';
