-- CodeGraph requirement-graph schema (.codegraph-req/requirement.db).
--
-- change_nodes identify code by (service, file_path, kind, qualified_name).
-- change_edges reference change_nodes.id.

-- Requirements: the PRD/requirement master record.
CREATE TABLE IF NOT EXISTS requirements (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    requirements_id TEXT UNIQUE,              -- external business requirement number (not a FK)
    title           TEXT,
    original_text   TEXT,
    feature_name    TEXT,
    feature_path    TEXT,
    entry_point     TEXT,                     -- JSON array of backend API paths
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
    base_commit    TEXT,                      -- parent of the requirement's oldest commit
    final_commit   TEXT,                      -- the requirement's newest commit
    created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_change_sets_req ON change_sets(requirement_id);

-- Change nodes: one changed symbol (file/class/method/function/...) in a requirement.
CREATE TABLE IF NOT EXISTS change_nodes (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    requirement_id     INTEGER NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
    change_set_id      INTEGER NOT NULL REFERENCES change_sets(id) ON DELETE CASCADE,
    service            TEXT,                  -- microservice name/id
    file_path          TEXT,
    old_file_path      TEXT,                  -- path before a rename
    kind               TEXT,                  -- codegraph NodeKind: file, module, class, struct, interface, trait, protocol, function, method, property, field, variable, constant, enum, enum_member, type_alias, namespace, parameter, import, export, route, component, union
    qualified_name     TEXT,                  -- semantic full name, e.g. Class::method
    signature          TEXT,                  -- symbol signature text
    change_type        TEXT,                  -- add / modify / delete
    git_diff           TEXT                   -- diff hunks touching this symbol, in commit order
);
CREATE INDEX IF NOT EXISTS idx_change_nodes_req ON change_nodes(requirement_id);
CREATE INDEX IF NOT EXISTS idx_change_nodes_location
    ON change_nodes(service, file_path, kind, qualified_name);

-- Change edges: relationships between changed symbols within a requirement.
CREATE TABLE IF NOT EXISTS change_edges (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    requirement_id        INTEGER NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
    source_change_node_id INTEGER NOT NULL REFERENCES change_nodes(id) ON DELETE CASCADE,
    target_change_node_id INTEGER NOT NULL REFERENCES change_nodes(id) ON DELETE CASCADE,
    relation_type         TEXT                -- codegraph EdgeKind: contains, calls, imports, exports, extends, implements, references, type_of, returns, instantiates, overrides, decorates, navigates
);
CREATE INDEX IF NOT EXISTS idx_change_edges_req ON change_edges(requirement_id);
CREATE INDEX IF NOT EXISTS idx_change_edges_src ON change_edges(source_change_node_id);
CREATE INDEX IF NOT EXISTS idx_change_edges_tgt ON change_edges(target_change_node_id);

-- =============================================================================
-- Full-text search over requirements (FTS5). Holds jieba-segmented text written
-- by RequirementStore; rowid = requirements.id. Must stay the last statement.
-- =============================================================================
CREATE VIRTUAL TABLE IF NOT EXISTS requirements_fts USING fts5(
    title, original_text, feature_name, feature_path
);
