-- Durable metadata only: artifact content and scanner execution live elsewhere.
CREATE TABLE checkpoints (
    id text PRIMARY KEY,
    task_id text NOT NULL,
    task_version bigint NOT NULL,
    contract_hash text NOT NULL,
    lease_id text NOT NULL REFERENCES leases(id),
    user_id text NOT NULL REFERENCES users(id),
    request_key text NOT NULL,
    request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
    parent_id text REFERENCES checkpoints(id),
    base_commit text NOT NULL CHECK (base_commit ~ '^[a-f0-9]{40}$'),
    metadata jsonb NOT NULL CHECK (jsonb_typeof(metadata)='object'),
    artifact_id text NOT NULL CHECK (artifact_id ~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$'),
    artifact_sha256 text NOT NULL CHECK (artifact_sha256 ~ '^[a-f0-9]{64}$'),
    artifact_size_bytes bigint NOT NULL CHECK (artifact_size_bytes BETWEEN 1 AND 67108864),
    status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','verifying','usable','rejected')),
    reason_code text CHECK (reason_code IN ('artifact_invalid','unsafe_paths','secret_detected','unsafe_text','quick_check_failed','incompatible_base')),
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    verified_at timestamptz,
    claim_token text,
    claim_until timestamptz,
    UNIQUE (user_id,request_key),
    FOREIGN KEY (task_id,task_version,contract_hash) REFERENCES task_versions(task_id,version,contract_hash),
    FOREIGN KEY (lease_id,user_id,task_id,task_version,contract_hash) REFERENCES leases(id,user_id,task_id,task_version,contract_hash),
    CHECK (parent_id IS NULL OR parent_id<>id),
    CHECK (expires_at>created_at),
    CHECK ((claim_token IS NULL)=(claim_until IS NULL)),
    CHECK (status<>'verifying' OR claim_token IS NOT NULL),
    CHECK ((status IN ('usable','rejected'))=(verified_at IS NOT NULL)),
    CHECK ((status='rejected')=(reason_code IS NOT NULL)),
    CHECK (metadata ?& ARRAY['schema_version','checkpoint_id','task_id','task_version','contract_hash','lease_id','type','base_commit','summary','continuation_instructions','artifact_sha256']),
    CHECK (jsonb_typeof(metadata->'schema_version')='string' AND jsonb_typeof(metadata->'checkpoint_id')='string'
        AND jsonb_typeof(metadata->'task_id')='string' AND jsonb_typeof(metadata->'task_version')='number'
        AND jsonb_typeof(metadata->'contract_hash')='string' AND jsonb_typeof(metadata->'lease_id')='string'
        AND jsonb_typeof(metadata->'type')='string' AND jsonb_typeof(metadata->'base_commit')='string'
        AND jsonb_typeof(metadata->'artifact_sha256')='string'),
    CHECK (metadata->>'schema_version'='1.0' AND metadata->>'type' IN ('soft','hard')),
    CHECK (jsonb_typeof(metadata->'summary')='string' AND char_length(metadata->>'summary')<=4000),
    CHECK (jsonb_typeof(metadata->'continuation_instructions')='string' AND char_length(metadata->>'continuation_instructions')<=24000),
    CHECK (metadata->>'checkpoint_id'=id AND metadata->>'task_id'=task_id
        AND (metadata->>'task_version')::bigint=task_version AND metadata->>'contract_hash'=contract_hash
        AND metadata->>'lease_id'=lease_id AND metadata->>'base_commit'=base_commit
        AND metadata->>'artifact_sha256'=artifact_sha256),
    CHECK ((metadata->>'parent_checkpoint_id') IS NOT DISTINCT FROM parent_id)
);
CREATE INDEX checkpoints_latest_usable ON checkpoints(task_id,task_version,contract_hash,base_commit,created_at DESC,id DESC) WHERE status='usable';
CREATE INDEX checkpoint_verification_pending ON checkpoints(created_at) WHERE status IN ('submitted','verifying');

-- Ancestry and receipt identity never mutate. No pruning policy is exposed:
-- reaching the contract's chain limit rejects new metadata until future policy.
CREATE FUNCTION immutable_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.id,NEW.task_id,NEW.task_version,NEW.contract_hash,NEW.lease_id,NEW.user_id,
        NEW.request_key,NEW.request_hash,NEW.parent_id,NEW.base_commit,NEW.metadata,
        NEW.artifact_id,NEW.artifact_sha256,NEW.artifact_size_bytes,NEW.created_at,NEW.expires_at)
        IS DISTINCT FROM
       (OLD.id,OLD.task_id,OLD.task_version,OLD.contract_hash,OLD.lease_id,OLD.user_id,
        OLD.request_key,OLD.request_hash,OLD.parent_id,OLD.base_commit,OLD.metadata,
        OLD.artifact_id,OLD.artifact_sha256,OLD.artifact_size_bytes,OLD.created_at,OLD.expires_at) THEN
        RAISE EXCEPTION 'checkpoint identity and ancestry are immutable';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER checkpoint_identity BEFORE UPDATE ON checkpoints FOR EACH ROW EXECUTE FUNCTION immutable_checkpoint();
