-- Keep lease lifecycle uniqueness; a lease may produce several checkpoints,
-- verifier claims or reviewer decisions. Each delivered event has its own ID.
ALTER TABLE outbox DROP CONSTRAINT outbox_aggregate_id_kind_key;
CREATE UNIQUE INDEX one_lease_lifecycle_event ON outbox(aggregate_id,kind) WHERE kind LIKE 'lease.%';
ALTER TABLE outbox DROP CONSTRAINT outbox_kind_check;
ALTER TABLE outbox ADD COLUMN entity_id text;
ALTER TABLE outbox ADD CONSTRAINT outbox_kind_check CHECK (kind IN (
    'lease.reserved','lease.started','lease.stop_requested','lease.ended',
    'submission.submitted','submission.verified','submission.rejected','submission.reviewed','task.accepted',
    'checkpoint.submitted','checkpoint.verification_started','checkpoint.usable','checkpoint.rejected'
));
ALTER TABLE outbox ADD CONSTRAINT outbox_entity_check CHECK (
    (kind LIKE 'lease.%' AND entity_id IS NULL)
    OR (kind NOT LIKE 'lease.%' AND entity_id IS NOT NULL AND entity_id ~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$')
);
