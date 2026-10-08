-- CommonGrid identities and opaque sessions. Provider credentials are never
-- persisted here; AI CLI accounts are outside this schema entirely.
CREATE TABLE external_identities (
    provider text NOT NULL CHECK (provider IN ('github','google')),
    subject text NOT NULL CHECK (octet_length(subject) BETWEEN 1 AND 255 AND subject ~ '^[!-~]+$'),
    user_id text NOT NULL REFERENCES users(id),
    display_name text NOT NULL CHECK (octet_length(display_name)<=320),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (provider,subject),
    UNIQUE (user_id,provider)
);
CREATE TABLE auth_sessions (
    token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
    user_id text NOT NULL,
    provider text NOT NULL,
    csrf_token text NOT NULL CHECK (csrf_token ~ '^[a-zA-Z0-9_-]{43}$'),
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    FOREIGN KEY (user_id,provider) REFERENCES external_identities(user_id,provider),
    CHECK (expires_at>created_at AND expires_at<=created_at+interval '24 hours')
);
CREATE INDEX auth_session_expiry ON auth_sessions(expires_at);
CREATE TABLE oauth_flows (
    state_hash text PRIMARY KEY CHECK (state_hash ~ '^[a-f0-9]{64}$'),
    browser_hash text NOT NULL CHECK (browser_hash ~ '^[a-f0-9]{64}$'),
    provider text NOT NULL CHECK (provider IN ('github','google')),
    verifier text NOT NULL CHECK (verifier ~ '^[a-zA-Z0-9._~-]{43,128}$'),
    nonce text NOT NULL CHECK (nonce ~ '^[a-zA-Z0-9_-]{43}$'),
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    UNIQUE (browser_hash,provider),
    CHECK (expires_at>created_at AND expires_at<=created_at+interval '10 minutes')
);
CREATE INDEX oauth_flow_expiry ON oauth_flows(expires_at);
CREATE FUNCTION immutable_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.provider,NEW.subject,NEW.user_id,NEW.created_at) IS DISTINCT FROM (OLD.provider,OLD.subject,OLD.user_id,OLD.created_at) THEN
        RAISE EXCEPTION 'external identity is immutable';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER identity_binding BEFORE UPDATE ON external_identities FOR EACH ROW EXECUTE FUNCTION immutable_identity();
