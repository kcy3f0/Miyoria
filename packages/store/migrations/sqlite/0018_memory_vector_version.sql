-- A counter bumped by every change to which records vector search compares and what it
-- compares them by (membership, vector, profile, scope, kind, superseded, time, id). The store
-- keeps decoded vectors in memory while the counter is unchanged instead of reading every
-- blob on every search. Access counts and `done` do not bump it.
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

CREATE TRIGGER memory_records_vector_update
AFTER UPDATE OF id, profile_id, kind, scope_key, embedding, created_at, superseded_by
ON memory_records BEGIN
    UPDATE memory_vector_version SET n = n + 1 WHERE id = 1;
END;
