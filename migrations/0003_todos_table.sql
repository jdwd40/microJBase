-- Migration 0003: representative user-owned todos table.
--
-- This demonstrates the required table shape for exposed application tables:
-- UUID primary key named `id`, user ownership, supported column types,
-- realistic constraints, ENABLE/FORCE ROW LEVEL SECURITY, and an owner policy
-- driven by the transaction-local `microjbase.user_id` setting.
--
-- The runtime role is NOT created here. Managed providers often forbid
-- CREATE ROLE, so operators provision the role and grants separately.

CREATE TABLE IF NOT EXISTS public.todos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL DEFAULT (
    nullif(current_setting('microjbase.user_id', true), '')::uuid
  ) REFERENCES microjbase.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 500),
  completed BOOLEAN NOT NULL DEFAULT false,
  priority INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.todos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.todos FORCE ROW LEVEL SECURITY;

-- The policy is intentionally generic: it relies on the transaction-local
-- identity set by the application, not on any session-level state. This keeps
-- the policy valid for any backend connection from the runtime pool.
-- Drop and recreate the owner policy so repeated application is safe.
DROP POLICY IF EXISTS todos_owner_all ON public.todos;

CREATE POLICY todos_owner_all ON public.todos
  FOR ALL
  TO PUBLIC
  USING (
    user_id = nullif(current_setting('microjbase.user_id', true), '')::uuid
  )
  WITH CHECK (
    user_id = nullif(current_setting('microjbase.user_id', true), '')::uuid
  );
