-- Activation is an explicit maintenance operation after draining all servers.
ALTER TABLE microjbase.exposure_registry_state
  ADD COLUMN default_app_id uuid REFERENCES microjbase.applications(id);

CREATE FUNCTION microjbase.activate_shared_mode(p_default uuid)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  LOCK TABLE microjbase.exposure_registry_state, microjbase.exposure_registry,
    microjbase.applications, microjbase.application_exposures IN SHARE ROW EXCLUSIVE MODE;
  IF NOT EXISTS (SELECT FROM microjbase.exposure_registry_state WHERE singleton AND initialized AND default_app_id IS NULL)
    OR NOT EXISTS (SELECT FROM microjbase.applications WHERE id=p_default AND enabled) THEN
    RAISE EXCEPTION 'initialize legacy mappings and select an enabled default application';
  END IF;
  IF EXISTS (SELECT FROM microjbase.exposure_registry l WHERE l.exposed AND NOT EXISTS (
    SELECT FROM microjbase.applications a JOIN microjbase.application_exposures e ON e.app_id=a.id
    JOIN pg_namespace n ON n.nspname=a.schema_name JOIN pg_class t ON t.relnamespace=n.oid AND t.relname=e.table_name
    JOIN pg_policy p ON p.polrelid=t.oid AND p.polname='microjbase_application_boundary' AND NOT p.polpermissive
    WHERE a.id=p_default AND a.schema_name=l.schema_name AND e.alias=l.alias AND e.table_name=l.table_name
      AND t.relrowsecurity AND t.relforcerowsecurity)) THEN
    RAISE EXCEPTION 'unmapped legacy exposure or missing application boundary';
  END IF;
  UPDATE microjbase.exposure_registry_state SET default_app_id=p_default WHERE singleton;
END
$$;
REVOKE ALL ON FUNCTION microjbase.activate_shared_mode(uuid) FROM PUBLIC;

