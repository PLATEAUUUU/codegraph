/**
 * CRUD over the requirement-graph database (requirement.db).
 *
 * Takes an open connection; the caller owns its lifecycle. Rows are returned
 * camelCase. change_nodes / change_edges are append-only (no update).
 */

import type { SqliteDatabase, SqliteStatement } from './sqlite-adapter';
import { segment, addTerms } from '../requirement/segmenter';

export interface RequirementRow {
  id: number;
  requirementsId: string | null;
  title: string | null;
  originalText: string | null;
  featureName: string | null;
  featurePath: string | null;
  entryPoint: string | null; // JSON string
  createdAt: number;
  updatedAt: number;
}

export interface CommitInfo {
  sha: string;
  message: string;
}

export interface ChangeSetRow {
  id: number;
  requirementId: number;
  repo: string | null;
  service: string | null;
  branchName: string | null;
  baseCommit: string | null;
  finalCommit: string | null;
  commits: CommitInfo[];
  createdAt: number;
}

export interface ChangeNodeRow {
  id: number;
  requirementId: number;
  changeSetId: number;
  service: string | null;
  filePath: string | null;
  oldFilePath: string | null;
  kind: string | null;
  qualifiedName: string | null;
  signature: string | null;
  changeType: string | null;
  gitDiff: string | null;
}

export interface ChangeEdgeRow {
  id: number;
  requirementId: number;
  sourceChangeNodeId: number;
  targetChangeNodeId: number;
  relationType: string | null;
}

// Insert shapes: id and timestamps are assigned by the store. FK columns are
// required; other fields optional and default to NULL.

export type RequirementInput = Partial<Omit<RequirementRow, 'id' | 'createdAt' | 'updatedAt'>>;

export type ChangeSetInput = Partial<Omit<ChangeSetRow, 'id' | 'createdAt' | 'requirementId'>>
  & { requirementId: number };
export type ChangeNodeInput = Partial<Omit<ChangeNodeRow, 'id' | 'requirementId' | 'changeSetId'>>
  & { requirementId: number; changeSetId: number };
export type ChangeEdgeInput = Partial<Omit<ChangeEdgeRow, 'id' | 'requirementId' | 'sourceChangeNodeId' | 'targetChangeNodeId'>>
  & { requirementId: number; sourceChangeNodeId: number; targetChangeNodeId: number };

/** A requirement plus every record hanging off it. */
export interface RequirementDetail {
  requirement: RequirementRow;
  changeSets: ChangeSetRow[];
  changeNodes: ChangeNodeRow[];
  changeEdges: ChangeEdgeRow[];
}

/** An edge referencing change_nodes by their position in a service's node list. */
export interface BundleEdge {
  sourceIndex: number;
  targetIndex: number;
  relationType: string;
}

/** One service's change set, its nodes, and the edges among them. */
export interface BundleService {
  changeSet: ChangeSetInput;
  changeNodes: ChangeNodeInput[];
  edges: BundleEdge[];
}

/** A whole requirement ready to write: the requirement plus every service. */
export interface RequirementBundle {
  requirement: RequirementInput;
  services: BundleService[];
}

/** A custom dictionary term. */
export interface DictTerm {
  term: string;
  freq: number | null;
}

/** One change to a location, with the requirement and commits it came from. */
export interface LocationHistoryEntry {
  requirementsId: string | null;
  title: string | null;
  service: string | null;
  changeType: string | null;
  filePath: string | null;
  gitDiff: string | null;
  commits: CommitInfo[];
  createdAt: number;
}

// =============================================================================
// Store
// =============================================================================

export class RequirementStore {
  private db: SqliteDatabase;
  private stmts: {
    insertRequirement?: SqliteStatement;
    insertChangeSet?: SqliteStatement;
    insertChangeNode?: SqliteStatement;
    insertChangeEdge?: SqliteStatement;
    getRequirement?: SqliteStatement;
    getRequirementByReqId?: SqliteStatement;
    listRequirements?: SqliteStatement;
    getChangeSetsByReq?: SqliteStatement;
    getChangeNodesByChangeSet?: SqliteStatement;
    getChangeEdgesByReq?: SqliteStatement;
    deleteRequirement?: SqliteStatement;
    deleteChangeSet?: SqliteStatement;
    ftsInsert?: SqliteStatement;
    ftsDelete?: SqliteStatement;
    searchRequirements?: SqliteStatement;
  } = {};

