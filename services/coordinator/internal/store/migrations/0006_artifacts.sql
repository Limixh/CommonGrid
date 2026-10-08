-- The private byte vault is paired with immutable, server-scanned ownership.
-- Legacy trusted fixture receipts remain valid, but public writes must resolve
-- this registry in their metadata transaction.
CREATE TABLE artifacts (
    id text PRIMARY KEY CHECK (id ~ '^artifact-[a-f0-9]{32}$'),
    user_id text NOT NULL REFERENCES users(id),
    lease_id text NOT NULL REFERENCES leases(id),
    task_id text NOT NULL,
    task_version bigint NOT NULL,
    contract_hash text NOT NULL,
    base_commit text NOT NULL CHECK (base_commit ~ '^[a-f0-9]{40}$'),
    strategy_id text NOT NULL,
    purpose text NOT NULL CHECK (purpose IN ('result','checkpoint')),
    request_key text NOT NULL,
    request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
    sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
    size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 67108864),
    scan_policy text NOT NULL CHECK (char_length(scan_policy) BETWEEN 1 AND 96),
    scan_policy_version text NOT NULL CHECK (char_length(scan_policy_version) BETWEEN 1 AND 96),
    state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','ready')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (user_id,request_key),
    FOREIGN KEY (lease_id,user_id,task_id,task_version,contract_hash)
        REFERENCES leases(id,user_id,task_id,task_version,contract_hash)
);
CREATE INDEX artifacts_owner ON artifacts(user_id);
CREATE FUNCTION immutable_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'artifact ownership, bytes and scan receipt are immutable';
    END IF;
    IF (to_jsonb(NEW)-'state') IS DISTINCT FROM (to_jsonb(OLD)-'state')
        OR (NEW.state IS DISTINCT FROM OLD.state AND (OLD.state <> 'pending' OR NEW.state <> 'ready')) THEN
        RAISE EXCEPTION 'artifact ownership, bytes and scan receipt are immutable';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER artifact_identity BEFORE UPDATE OR DELETE ON artifacts
    FOR EACH ROW EXECUTE FUNCTION immutable_artifact();
