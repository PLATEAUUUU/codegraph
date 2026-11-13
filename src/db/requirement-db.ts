/*
 * @Description: 请填写简介
 */
/**
 * Requirement-graph database: a standalone SQLite file at
 * `.codegraph-req/requirement.db`, separate from the code index in `.codegraph/`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createDatabase, type SqliteDatabase } from './sqlite-adapter';
import { getRequirementDir, getRequirementDbPath } from '../directory';
import { RequirementStore } from './requirement-store';

/** `.gitignore` written into `.codegraph-req/`; ignores everything but itself. */
const REQ_GITIGNORE_CONTENT = `# CodeGraph requirement-graph data — local to each machine, not for committing.
*
!.gitignore
`;

/** Connection PRAGMAs for requirement.db. */
function configureRequirementConnection(db: SqliteDatabase): void {
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
}

/**
 * Open the requirement-graph database for a project and ensure its schema exists. 
 * @returns the open connection — the caller owns closing it.
 */
export function initRequirementDb(projectRoot: string): SqliteDatabase {
  const dir = getRequirementDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });

  const gitignorePath = path.join(dir, '.gitignore');
  try {
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, REQ_GITIGNORE_CONTENT, 'utf-8');
    }
  } catch { /* ignored */ }

  const dbPath = getRequirementDbPath(projectRoot);
  const { db } = createDatabase(dbPath);
  configureRequirementConnection(db);
  applyRequirementSchema(db);
  return db;
}

/** A RequirementStore over an open connection, with the handle to close it. */
export interface OpenRequirementStore {
  store: RequirementStore;
  close: () => void;
}

/** Open the requirement db and wrap it in a store. Caller must call close(). */
export function openRequirementStore(projectRoot: string): OpenRequirementStore {
  const db = initRequirementDb(projectRoot);
  return { store: new RequirementStore(db), close: () => db.close() };
}

/**
 * Apply the requirement schema: everything before the FTS5 table first, then
 * the FTS5 table, skipped with a warning when FTS5 is unavailable.
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
      `Requirement search is unavailable.`
    );
  }
}
