-- CodeGraph requirement-graph schema (requirement.db)
--
-- Lives in its OWN database (.codegraph-req/requirement.db), independent of the
-- code index (.codegraph/codegraph.db). Requirement memory is long-lived: a full
-- re-index or `uninit` of the code graph must NOT touch it. See requirement-db.ts.
--
-- Node identity note: references into the code graph use a LOGICAL KEY
-- (service, file_path, kind, qualified_name), NOT codegraph's node id — that id
-- is a content hash of (path:kind:name:line) and drifts whenever a symbol moves
-- lines. `codegraph_node_id` here is a nullable write-time snapshot cache only;
-- nothing depends on it staying valid. change_edges point at change_nodes.id
-- (our own stable integer PK), so the modification graph never breaks.

-- Requirements: the PRD/requirement master record.
CREATE TABLE IF NOT EXISTS requirements (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    requirements_id TEXT UNIQUE,              -- external business requirement number (not a FK)
    branch_name     TEXT,
    title           TEXT,
    original_text   TEXT,
    feature_name    TEXT,
    feature_path    TEXT,
    entry_point     TEXT,                     -- JSON array of {type, service?, method?, value}
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);

-- Change sets: one repo's final net change for a requirement.
CREATE TABLE IF NOT EXISTS change_sets (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    requirement_id INTEGER NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
    repo           TEXT,
    service        TEXT,
    branch_name    TEXT,
    base_commit    TEXT,                      -- requirement start version
    final_commit   TEXT,                      -- requirement finish version
    created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_change_sets_req ON change_sets(requirement_id);

-- Change nodes: one changed symbol (file/class/method/function/...) in a requirement.
CREATE TABLE IF NOT EXISTS change_nodes (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    requirement_id     INTEGER NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
    change_set_id      INTEGER NOT NULL REFERENCES change_sets(id) ON DELETE CASCADE,
    file_path          TEXT,
    old_file_path      TEXT,                  -- path before a rename/move
    kind               TEXT,                  -- aligns with codegraph NodeKind: file/class/method/function/...
    qualified_name     TEXT,                  -- line-independent semantic full name; the identity anchor
    old_qualified_name TEXT,                  -- full name before a rename (stitching evidence for delete+add)
    signature          TEXT,                  -- disambiguates overloads sharing a qualified_name
    change_type        TEXT,                  -- add / modify / delete / rename
    git_diff           TEXT                   -- final net diff (base_commit..final_commit)
);
CREATE INDEX IF NOT EXISTS idx_change_nodes_req ON change_nodes(requirement_id);
-- Logical-key composite: "history of a place" queries scan this.
CREATE INDEX IF NOT EXISTS idx_change_nodes_location
    ON change_nodes(service, file_path, kind, qualified_name);

-- Change edges: relationships between changed symbols within a requirement.
-- Endpoints reference change_nodes.id (our own stable PK), never codegraph ids.
CREATE TABLE IF NOT EXISTS change_edges (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    requirement_id        INTEGER NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
    source_change_node_id INTEGER NOT NULL REFERENCES change_nodes(id) ON DELETE CASCADE,
    target_change_node_id INTEGER NOT NULL REFERENCES change_nodes(id) ON DELETE CASCADE,
    relation_type         TEXT,               -- contains / calls / related_to
    evidence_type         TEXT                -- static_analysis / manual / inferred
);
CREATE INDEX IF NOT EXISTS idx_change_edges_req ON change_edges(requirement_id);
CREATE INDEX IF NOT EXISTS idx_change_edges_src ON change_edges(source_change_node_id);
CREATE INDEX IF NOT EXISTS idx_change_edges_tgt ON change_edges(target_change_node_id);

-- =============================================================================
-- Full-text search over requirements (FTS5). Split out at the end so a Node
-- build without FTS5 can skip JUST this block (requirement-db.ts try/catches it)
-- and still get every table above.
-- =============================================================================
CREATE VIRTUAL TABLE IF NOT EXISTS requirements_fts USING fts5(
    title, original_text, feature_name, feature_path,
    content='requirements', content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS requirements_ai AFTER INSERT ON requirements BEGIN
    INSERT INTO requirements_fts(rowid, title, original_text, feature_name, feature_path)
    VALUES (NEW.id, NEW.title, NEW.original_text, NEW.feature_name, NEW.feature_path);
END;
CREATE TRIGGER IF NOT EXISTS requirements_ad AFTER DELETE ON requirements BEGIN
    INSERT INTO requirements_fts(requirements_fts, rowid, title, original_text, feature_name, feature_path)
    VALUES ('delete', OLD.id, OLD.title, OLD.original_text, OLD.feature_name, OLD.feature_path);
END;
CREATE TRIGGER IF NOT EXISTS requirements_au AFTER UPDATE ON requirements BEGIN
    INSERT INTO requirements_fts(requirements_fts, rowid, title, original_text, feature_name, feature_path)
    VALUES ('delete', OLD.id, OLD.title, OLD.original_text, OLD.feature_name, OLD.feature_path);
    INSERT INTO requirements_fts(rowid, title, original_text, feature_name, feature_path)
    VALUES (NEW.id, NEW.title, NEW.original_text, NEW.feature_name, NEW.feature_path);
END;
