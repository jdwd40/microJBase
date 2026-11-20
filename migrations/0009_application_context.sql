-- Only the trusted API role may establish context. It supplies the user ID
-- from the authenticated session; app-limited callers must also match audience.
CREATE FUNCTION microjbase.bind_application(p_app uuid, p_user uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  allowed_all boolean;
  membership text;
BEGIN
  -- Denial must also invalidate an earlier bind in this transaction.
  PERFORM set_config('microjbase.app_id', '', true),
          set_config('microjbase.user_id', '', true);
  SELECT open_to_authenticated INTO allowed_all
    FROM microjbase.applications WHERE id = p_app AND enabled FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM 1 FROM microjbase.users WHERE id = p_user FOR KEY SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT role INTO membership FROM microjbase.application_memberships
    WHERE app_id = p_app AND user_id = p_user FOR SHARE;
  IF membership IS NULL AND NOT allowed_all THEN RETURN NULL; END IF;
  PERFORM set_config('microjbase.app_id', p_app::text, true),
          set_config('microjbase.user_id', p_user::text, true);
  RETURN coalesce(membership, 'member');
END
$$;
REVOKE ALL ON FUNCTION microjbase.bind_application(uuid,uuid) FROM PUBLIC;

-- Resolve exactly one alias against the currently bound application.
CREATE FUNCTION microjbase.resolve_application_table(p_alias text)
RETURNS TABLE(schema_name text, table_name text)
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT a.schema_name, e.table_name
  FROM microjbase.application_exposures e
  JOIN microjbase.applications a ON a.id = e.app_id
  WHERE a.id = nullif(current_setting('microjbase.app_id', true), '')::uuid
    AND a.enabled AND e.alias = p_alias
  FOR SHARE OF e, a
$$;
REVOKE ALL ON FUNCTION microjbase.resolve_application_table(text) FROM PUBLIC;
