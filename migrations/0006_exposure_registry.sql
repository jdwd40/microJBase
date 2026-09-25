-- Migration 0006: durable API-exposure registry (v0.2, V02-10).
--
-- Forward-only and immutable after merge. The registry separates "table
-- exists" from "table is exposed to the data API" and becomes the sole
-- runtime exposure source after the one-time import from MICROJBASE_TABLES
-- (D-018): the environment variable can seed the registry exactly once and
-- can never add tables at runtime or re-expose a table an operator
-- unexposed.
--
-- One row per alias<->target pair. exposed=false rows keep the operator
-- history of an unexposed table without keeping it reachable; re-expose
-- (an explicit operator action through the schema-admin service) flips the
-- same row back. The runtime lane reads only exposed=true rows.
--
-- Required out-of-band grants (the runtime/admin role names are not known
-- at migration time, so they cannot be granted here):
--   runtime role:
--     GRANT SELECT ON microjbase.exposure_registry TO <runtime_role>;
--     GRANT SELECT ON microjbase.exposure_registry_state TO <runtime_role>;
--     GRANT EXECUTE ON FUNCTION microjbase.import_exposure_registry(jsonb)
--       TO <runtime_role>;
--   schema-admin role:
--     GRANT SELECT, INSERT, UPDATE ON microjbase.exposure_registry
--       TO <schema_admin_role>;
--     GRANT USAGE ON SEQUENCE microjbase.exposure_registry_id_seq
--       TO <schema_admin_role>;
--     GRANT SELECT ON microjbase.exposure_registry_state
--       TO <schema_admin_role>;
-- The composition root probes these at startup and fails with an
-- operator-facing message when any are missing.

CREATE TABLE IF NOT EXISTS microjbase.exposure_registry (
  id BIGSERIAL PRIMARY KEY,
  alias TEXT NOT NULL UNIQUE,
  schema_name TEXT NOT NULL,
  table_name TEXT NOT NULL,
  exposed BOOLEAN NOT NULL DEFAULT TRUE,
  exposed_at TIMESTAMPTZ,
  unexposed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (schema_name, table_name)
);

CREATE INDEX IF NOT EXISTS exposure_registry_exposed_idx
  ON microjbase.exposure_registry (exposed)
  WHERE exposed;

COMMENT ON TABLE microjbase.exposure_registry IS
  'Durable data-API exposure registry; sole runtime exposure source after the one-time MICROJBASE_TABLES import (D-018).';

-- Single-row guard marking that the one-time import has happened. Kept in a
-- separate table so the runtime lane can prove initialization state in one
-- indexed read and the import function can lock it separately from the
-- registry rows.
CREATE TABLE IF NOT EXISTS microjbase.exposure_registry_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  initialized BOOLEAN NOT NULL DEFAULT FALSE,
  imported_at TIMESTAMPTZ
);

INSERT INTO microjbase.exposure_registry_state (singleton, initialized)
VALUES (TRUE, FALSE)
ON CONFLICT (singleton) DO NOTHING;

COMMENT ON TABLE microjbase.exposure_registry_state IS
  'Singleton guard: TRUE once the one-time MICROJBASE_TABLES import has run.';

-- One-time import of the MICROJBASE_TABLES mapping into the durable
-- registry (D-018). SECURITY DEFINER because the restricted runtime role
-- holds no DML on this table; the function is owned by the migration role
-- (a non-superuser) and performs exactly one validated, atomic import:
-- it refuses a second call, so neither the environment variable nor any
-- caller can re-add or re-expose tables after initialization. The function
-- validates every mapping independently of the caller because any role
-- with EXECUTE may invoke it. search_path is pinned so no caller-controlled
-- schema can shadow the microjbase catalog.
CREATE OR REPLACE FUNCTION microjbase.import_exposure_registry(p_mappings JSONB)
RETURNS VOID
LANGUAGE PLPGSQL
SECURITY DEFINER
SET search_path = pg_catalog
AS $func$
DECLARE
  v_alias TEXT;
  v_schema TEXT;
  v_table TEXT;
  v_count INT;
  v_distinct_aliases INT;
  v_distinct_targets INT;
BEGIN
  IF p_mappings IS NULL OR jsonb_typeof(p_mappings) <> 'array' THEN
    RAISE EXCEPTION 'import payload must be a JSON array';
  END IF;

  FOR v_alias, v_schema, v_table IN
    SELECT m.alias, m."schema", m."table"
    FROM jsonb_to_recordset(p_mappings) AS m(alias TEXT, "schema" TEXT, "table" TEXT)
  LOOP
    IF v_alias IS NULL OR v_alias !~ '^[a-z][a-z0-9_]{0,62}$' THEN
      RAISE EXCEPTION 'invalid alias in import payload';
    END IF;
    IF v_schema IS NULL OR v_schema !~ '^[a-z_][a-z0-9_]*$' THEN
      RAISE EXCEPTION 'invalid schema name in import payload';
    END IF;
    IF v_table IS NULL OR v_table !~ '^[a-z_][a-z0-9_]*$' THEN
      RAISE EXCEPTION 'invalid table name in import payload';
    END IF;
    IF lower(v_schema) IN ('microjbase', 'pg_catalog', 'information_schema')
       OR lower(v_schema) LIKE 'pg\_%' THEN
      RAISE EXCEPTION 'schema % is not eligible for exposure', v_schema;
    END IF;
  END LOOP;

  SELECT count(*),
         count(DISTINCT m.alias),
         count(DISTINCT (m."schema", m."table"))
    INTO v_count, v_distinct_aliases, v_distinct_targets
    FROM jsonb_to_recordset(p_mappings) AS m(alias TEXT, "schema" TEXT, "table" TEXT);

  IF v_distinct_aliases <> v_count OR v_distinct_targets <> v_count THEN
    RAISE EXCEPTION 'import payload contains duplicate aliases or targets';
  END IF;

  -- Serialize racing importers on the singleton row; the loser observes
  -- initialized=TRUE and fails closed below.
  PERFORM pg_advisory_xact_lock(7921890504698152931);

  IF EXISTS (SELECT 1 FROM microjbase.exposure_registry_state
             WHERE singleton AND initialized) THEN
    RAISE EXCEPTION 'exposure registry is already initialized';
  END IF;

  INSERT INTO microjbase.exposure_registry
    (alias, schema_name, table_name, exposed, exposed_at)
  SELECT m.alias, m."schema", m."table", TRUE, now()
    FROM jsonb_to_recordset(p_mappings) AS m(alias TEXT, "schema" TEXT, "table" TEXT);

  UPDATE microjbase.exposure_registry_state
     SET initialized = TRUE, imported_at = now()
   WHERE singleton;
END;
$func$;

COMMENT ON FUNCTION microjbase.import_exposure_registry(JSONB) IS
  'One-time validated import of MICROJBASE_TABLES into the durable exposure registry; refuses re-initialization (D-018).';
