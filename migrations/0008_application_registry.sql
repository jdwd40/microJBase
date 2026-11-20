-- Preparatory catalogue. The operator must explicitly map applications
-- before enabling scoped traffic. No existing table or session is altered.
CREATE TABLE microjbase.applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 128),
  schema_name text NOT NULL UNIQUE CHECK (
    schema_name ~ '^[a-z_][a-z0-9_]{0,62}$'
    AND schema_name NOT IN ('microjbase', 'information_schema')
    AND left(schema_name, 3) <> 'pg_'
  ),
  enabled boolean NOT NULL DEFAULT false,
  open_to_authenticated boolean NOT NULL DEFAULT false
);

CREATE TABLE microjbase.application_memberships (
  app_id uuid NOT NULL REFERENCES microjbase.applications(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES microjbase.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('member', 'admin')),
  PRIMARY KEY (app_id, user_id)
);

CREATE TABLE microjbase.application_exposures (
  app_id uuid NOT NULL REFERENCES microjbase.applications(id) ON DELETE CASCADE,
  alias text NOT NULL CHECK (alias ~ '^[a-z][a-z0-9_]{0,62}$'),
  table_name text NOT NULL CHECK (table_name ~ '^[a-z_][a-z0-9_]{0,62}$'),
  PRIMARY KEY (app_id, alias),
  UNIQUE (app_id, table_name)
);
