-- A counter bumped by every change to which records vector search compares and what it
-- compares them by (membership, vector, profile, scope, kind, superseded, time, id). The store
-- keeps decoded vectors in memory while the counter is unchanged instead of reading every
-- blob on every search. Updates that leave those columns as they were do not bump it, even
-- when they name them: an upsert sets every column, so reinforcing, touching or closing a
-- memory must compare values (`IS NOT`, since `embedding` and `superseded_by` may be NULL).
CREATE TABLE memory_vector_version (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    n  INTEGER NOT NULL
);
INSERT INTO memory_vector_version (id, n) VALUES (1, 0);

CREATE TRIGGER memory_records_vector_insert AFTER INSERT ON memory_records BEGIN
    UPDATE memory_vector_version SET n = n + 1 WHERE id = 1;
END;

CREATE TRIGGER memory_records_vector_delete AFTER DELETE ON memory_records BEGIN
    UPDATE memory_vector_version SET n = n + 1 WHERE id = 1;
END;

CREATE TRIGGER memory_records_vector_update AFTER UPDATE ON memory_records
WHEN OLD.id IS NOT NEW.id
    OR OLD.profile_id IS NOT NEW.profile_id
    OR OLD.kind IS NOT NEW.kind
    OR OLD.scope_key IS NOT NEW.scope_key
    OR OLD.embedding IS NOT NEW.embedding
    OR OLD.created_at IS NOT NEW.created_at
    OR OLD.superseded_by IS NOT NEW.superseded_by
BEGIN
    UPDATE memory_vector_version SET n = n + 1 WHERE id = 1;
END;