  constructor(db: SqliteDatabase) {
    this.db = db;
    addTerms(this.listDictTerms());
  }

  /** Run `fn` in a single transaction. */
  runInTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /** Write a requirement's segmented text into the FTS index (rowid = id). */
  private writeFts(id: number, r: RequirementInput): void {
    if (!this.stmts.ftsInsert) {
      this.stmts.ftsInsert = this.db.prepare(
        `INSERT INTO requirements_fts(rowid, title, original_text, feature_name, feature_path)
         VALUES (@rowid, @title, @originalText, @featureName, @featurePath)`
      );
    }
    this.stmts.ftsInsert.run({
      rowid: id,
      title: segment(r.title),
      originalText: segment(r.originalText),
      featureName: segment(r.featureName),
      featurePath: segment(r.featurePath),
    });
  }

  private deleteFts(id: number): void {
    if (!this.stmts.ftsDelete) {
      this.stmts.ftsDelete = this.db.prepare('DELETE FROM requirements_fts WHERE rowid = ?');
    }
    this.stmts.ftsDelete.run(id);
  }

  // --- row mappers: snake_case DB row -> camelCase typed row ---------------
  private toRequirement(r: any): RequirementRow | null {
    if (!r) return null;
    return {
      id: r.id,
      requirementsId: r.requirements_id ?? null,
      title: r.title ?? null,
      originalText: r.original_text ?? null,
      featureName: r.feature_name ?? null,
      featurePath: r.feature_path ?? null,
      entryPoint: r.entry_point ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private toChangeSet(r: any): ChangeSetRow | null {
    if (!r) return null;
    return {
      id: r.id,
      requirementId: r.requirement_id,
      repo: r.repo ?? null,
      service: r.service ?? null,
      branchName: r.branch_name ?? null,
      baseCommit: r.base_commit ?? null,
      finalCommit: r.final_commit ?? null,
      commits: r.commits ? JSON.parse(r.commits) : [],
      createdAt: r.created_at,
    };
  }

  private toChangeNode(r: any): ChangeNodeRow | null {
    if (!r) return null;
    return {
      id: r.id,
      requirementId: r.requirement_id,
      changeSetId: r.change_set_id,
      service: r.service ?? null,
      filePath: r.file_path ?? null,
      oldFilePath: r.old_file_path ?? null,
      kind: r.kind ?? null,
      qualifiedName: r.qualified_name ?? null,
      signature: r.signature ?? null,
      changeType: r.change_type ?? null,
      gitDiff: r.git_diff ?? null,
    };
  }

  private toChangeEdge(r: any): ChangeEdgeRow | null {
    if (!r) return null;
    return {
      id: r.id,
      requirementId: r.requirement_id,
      sourceChangeNodeId: r.source_change_node_id,
      targetChangeNodeId: r.target_change_node_id,
      relationType: r.relation_type ?? null,
    };
  }

  // --- inserts: return the new auto-increment id --------------------------
  insertRequirement(input: RequirementInput): number {
    if (!this.stmts.insertRequirement) {
      this.stmts.insertRequirement = this.db.prepare(`
        INSERT INTO requirements (
          requirements_id, title, original_text,
          feature_name, feature_path, entry_point, created_at, updated_at
        ) VALUES (
          @requirementsId, @title, @originalText,
          @featureName, @featurePath, @entryPoint, @createdAt, @updatedAt
        )
      `);
    }
    const now = Date.now();
    const info = this.stmts.insertRequirement.run({
      requirementsId: input.requirementsId ?? null,
      title: input.title ?? null,
      originalText: input.originalText ?? null,
      featureName: input.featureName ?? null,
      featurePath: input.featurePath ?? null,
      entryPoint: input.entryPoint ?? null,
      createdAt: now,
      updatedAt: now,
    });
    const id = Number(info.lastInsertRowid);
    this.writeFts(id, input);
    return id;
  }

  insertChangeSet(input: ChangeSetInput): number {
    if (!this.stmts.insertChangeSet) {
      this.stmts.insertChangeSet = this.db.prepare(`
        INSERT INTO change_sets (
          requirement_id, repo, service, branch_name,
          base_commit, final_commit, commits, created_at
        ) VALUES (
          @requirementId, @repo, @service, @branchName,
          @baseCommit, @finalCommit, @commits, @createdAt
        )
      `);
    }
    const info = this.stmts.insertChangeSet.run({
      requirementId: input.requirementId,
      repo: input.repo ?? null,
      service: input.service ?? null,
      branchName: input.branchName ?? null,
      baseCommit: input.baseCommit ?? null,
      finalCommit: input.finalCommit ?? null,
      commits: JSON.stringify(input.commits ?? []),
      createdAt: Date.now(),
    });
    return Number(info.lastInsertRowid);
  }

  insertChangeNode(input: ChangeNodeInput): number {
    if (!this.stmts.insertChangeNode) {
      this.stmts.insertChangeNode = this.db.prepare(`
        INSERT INTO change_nodes (
          requirement_id, change_set_id, service,
          file_path, old_file_path, kind, qualified_name,
          signature, change_type, git_diff
        ) VALUES (
          @requirementId, @changeSetId, @service,
          @filePath, @oldFilePath, @kind, @qualifiedName,
          @signature, @changeType, @gitDiff
        )
      `);
    }
    const info = this.stmts.insertChangeNode.run({
      requirementId: input.requirementId,
      changeSetId: input.changeSetId,
      service: input.service ?? null,
      filePath: input.filePath ?? null,
      oldFilePath: input.oldFilePath ?? null,
      kind: input.kind ?? null,
      qualifiedName: input.qualifiedName ?? null,
      signature: input.signature ?? null,
      changeType: input.changeType ?? null,
      gitDiff: input.gitDiff ?? null,
    });
    return Number(info.lastInsertRowid);
  }

  insertChangeEdge(input: ChangeEdgeInput): number {
    if (!this.stmts.insertChangeEdge) {
      this.stmts.insertChangeEdge = this.db.prepare(`
        INSERT INTO change_edges (
          requirement_id, source_change_node_id, target_change_node_id,
          relation_type
        ) VALUES (
          @requirementId, @sourceChangeNodeId, @targetChangeNodeId,
          @relationType
        )
      `);
    }
    const info = this.stmts.insertChangeEdge.run({
      requirementId: input.requirementId,
      sourceChangeNodeId: input.sourceChangeNodeId,
      targetChangeNodeId: input.targetChangeNodeId,
      relationType: input.relationType ?? null,
    });
    return Number(info.lastInsertRowid);
  }

  // --- child-collection reads ---------------------------------------------
  getChangeSetsByRequirement(requirementId: number): ChangeSetRow[] {
    if (!this.stmts.getChangeSetsByReq) {
      this.stmts.getChangeSetsByReq = this.db.prepare(
        'SELECT * FROM change_sets WHERE requirement_id = ? ORDER BY id'
      );
    }
    return this.stmts.getChangeSetsByReq.all(requirementId).map((r) => this.toChangeSet(r)!);
  }

  getChangeNodesByChangeSet(changeSetId: number): ChangeNodeRow[] {
    if (!this.stmts.getChangeNodesByChangeSet) {
      this.stmts.getChangeNodesByChangeSet = this.db.prepare(
        'SELECT * FROM change_nodes WHERE change_set_id = ? ORDER BY id'
      );
    }
    return this.stmts.getChangeNodesByChangeSet.all(changeSetId).map((r) => this.toChangeNode(r)!);
  }

  getChangeEdgesByRequirement(requirementId: number): ChangeEdgeRow[] {
    if (!this.stmts.getChangeEdgesByReq) {
      this.stmts.getChangeEdgesByReq = this.db.prepare(
        'SELECT * FROM change_edges WHERE requirement_id = ? ORDER BY id'
      );
    }
    return this.stmts.getChangeEdgesByReq.all(requirementId).map((r) => this.toChangeEdge(r)!);
  }

  // --- requirement reads ---------------------------------------------------
  /** A requirement with its change sets, nodes, and edges. null if absent. */
  getRequirementById(id: number): RequirementDetail | null {
    if (!this.stmts.getRequirement) {
      this.stmts.getRequirement = this.db.prepare('SELECT * FROM requirements WHERE id = ?');
    }
    const requirement = this.toRequirement(this.stmts.getRequirement.get(id));
    if (!requirement) return null;
    return {
      requirement,
      changeSets: this.getChangeSetsByRequirement(id),
      changeNodes: this.getChangeNodesByRequirement(id),
      changeEdges: this.getChangeEdgesByRequirement(id),
    };
  }

  /** As getRequirementById, keyed by the external requirement number. */
  getRequirementByReqId(requirementsId: string): RequirementDetail | null {
    if (!this.stmts.getRequirementByReqId) {
      this.stmts.getRequirementByReqId = this.db.prepare(
        'SELECT id FROM requirements WHERE requirements_id = ?'
      );
    }
    const row = this.stmts.getRequirementByReqId.get(requirementsId);
    if (!row) return null;
    return this.getRequirementById(row.id);
  }

  /** Every change_node for a requirement, across all its change sets. */
  getChangeNodesByRequirement(requirementId: number): ChangeNodeRow[] {
    return this.db
      .prepare('SELECT * FROM change_nodes WHERE requirement_id = ? ORDER BY id')
      .all(requirementId)
      .map((r) => this.toChangeNode(r)!);
  }

  /** Requirements newest-first, paginated. */
  listRequirements(limit = 50, offset = 0): RequirementRow[] {
    if (!this.stmts.listRequirements) {
      this.stmts.listRequirements = this.db.prepare(
        'SELECT * FROM requirements ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?'
      );
    }
    return this.stmts.listRequirements.all(limit, offset).map((r) => this.toRequirement(r)!);
  }

  /**
   * Update the fields present in `patch`; always refreshes `updated_at`.
   * Unknown keys are ignored.
   */
  updateRequirement(id: number, patch: RequirementInput): void {
    const columns: Record<keyof RequirementInput, string> = {
      requirementsId: 'requirements_id',
      title: 'title',
      originalText: 'original_text',
      featureName: 'feature_name',
      featurePath: 'feature_path',
      entryPoint: 'entry_point',
    };

    const sets: string[] = [];
    const params: Record<string, unknown> = { id, updatedAt: Date.now() };
    for (const key of Object.keys(patch) as (keyof RequirementInput)[]) {
      const col = columns[key];
      if (!col) continue; // ignore unknown keys
      sets.push(`${col} = @${key}`);
      params[key] = patch[key] ?? null;
    }
    sets.push('updated_at = @updatedAt');

    this.runInTransaction(() => {
      this.db.prepare(`UPDATE requirements SET ${sets.join(', ')} WHERE id = @id`).run(params);
      // Rewrite the FTS row from the full updated record.
      const detail = this.getRequirementById(id);
      if (detail) {
        this.deleteFts(id);
        this.writeFts(id, detail.requirement);
      }
    });
  }

  // --- deletes (dependent rows cascade via FK) ----------------------------
  deleteRequirement(id: number): void {
    if (!this.stmts.deleteRequirement) {
      this.stmts.deleteRequirement = this.db.prepare('DELETE FROM requirements WHERE id = ?');
    }
    this.runInTransaction(() => {
      this.deleteFts(id);
      this.stmts.deleteRequirement!.run(id);
    });
  }

  deleteChangeSet(id: number): void {
    if (!this.stmts.deleteChangeSet) {
      this.stmts.deleteChangeSet = this.db.prepare('DELETE FROM change_sets WHERE id = ?');
    }
    this.stmts.deleteChangeSet.run(id);
  }

  /**
   * Full-text search over requirements. `query` is segmented the same way as
   * indexed text; tokens are OR-matched and ranked by bm25. Returns whole
   * requirement rows, most relevant first. Empty query → [].
   */
  searchRequirements(query: string, limit = 3): RequirementRow[] {
    const tokens = segment(query).split(' ').filter((t) => t.length > 0);
    if (tokens.length === 0) return [];
    const match = tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');

    if (!this.stmts.searchRequirements) {
      this.stmts.searchRequirements = this.db.prepare(
        `SELECT r.* FROM requirements_fts f
         JOIN requirements r ON r.id = f.rowid
         WHERE requirements_fts MATCH ?
         ORDER BY bm25(requirements_fts) LIMIT ?`
      );
    }
    return this.stmts.searchRequirements.all(match, limit).map((r) => this.toRequirement(r)!);
  }

  /**
   * Write a whole requirement in one transaction: the requirement, then each
   * service's change set, its change nodes, and the edges among them (edge
   * indices address that service's node list). Returns the new requirement id.
   */
  saveRequirementBundle(bundle: RequirementBundle): number {
    return this.runInTransaction(() => {
      const reqId = this.insertRequirement(bundle.requirement);
      for (const svc of bundle.services) {
        const csId = this.insertChangeSet({ ...svc.changeSet, requirementId: reqId });
        const nodeIds = svc.changeNodes.map((n) =>
          this.insertChangeNode({ ...n, requirementId: reqId, changeSetId: csId })
        );
        for (const e of svc.edges) {
          const source = nodeIds[e.sourceIndex];
          const target = nodeIds[e.targetIndex];
          if (source === undefined || target === undefined) continue;
          this.insertChangeEdge({
            requirementId: reqId,
            sourceChangeNodeId: source,
            targetChangeNodeId: target,
            relationType: e.relationType,
          });
        }
      }
      return reqId;
    });
  }

  /**
   * Distinct locations whose qualified name contains `fragment` (ASCII
   * case-insensitive), limited to `service` when given.
   */
  findLocations(fragment: string, service?: string, limit = 20): Array<{ service: string | null; qualifiedName: string }> {
    const pattern = `%${fragment.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const where = service ? 'service = ? AND ' : '';
    const params = service ? [service, pattern, limit] : [pattern, limit];
    return this.db.prepare(
      `SELECT DISTINCT service, qualified_name FROM change_nodes
       WHERE ${where}qualified_name LIKE ? ESCAPE '\\'
       ORDER BY service, qualified_name LIMIT ?`
    ).all(...params).map((r: any) => ({ service: r.service ?? null, qualifiedName: r.qualified_name }));
  }

  /** Every change to `service` + `qualifiedName` across requirements, newest first. */
  getLocationHistory(service: string, qualifiedName: string): LocationHistoryEntry[] {
    const rows = this.db.prepare(
      `SELECT req.requirements_id, req.title, cn.service, cn.change_type,
              cn.file_path, cn.git_diff, cs.commits, req.created_at
       FROM change_nodes cn
       JOIN change_sets cs ON cs.id = cn.change_set_id
       JOIN requirements req ON req.id = cn.requirement_id
       WHERE cn.service = ? AND cn.qualified_name = ?
       ORDER BY req.created_at DESC, cn.id DESC`
    ).all(service, qualifiedName);

    return rows.map((r: any) => ({
      requirementsId: r.requirements_id ?? null,
      title: r.title ?? null,
      service: r.service ?? null,
      changeType: r.change_type ?? null,
      filePath: r.file_path ?? null,
      gitDiff: r.git_diff ?? null,
      commits: r.commits ? JSON.parse(r.commits) : [],
      createdAt: r.created_at,
    }));
  }

  // --- custom dictionary --------------------------------------------------

  listDictTerms(): DictTerm[] {
    return this.db.prepare('SELECT term, freq FROM dict_terms ORDER BY term').all()
      .map((r: any) => ({ term: r.term, freq: r.freq ?? null }));
  }

  /** Insert or update terms, load them into jieba, then re-segment every requirement. */
  addDictTerms(terms: DictTerm[]): void {
    const upsert = this.db.prepare(
      `INSERT INTO dict_terms (term, freq, created_at) VALUES (?, ?, ?)
       ON CONFLICT(term) DO UPDATE SET freq = excluded.freq`
    );
    this.runInTransaction(() => {
      for (const t of terms) upsert.run(t.term, t.freq, Date.now());
    });
    addTerms(terms);
    this.resegmentAll();
  }

  /**
   * Delete terms, zero their frequency in jieba, then re-segment every
   * requirement. Returns the terms that existed.
   */
  removeDictTerms(terms: string[]): string[] {
    const del = this.db.prepare('DELETE FROM dict_terms WHERE term = ?');
    const removed = this.runInTransaction(() => terms.filter((t) => del.run(t).changes > 0));
    if (removed.length > 0) {
      addTerms(removed.map((term) => ({ term, freq: 0 })));
      this.resegmentAll();
    }
    return removed;
  }

  /** Rewrite every requirement's FTS row with the current dictionary. */
  resegmentAll(): void {
    const rows = this.db.prepare('SELECT * FROM requirements').all();
    this.runInTransaction(() => {
      for (const row of rows) {
        const r = this.toRequirement(row)!;
        this.deleteFts(r.id);
        this.writeFts(r.id, r);
      }
    });
  }
}
