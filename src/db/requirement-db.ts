/*
 * @Description: 请填写简介
 */
/**
 * Requirement-graph database (requirement.db)
 *
 * A lightweight, independent SQLite database for requirement memory. It lives
 * in `.codegraph-req/` — separate from the code index in `.codegraph/` — so a
 * full re-index or `uninit` of the code graph never touches it.
 *
 */

import * as fs from 'fs';
import * as path from 'path';
import { createDatabase, type SqliteDatabase } from './sqlite-adapter';
import { getRequirementDir, getRequirementDbPath } from '../directory';

/** `.gitignore` that keeps the whole requirement dir out of git (local-only). */
const REQ_GITIGNORE_CONTENT = `# CodeGraph requirement-graph data — local to each machine, not for committing.
*
!.gitignore
`;

/**
 * SQLite PRAGMAs for requirement.db. Kept minimal on purpose — the big cache /
 * mmap / WAL-heal tuning the code index uses is overkill for a small database.
 */
function configureRequirementConnection(db: SqliteDatabase): void {
  db.pragma('busy_timeout = 5000');   // wait, don't error, on a brief concurrent write
  db.pragma('foreign_keys = ON');     // make the schema's cascades actually fire
  db.pragma('journal_mode = WAL');    // non-blocking reads, crash-safe
  db.pragma('synchronous = NORMAL');  // safe with WAL
}

/**
 * Open the requirement-graph database for a project and ensure its schema exists. 
 * @returns the open connection — the caller owns closing it.
 */
export function initRequirementDb(projectRoot: string): SqliteDatabase {
  const dir = getRequirementDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });

  // Keep the database (and WAL/socket sidecars) out of git. Best-effort.
  const gitignorePath = path.join(dir, '.gitignore');
  try {
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, REQ_GITIGNORE_CONTENT, 'utf-8');
    }
  } catch { /* non-fatal: a missing .gitignore doesn't block the DB */ }

  const dbPath = getRequirementDbPath(projectRoot);
  const { db } = createDatabase(dbPath);
  configureRequirementConnection(db);
  applyRequirementSchema(db);
  return db;
}

/**
 * Apply the requirement schema. The FTS5 virtual table + triggers sit at the
 * end of the file behind a marker, so a Node build without FTS5 can skip just
 * that block while still getting every table.
 */
function applyRequirementSchema(db: SqliteDatabase): void {
  const schemaPath = path.join(__dirname, 'requirement-schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf-8');

  const FTS_MARKER = 'CREATE VIRTUAL TABLE IF NOT EXISTS requirements_fts';
  const ftsIdx = schema.indexOf(FTS_MARKER);
  if (ftsIdx < 0) {
    db.exec(schema);
    return;
  }

  db.exec(schema.slice(0, ftsIdx));
  try {
    db.exec(schema.slice(ftsIdx));
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    console.warn(
      `[codegraph] FTS5 not available in this Node.js build (${msg}). ` +
      `Requirement search will fall back to LIKE matching.`
    );
  }
}