CREATE TABLE microjbase.application_tokens (
  session_id uuid NOT NULL REFERENCES microjbase.sessions(id) ON DELETE CASCADE,
  app_id uuid NOT NULL REFERENCES microjbase.applications(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE CHECK (length(token_hash)=32),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(session_id, app_id)
);

CREATE FUNCTION microjbase.exchange_application_session(p_app uuid,p_global bytea,p_new bytea)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  s microjbase.sessions%ROWTYPE;
BEGIN
  SELECT * INTO s FROM microjbase.sessions WHERE token_hash=p_global
    AND revoked_at IS NULL AND expires_at>statement_timestamp() FOR SHARE;
  IF NOT FOUND OR microjbase.bind_application(p_app,s.user_id) IS NULL THEN RETURN false; END IF;
  INSERT INTO microjbase.application_tokens(session_id,app_id,token_hash,expires_at)
    VALUES(s.id,p_app,p_new,least(s.expires_at, statement_timestamp()+interval '15 minutes'))
    ON CONFLICT(session_id,app_id) DO UPDATE SET token_hash=excluded.token_hash, expires_at=excluded.expires_at;
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION microjbase.exchange_application_session(uuid,bytea,bytea) FROM PUBLIC;

CREATE FUNCTION microjbase.authenticate_application(p_app uuid,p_token bytea)
RETURNS TABLE(user_id uuid, app_role text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  subject uuid;
  entitlement text;
BEGIN
  SELECT s.user_id INTO subject FROM microjbase.application_tokens t
    JOIN microjbase.sessions s ON s.id=t.session_id
    WHERE t.app_id=p_app AND t.token_hash=p_token AND s.revoked_at IS NULL
      AND least(s.expires_at,t.expires_at)>statement_timestamp() FOR SHARE OF s,t;
  IF NOT FOUND THEN RETURN; END IF;
  entitlement := microjbase.bind_application(p_app,subject);
  IF entitlement IS NOT NULL THEN RETURN QUERY SELECT subject,entitlement; END IF;
END
$$;
REVOKE ALL ON FUNCTION microjbase.authenticate_application(uuid,bytea) FROM PUBLIC;

ALTER TABLE microjbase.applications ADD COLUMN callback_url text CHECK (
  callback_url ~ '^https://[^/@?#[:space:]]+(/[^?#[:space:]]*)?$' AND length(callback_url)<=2048
);
CREATE TABLE microjbase.application_codes (
  session_id uuid REFERENCES microjbase.sessions(id) ON DELETE CASCADE,
  app_id uuid REFERENCES microjbase.applications(id) ON DELETE CASCADE,
  code_hash bytea NOT NULL UNIQUE,
  callback_url text NOT NULL,
  challenge bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(session_id,app_id)
);
CREATE FUNCTION microjbase.issue_application_code(p_app uuid,p_global bytea,p_hash bytea,p_callback text,p_challenge bytea)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s microjbase.sessions%ROWTYPE;
BEGIN
  SELECT * INTO s FROM microjbase.sessions WHERE token_hash=p_global AND revoked_at IS NULL AND expires_at>now() FOR SHARE;
  IF NOT FOUND OR microjbase.bind_application(p_app,s.user_id) IS NULL THEN RETURN false; END IF;
  IF NOT EXISTS(SELECT FROM microjbase.applications WHERE id=p_app AND callback_url=p_callback)
    OR length(p_challenge)<>32 OR length(p_hash)<>32 THEN RETURN false; END IF;
  INSERT INTO microjbase.application_codes VALUES(s.id,p_app,p_hash,p_callback,p_challenge,now()+interval '60 seconds')
    ON CONFLICT(session_id,app_id) DO UPDATE SET code_hash=excluded.code_hash, callback_url=excluded.callback_url,
      challenge=excluded.challenge, expires_at=excluded.expires_at;
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION microjbase.issue_application_code(uuid,bytea,bytea,text,bytea) FROM PUBLIC;

CREATE FUNCTION microjbase.redeem_application_code(p_app uuid,p_hash bytea,p_new bytea,p_callback text,p_challenge bytea)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE bearer_digest bytea;
BEGIN
  SELECT s.token_hash INTO bearer_digest FROM microjbase.sessions s
    JOIN microjbase.application_codes c ON c.session_id=s.id
    JOIN microjbase.applications a ON a.id=c.app_id
    WHERE c.app_id=p_app AND c.code_hash=p_hash AND c.challenge=p_challenge AND c.callback_url=p_callback
      AND a.callback_url=p_callback AND c.expires_at>now() FOR UPDATE OF c;
  IF NOT FOUND THEN RETURN false; END IF;
  DELETE FROM microjbase.application_codes WHERE code_hash=p_hash;
  RETURN microjbase.exchange_application_session(p_app,bearer_digest,p_new);
END
$$;
REVOKE ALL ON FUNCTION microjbase.redeem_application_code(uuid,bytea,bytea,text,bytea) FROM PUBLIC;

CREATE FUNCTION microjbase.set_application_member(p_app uuid,p_token bytea,p_target uuid,p_grant boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE subject uuid;
BEGIN
  SELECT a.user_id INTO subject FROM microjbase.authenticate_application(p_app,p_token) a WHERE a.app_role='admin';
  IF NOT FOUND OR subject=p_target THEN RETURN false; END IF;
  IF p_grant THEN
    INSERT INTO microjbase.application_memberships(app_id,user_id,role)
      SELECT p_app,id,'member' FROM microjbase.users WHERE id=p_target ON CONFLICT DO NOTHING;
  ELSE
    DELETE FROM microjbase.application_memberships WHERE app_id=p_app AND user_id=p_target AND role='member';
  END IF;
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION microjbase.set_application_member(uuid,bytea,uuid,boolean) FROM PUBLIC;

ALTER TABLE microjbase.application_exposures ADD COLUMN visible boolean NOT NULL DEFAULT true;
CREATE OR REPLACE FUNCTION microjbase.resolve_application_table(p_alias text)
RETURNS TABLE(schema_name text, table_name text)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT a.schema_name,e.table_name FROM microjbase.application_exposures e
    JOIN microjbase.applications a ON a.id=e.app_id
    WHERE a.id=nullif(current_setting('microjbase.app_id',true),'')::uuid AND a.enabled AND e.visible AND e.alias=p_alias
    FOR SHARE OF e,a
$$;

CREATE FUNCTION microjbase.application_catalogue(p_app uuid,p_token bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF NOT EXISTS(SELECT FROM microjbase.authenticate_application(p_app,p_token) WHERE app_role='admin') THEN RETURN NULL; END IF;
  RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('alias',e.alias,'schema',a.schema_name,'table',e.table_name,'visible',e.visible) ORDER BY e.alias),'[]'::jsonb)
    FROM microjbase.application_exposures e JOIN microjbase.applications a ON a.id=e.app_id WHERE a.id=p_app);
END
$$;
REVOKE ALL ON FUNCTION microjbase.application_catalogue(uuid,bytea) FROM PUBLIC;

CREATE FUNCTION microjbase.set_application_visibility(p_app uuid,p_token bytea,p_alias text,p_visible boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF NOT EXISTS(SELECT FROM microjbase.authenticate_application(p_app,p_token) WHERE app_role='admin') THEN RETURN false; END IF;
  UPDATE microjbase.application_exposures SET visible=p_visible WHERE app_id=p_app AND alias=p_alias;
  RETURN FOUND;
END
$$;
REVOKE ALL ON FUNCTION microjbase.set_application_visibility(uuid,bytea,text,boolean) FROM PUBLIC;
