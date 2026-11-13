import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initRequirementDb } from '../src/db/requirement-db';
import { RequirementStore } from '../src/db/requirement-store';
import { getRequirementDbPath, REQUIREMENT_DIR } from '../src/directory';
import type { SqliteDatabase } from '../src/db/sqlite-adapter';

let tmp: string;
let db: SqliteDatabase;
let store: RequirementStore;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'req-store-'));
  db = initRequirementDb(tmp);
  store = new RequirementStore(db);
});

afterEach(() => {
  db.close(); // release the file handle before removing the dir (Windows)
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch { /* best-effort: Windows may still hold the SQLite handle briefly */ }
});

/** Table/view names present in the database. */
function tableNames(): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
    .all()
    .map((r: any) => r.name);
}

describe('requirement db init', () => {
  it('creates the database file under .codegraph-req/', () => {
    expect(fs.existsSync(getRequirementDbPath(tmp))).toBe(true);
    expect(fs.existsSync(path.join(tmp, REQUIREMENT_DIR, '.gitignore'))).toBe(true);
  });

  it('creates every requirement table and the FTS table', () => {
    const names = tableNames();
    for (const t of ['requirements', 'change_sets', 'change_nodes', 'change_edges', 'requirements_fts']) {
      expect(names).toContain(t);
    }
  });

  it('enables foreign key enforcement', () => {
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});

describe('inserts', () => {
  it('returns increasing auto-increment ids', () => {
    const a = store.insertRequirement({ title: 'A' });
    const b = store.insertRequirement({ title: 'B' });
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
  });

  it('binds omitted fields to null and fills timestamps', () => {
    const before = Date.now();
    const id = store.insertRequirement({ title: 'only title' });
    const detail = store.getRequirementById(id)!;
    expect(detail.requirement.title).toBe('only title');
    expect(detail.requirement.featureName).toBeNull();
    expect(detail.requirement.entryPoint).toBeNull();
    expect(detail.requirement.createdAt).toBeGreaterThanOrEqual(before);
    expect(detail.requirement.updatedAt).toBe(detail.requirement.createdAt);
  });

  it('inserts child rows returning their ids', () => {
    const reqId = store.insertRequirement({ title: 'R' });
    const csId = store.insertChangeSet({ requirementId: reqId, service: 'svc' });
    const n1 = store.insertChangeNode({ requirementId: reqId, changeSetId: csId, qualifiedName: 'A::f' });
    const n2 = store.insertChangeNode({ requirementId: reqId, changeSetId: csId, qualifiedName: 'A::g' });
    const edge = store.insertChangeEdge({
      requirementId: reqId,
      sourceChangeNodeId: n1,
      targetChangeNodeId: n2,
      relationType: 'calls',
    });
    expect([csId, n1, n2, edge].every((x) => x > 0)).toBe(true);
    expect(n2).toBeGreaterThan(n1);
  });
});

describe('reads', () => {
  it('returns null for a missing id', () => {
    expect(store.getRequirementById(999)).toBeNull();
  });

  it('assembles a requirement with its change sets, nodes and edges', () => {
    const reqId = store.insertRequirement({ title: 'R', requirementsId: 'REQ-1' });
    const csId = store.insertChangeSet({ requirementId: reqId, service: 'svc' });
    const n1 = store.insertChangeNode({ requirementId: reqId, changeSetId: csId, qualifiedName: 'A::f' });
    const n2 = store.insertChangeNode({ requirementId: reqId, changeSetId: csId, qualifiedName: 'A::g' });
    store.insertChangeEdge({ requirementId: reqId, sourceChangeNodeId: n1, targetChangeNodeId: n2 });

    const detail = store.getRequirementById(reqId)!;
    expect(detail.requirement.title).toBe('R');
    expect(detail.changeSets).toHaveLength(1);
    expect(detail.changeNodes).toHaveLength(2);
    expect(detail.changeEdges).toHaveLength(1);
  });

  it('returns empty arrays when a requirement has no children', () => {
    const reqId = store.insertRequirement({ title: 'bare' });
    const detail = store.getRequirementById(reqId)!;
    expect(detail.changeSets).toEqual([]);
    expect(detail.changeNodes).toEqual([]);
    expect(detail.changeEdges).toEqual([]);
  });

  it('looks a requirement up by its external number', () => {
    const reqId = store.insertRequirement({ title: 'R', requirementsId: 'REQ-42' });
    expect(store.getRequirementByReqId('REQ-42')!.requirement.id).toBe(reqId);
    expect(store.getRequirementByReqId('REQ-nope')).toBeNull();
  });

  it('scopes child reads to their owner', () => {
    const r1 = store.insertRequirement({ title: 'R1' });
    const r2 = store.insertRequirement({ title: 'R2' });
    const cs1 = store.insertChangeSet({ requirementId: r1, service: 's1' });
    const cs2 = store.insertChangeSet({ requirementId: r2, service: 's2' });
    store.insertChangeNode({ requirementId: r1, changeSetId: cs1, qualifiedName: 'f1' });
    store.insertChangeNode({ requirementId: r2, changeSetId: cs2, qualifiedName: 'f2' });

    expect(store.getChangeSetsByRequirement(r1)).toHaveLength(1);
    expect(store.getChangeNodesByChangeSet(cs1)).toHaveLength(1);
    expect(store.getChangeNodesByRequirement(r2)).toHaveLength(1);
    expect(store.getChangeNodesByChangeSet(cs1)[0].qualifiedName).toBe('f1');
  });

  it('maps columns to camelCase', () => {
    const reqId = store.insertRequirement({ requirementsId: 'REQ-1', featurePath: 'a/b', featureName: 'search' });
    const r = store.getRequirementById(reqId)!.requirement;
    expect(r.requirementsId).toBe('REQ-1');
    expect(r.featurePath).toBe('a/b');
    expect(r.featureName).toBe('search');
  });

  it('lists requirements newest first with pagination', () => {
    const ids = [0, 1, 2].map((i) => store.insertRequirement({ title: `R${i}` }));
    const page = store.listRequirements(2, 0);
    expect(page).toHaveLength(2);
    expect(page[0].id).toBe(ids[2]); // newest first
    expect(store.listRequirements(2, 2)).toHaveLength(1);
  });
});

describe('updateRequirement', () => {
  it('changes only the fields passed and refreshes updatedAt', async () => {
    const id = store.insertRequirement({ title: 'old', featureName: 'keep' });
    const t0 = store.getRequirementById(id)!.requirement.updatedAt;
    await new Promise((r) => setTimeout(r, 2)); // ensure a later timestamp

    store.updateRequirement(id, { title: 'new' });
    const r = store.getRequirementById(id)!.requirement;
    expect(r.title).toBe('new');
    expect(r.featureName).toBe('keep'); // untouched
    expect(r.updatedAt).toBeGreaterThan(t0);
  });

  it('ignores unknown keys and tolerates an empty patch', () => {
    const id = store.insertRequirement({ title: 'x' });
    expect(() => store.updateRequirement(id, { bogus: 1 } as any)).not.toThrow();
    expect(() => store.updateRequirement(id, {})).not.toThrow();
    expect(store.getRequirementById(id)!.requirement.title).toBe('x');
  });
});

describe('deletes and cascade', () => {
  it('deleting a requirement removes all of its children', () => {
    const reqId = store.insertRequirement({ title: 'R' });
    const csId = store.insertChangeSet({ requirementId: reqId });
    const n1 = store.insertChangeNode({ requirementId: reqId, changeSetId: csId });
    const n2 = store.insertChangeNode({ requirementId: reqId, changeSetId: csId });
    store.insertChangeEdge({ requirementId: reqId, sourceChangeNodeId: n1, targetChangeNodeId: n2 });

    store.deleteRequirement(reqId);

    expect(store.getRequirementById(reqId)).toBeNull();
    expect(store.getChangeSetsByRequirement(reqId)).toEqual([]);
    expect(store.getChangeNodesByRequirement(reqId)).toEqual([]);
    expect(store.getChangeEdgesByRequirement(reqId)).toEqual([]);
  });

  it('deleting one requirement leaves another intact', () => {
    const r1 = store.insertRequirement({ title: 'R1' });
    const r2 = store.insertRequirement({ title: 'R2' });
    store.insertChangeSet({ requirementId: r2 });

    store.deleteRequirement(r1);

    expect(store.getRequirementById(r1)).toBeNull();
    expect(store.getRequirementById(r2)!.changeSets).toHaveLength(1);
  });

  it('deleting a change set cascades its nodes but spares sibling sets', () => {
    const reqId = store.insertRequirement({ title: 'R' });
    const cs1 = store.insertChangeSet({ requirementId: reqId, service: 's1' });
    const cs2 = store.insertChangeSet({ requirementId: reqId, service: 's2' });
    store.insertChangeNode({ requirementId: reqId, changeSetId: cs1 });
    store.insertChangeNode({ requirementId: reqId, changeSetId: cs2 });

    store.deleteChangeSet(cs1);

    expect(store.getChangeNodesByChangeSet(cs1)).toEqual([]);
    expect(store.getChangeNodesByChangeSet(cs2)).toHaveLength(1);
    expect(store.getChangeSetsByRequirement(reqId)).toHaveLength(1);
  });
});

describe('runInTransaction', () => {
  it('commits every write in the body', () => {
    const reqId = store.insertRequirement({ title: 'R' });
    store.runInTransaction(() => {
      const csId = store.insertChangeSet({ requirementId: reqId });
      store.insertChangeNode({ requirementId: reqId, changeSetId: csId });
    });
    expect(store.getChangeNodesByRequirement(reqId)).toHaveLength(1);
  });

  it('rolls back the whole body on error', () => {
    const reqId = store.insertRequirement({ title: 'R' });
    expect(() =>
      store.runInTransaction(() => {
        store.insertChangeSet({ requirementId: reqId });
        throw new Error('boom');
      })
    ).toThrow('boom');
    expect(store.getChangeSetsByRequirement(reqId)).toEqual([]);
  });
});

describe('searchRequirements (jieba FTS)', () => {
  it('finds a requirement by Chinese keyword and returns the full row', () => {
    const id = store.insertRequirement({
      requirementsId: 'REQ-1',
      title: '商品搜索高级筛选',
      originalText: '支持按品牌和价格区间对商品做搜索,并提供高级筛选条件',
      featureName: '商品搜索',
    });
    store.insertRequirement({ title: '订单导出', originalText: '导出订单明细为 Excel' });

    const hits = store.searchRequirements('商品搜索', 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].id).toBe(id);
    expect(hits[0].title).toBe('商品搜索高级筛选'); // whole row, not a snippet
  });

  it('matches English tokens too', () => {
    const id = store.insertRequirement({ title: 'Export orders', originalText: 'Export order details to Excel' });
    store.insertRequirement({ title: '购物车结算', originalText: '购物车商品合并结算' });
    const hits = store.searchRequirements('export', 3);
    expect(hits.map((h) => h.id)).toContain(id);
  });

  it('returns [] for an empty query', () => {
    store.insertRequirement({ title: 'x' });
    expect(store.searchRequirements('   ', 3)).toEqual([]);
  });
});

describe('saveRequirementBundle', () => {
  it('writes requirement, change sets, nodes and edges in one call', () => {
    const reqId = store.saveRequirementBundle({
      requirement: { requirementsId: 'REQ-1', title: '商品搜索' },
      services: [
        {
          changeSet: { requirementId: 0, service: 'product-service' },
          changeNodes: [
            { requirementId: 0, changeSetId: 0, service: 'product-service', qualifiedName: 'a', changeType: 'modify' },
            { requirementId: 0, changeSetId: 0, service: 'product-service', qualifiedName: 'b', changeType: 'add' },
          ],
          edges: [{ sourceIndex: 0, targetIndex: 1, relationType: 'calls' }],
        },
      ],
    });

    const detail = store.getRequirementById(reqId)!;
    expect(detail.requirement.requirementsId).toBe('REQ-1');
    expect(detail.changeSets).toHaveLength(1);
    expect(detail.changeNodes).toHaveLength(2);
    expect(detail.changeEdges).toHaveLength(1);
    // The edge's endpoints resolved to the two inserted nodes' real ids.
    const [a, b] = detail.changeNodes;
    expect(detail.changeEdges[0]).toMatchObject({
      sourceChangeNodeId: a.id, targetChangeNodeId: b.id, relationType: 'calls',
    });
  });

  it('rolls back everything if a service write fails', () => {
    expect(() => store.saveRequirementBundle({
      requirement: { requirementsId: 'REQ-2', title: 't' },
      services: [{
        changeSet: { requirementId: 0 },
        // changeSetId references are set by the writer; force a failure with a
        // bad edge index that maps to no node, then a throwing second service.
        changeNodes: [{ requirementId: 0, changeSetId: 0, qualifiedName: 'x', changeType: 'add' }],
        edges: [],
      }, null as any], // a null service throws mid-transaction
    })).toThrow();
    expect(store.getRequirementByReqId('REQ-2')).toBeNull(); // nothing persisted
  });

  it('reflects updates and deletes in search', () => {
    const id = store.insertRequirement({ title: '旧标题', originalText: '无关内容' });
    store.updateRequirement(id, { title: '优惠券发放', originalText: '新用户注册后发放优惠券' });
    expect(store.searchRequirements('优惠券', 3).map((h) => h.id)).toContain(id);

    store.deleteRequirement(id);
    expect(store.searchRequirements('优惠券', 3)).toEqual([]);
  });
});
