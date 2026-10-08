-- A receipt is bound to the exact lease owner and immutable contract version.
ALTER TABLE leases ADD CONSTRAINT lease_submission_identity UNIQUE (id,user_id,task_id,task_version,contract_hash);
CREATE TABLE submissions (
    id text PRIMARY KEY,
    lease_id text NOT NULL UNIQUE,
    user_id text NOT NULL,
    task_id text NOT NULL,
    task_version bigint NOT NULL,
    contract_hash text NOT NULL,
    request_key text NOT NULL,
    request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
    base_commit text NOT NULL CHECK (base_commit ~ '^[a-f0-9]{40}$'),
    artifact_id text NOT NULL CHECK (artifact_id ~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$'),
    artifact_sha256 text NOT NULL CHECK (artifact_sha256 ~ '^[a-f0-9]{64}$'),
    artifact_size_bytes bigint NOT NULL CHECK (artifact_size_bytes BETWEEN 1 AND 67108864),
    status text NOT NULL CHECK (status IN ('submitted','verifying','verified_candidate','in_review','accepted','rejected','changes_requested')),
    verification_token text,
    verification_until timestamptz,
    verification_attempts integer NOT NULL DEFAULT 0 CHECK (verification_attempts >= 0),
    verified_at timestamptz,
    verification_result_token text,
    verification_result_hash text CHECK (verification_result_hash ~ '^[a-f0-9]{64}$'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    accepted_at timestamptz,
    UNIQUE (user_id,request_key),
    FOREIGN KEY (lease_id,user_id,task_id,task_version,contract_hash) REFERENCES leases(id,user_id,task_id,task_version,contract_hash),
    CHECK ((verification_token IS NULL) = (verification_until IS NULL)),
    CHECK ((status='verifying') = (verification_token IS NOT NULL)),
    CHECK (status NOT IN ('verified_candidate','in_review','accepted','changes_requested') OR verified_at IS NOT NULL),
    CHECK ((status='accepted') = (accepted_at IS NOT NULL))
);
CREATE UNIQUE INDEX one_task_winner ON submissions(task_id) WHERE status='accepted';
CREATE INDEX pending_task_submissions ON submissions(task_id) WHERE status IN ('submitted','verifying','verified_candidate','in_review','accepted');
CREATE TABLE reviewer_grants (
    project_id text NOT NULL REFERENCES projects(id),
    user_id text NOT NULL REFERENCES users(id),
    role text NOT NULL CHECK (role IN ('maintainer','community')),
    PRIMARY KEY (project_id,user_id,role)
);
CREATE TABLE candidate_reviews (
    submission_id text NOT NULL REFERENCES submissions(id),
    reviewer_id text NOT NULL REFERENCES users(id),
    decision text NOT NULL CHECK (decision IN ('approve','reject','request_changes')),
    comments text NOT NULL CHECK (octet_length(comments)<=2048),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (submission_id,reviewer_id)
);
CREATE FUNCTION immutable_submission_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='DELETE' THEN
        RAISE EXCEPTION 'submission receipts are immutable';
    END IF;
    IF OLD.status='accepted' AND (NEW.status,NEW.accepted_at) IS DISTINCT FROM (OLD.status,OLD.accepted_at) THEN
        RAISE EXCEPTION 'accepted winner is immutable';
    END IF;
    IF (NEW.id,NEW.lease_id,NEW.user_id,NEW.task_id,NEW.task_version,NEW.contract_hash,NEW.request_key,NEW.request_hash,NEW.base_commit,NEW.artifact_id,NEW.artifact_sha256,NEW.artifact_size_bytes,NEW.created_at)
       IS DISTINCT FROM (OLD.id,OLD.lease_id,OLD.user_id,OLD.task_id,OLD.task_version,OLD.contract_hash,OLD.request_key,OLD.request_hash,OLD.base_commit,OLD.artifact_id,OLD.artifact_sha256,OLD.artifact_size_bytes,OLD.created_at) THEN
        RAISE EXCEPTION 'submission identity is immutable';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER submission_identity BEFORE UPDATE OR DELETE ON submissions FOR EACH ROW EXECUTE FUNCTION immutable_submission_identity();
CREATE TRIGGER candidate_review_immutable BEFORE UPDATE OR DELETE ON candidate_reviews FOR EACH ROW EXECUTE FUNCTION immutable_contract();
