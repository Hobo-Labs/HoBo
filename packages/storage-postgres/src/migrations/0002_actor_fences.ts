/** Shared actor leases and a schema-wide protected-stream policy. */
// public-contract: persisted migration identity used to verify schema history.
export const name = "actor_fences";

export function sql(s: string): string {
	return `
CREATE TABLE ${s}.actor_lease_policy (
  id smallint PRIMARY KEY CHECK (id = 1),
  prefixes text NOT NULL
);
INSERT INTO ${s}.actor_lease_policy (id, prefixes) VALUES (1, '[]');
CREATE TABLE ${s}.actor_leases (
  stream_id text PRIMARY KEY REFERENCES ${s}.streams (stream_id),
  holder_id text NOT NULL,
  fence_token bigint NOT NULL CHECK (fence_token > 0),
  expires_at timestamptz NOT NULL,
  released boolean NOT NULL DEFAULT false
);

-- This row is inserted and removed in the same transaction. The deferred
-- trigger runs at COMMIT and prevents a protected write whose lease expired
-- after the earlier application-side check, even if no takeover occurred.
CREATE TABLE ${s}.actor_commit_checks (
  id text PRIMARY KEY,
  stream_id text NOT NULL REFERENCES ${s}.streams (stream_id),
  fence_token bigint NOT NULL CHECK (fence_token > 0)
);
CREATE FUNCTION ${s}.check_actor_commit_lease() RETURNS trigger
LANGUAGE plpgsql AS $actor_commit$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM ${s}.actor_leases l JOIN ${s}.streams h ON h.stream_id = l.stream_id
    WHERE l.stream_id = NEW.stream_id AND l.fence_token = NEW.fence_token
      AND h.owner_epoch = NEW.fence_token AND NOT l.released
      AND l.expires_at > clock_timestamp()
  ) THEN
    RAISE EXCEPTION 'actor lease expired before protected commit' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$actor_commit$;
CREATE CONSTRAINT TRIGGER actor_commit_lease_live
AFTER INSERT ON ${s}.actor_commit_checks DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ${s}.check_actor_commit_lease();
`;
}
