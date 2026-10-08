CREATE TABLE users (
    id text PRIMARY KEY,
    max_concurrent integer NOT NULL DEFAULT 1 CHECK (max_concurrent BETWEEN 1 AND 64),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE projects (
    id text PRIMARY KEY,
    owner_id text NOT NULL REFERENCES users(id),
    max_attempt_sec integer NOT NULL CHECK (max_attempt_sec BETWEEN 1 AND 86400),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE nodes (
    id text PRIMARY KEY,
    project_id text NOT NULL REFERENCES projects(id),
    parent_id text,
    UNIQUE (id, project_id),
    FOREIGN KEY (parent_id, project_id) REFERENCES nodes(id, project_id),
    CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE TABLE budget_accounts (
    id text PRIMARY KEY,
    project_id text NOT NULL REFERENCES projects(id),
    scope text NOT NULL CHECK (scope IN ('project','node')),
    node_id text,
    limit_ms bigint NOT NULL CHECK (limit_ms BETWEEN 1 AND 9000000000000),
    reserved_ms bigint NOT NULL DEFAULT 0 CHECK (reserved_ms >= 0),
    spent_ms bigint NOT NULL DEFAULT 0 CHECK (spent_ms >= 0),
    FOREIGN KEY (node_id, project_id) REFERENCES nodes(id, project_id),
    CHECK ((scope = 'project' AND node_id IS NULL) OR (scope = 'node' AND node_id IS NOT NULL)),
    CHECK (reserved_ms + spent_ms <= limit_ms)
);
CREATE UNIQUE INDEX one_project_budget ON budget_accounts(project_id) WHERE scope = 'project';
CREATE UNIQUE INDEX one_node_budget ON budget_accounts(node_id) WHERE scope = 'node';

CREATE TABLE tasks (
    id text PRIMARY KEY,
    project_id text NOT NULL REFERENCES projects(id),
    node_id text NOT NULL,
    current_version bigint NOT NULL CHECK (current_version > 0),
    current_hash text NOT NULL CHECK (current_hash ~ '^[a-f0-9]{64}$'),
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resumable','awaiting_review','accepted','archived')),
    FOREIGN KEY (node_id, project_id) REFERENCES nodes(id, project_id)
);

CREATE TABLE task_versions (
    task_id text NOT NULL REFERENCES tasks(id),
    version bigint NOT NULL CHECK (version > 0),
    contract_hash text NOT NULL CHECK (contract_hash ~ '^[a-f0-9]{64}$'),
    contract jsonb NOT NULL CHECK (jsonb_typeof(contract) = 'object'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (task_id, version),
    UNIQUE (task_id, version, contract_hash),
    CHECK (contract ?& ARRAY['id','task_version','contract_hash']),
    CHECK (contract->>'id' = task_id),
    CHECK ((contract->>'task_version')::bigint = version),
    CHECK (contract->>'contract_hash' = contract_hash)
);
ALTER TABLE tasks ADD CONSTRAINT current_task_contract FOREIGN KEY (id,current_version,current_hash)
    REFERENCES task_versions(task_id,version,contract_hash) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE leases (
    id text PRIMARY KEY,
    attempt_id text NOT NULL UNIQUE,
    user_id text NOT NULL REFERENCES users(id),
    task_id text NOT NULL,
    task_version bigint NOT NULL,
    contract_hash text NOT NULL,
    strategy_id text NOT NULL,
    request_key text NOT NULL,
    request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
    state text NOT NULL CHECK (state IN ('reserved','active','stop_requested','completed','released','expired')),
    effective_limit_sec integer NOT NULL CHECK (effective_limit_sec BETWEEN 1 AND 86400),
    reserved_ms bigint NOT NULL CHECK (reserved_ms > 0),
    spent_ms bigint NOT NULL DEFAULT 0 CHECK (spent_ms BETWEEN 0 AND reserved_ms),
    overrun_ms bigint NOT NULL DEFAULT 0 CHECK (overrun_ms >= 0),
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    started_at timestamptz,
    stop_requested_at timestamptz,
    ended_at timestamptz,
    UNIQUE (user_id,request_key),
    FOREIGN KEY (task_id,task_version,contract_hash) REFERENCES task_versions(task_id,version,contract_hash),
    CHECK (expires_at > created_at),
    CHECK (started_at IS NULL OR started_at >= created_at),
    CHECK ((state IN ('reserved','active','stop_requested') AND ended_at IS NULL)
        OR (state IN ('completed','released','expired') AND ended_at IS NOT NULL))
);
CREATE UNIQUE INDEX one_user_task_lease ON leases(user_id,task_id)
    WHERE state IN ('reserved','active','stop_requested');
CREATE INDEX live_task_leases ON leases(task_id) WHERE state IN ('reserved','active','stop_requested');
CREATE INDEX due_leases ON leases(expires_at) WHERE state IN ('reserved','active','stop_requested');

CREATE TABLE lease_budgets (
    lease_id text NOT NULL REFERENCES leases(id),
    account_id text NOT NULL REFERENCES budget_accounts(id),
    reserved_ms bigint NOT NULL CHECK (reserved_ms > 0),
    PRIMARY KEY (lease_id,account_id)
);

CREATE TABLE outbox (
    sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id text NOT NULL UNIQUE,
    aggregate_id text NOT NULL REFERENCES leases(id),
    kind text NOT NULL CHECK (kind IN ('lease.reserved','lease.started','lease.stop_requested','lease.ended')),
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 4096),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    claim_token text,
    claim_until timestamptz,
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    delivered_at timestamptz,
    last_error_code text CHECK (last_error_code IN ('delivery_failed')),
    UNIQUE (aggregate_id,kind),
    CHECK ((claim_token IS NULL) = (claim_until IS NULL))
);
CREATE INDEX pending_outbox ON outbox(sequence) WHERE delivered_at IS NULL;

-- Scope ancestry and task identity cannot change beneath an existing lease.
CREATE FUNCTION immutable_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_TABLE_NAME = 'nodes' THEN
        IF (NEW.project_id,NEW.parent_id) IS DISTINCT FROM (OLD.project_id,OLD.parent_id) THEN
            RAISE EXCEPTION 'node ancestry is immutable';
        END IF;
    ELSIF TG_TABLE_NAME = 'tasks' THEN
        IF (NEW.project_id,NEW.node_id) IS DISTINCT FROM (OLD.project_id,OLD.node_id) THEN
            RAISE EXCEPTION 'task scope is immutable';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER nodes_scope BEFORE UPDATE ON nodes FOR EACH ROW EXECUTE FUNCTION immutable_scope();
CREATE TRIGGER tasks_scope BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION immutable_scope();
CREATE FUNCTION immutable_contract() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'task versions are immutable';
END;
$$;
CREATE TRIGGER task_version_immutable BEFORE UPDATE OR DELETE ON task_versions FOR EACH ROW EXECUTE FUNCTION immutable_contract();
