-- Explicit operator action. All DDL executes with the caller's privileges.
CREATE FUNCTION microjbase.expose_application_table(p_app uuid, p_alias text, p_table text)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  namespace text;
  target oid;
  guard text;
BEGIN
  SELECT schema_name INTO STRICT namespace FROM microjbase.applications
    WHERE id = p_app FOR UPDATE;
  IF p_table !~ '^[a-z_][a-z0-9_]{0,62}$' OR p_alias !~ '^[a-z][a-z0-9_]{0,62}$' THEN
    RAISE EXCEPTION 'invalid exposure identifier';
  END IF;
  EXECUTE format('LOCK TABLE ONLY %I.%I IN ACCESS EXCLUSIVE MODE', namespace, p_table);
  SELECT c.oid INTO STRICT target FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=namespace AND c.relname=p_table AND c.relkind='r'
      AND c.relrowsecurity AND c.relforcerowsecurity AND NOT c.relispartition
      AND NOT EXISTS (SELECT FROM pg_inherits i WHERE c.oid IN (i.inhparent,i.inhrelid));
  IF NOT EXISTS (SELECT FROM pg_policy WHERE polrelid=target AND polpermissive) THEN
    RAISE EXCEPTION 'application table requires an existing row access policy';
  END IF;
  guard := format('nullif(current_setting(%L,true), %L)::uuid = %L::uuid AND nullif(current_setting(%L,true), %L) IS NOT NULL',
    'microjbase.app_id', '', p_app, 'microjbase.user_id', '');
  EXECUTE format('CREATE POLICY microjbase_application_boundary ON %I.%I AS RESTRICTIVE FOR ALL TO PUBLIC USING (%s) WITH CHECK (%s)',
    namespace, p_table, guard, guard);
  INSERT INTO microjbase.application_exposures(app_id,alias,table_name)
    VALUES(p_app,p_alias,p_table);
END
$$;
REVOKE ALL ON FUNCTION microjbase.expose_application_table(uuid,text,text) FROM PUBLIC;
