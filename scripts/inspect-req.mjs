import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('D:/code/.codegraph-req/requirement.db');

const total = db.prepare('SELECT COUNT(*) c FROM change_nodes').get();
console.log('total change_nodes:', total.c);

console.log('\n--- by service + kind + change_type ---');
for (const r of db.prepare(
  `SELECT service, kind, change_type, COUNT(*) c
   FROM change_nodes GROUP BY service, kind, change_type ORDER BY service, c DESC`
).all()) {
  console.log(`${r.service}  ${r.kind}  ${r.change_type}  x${r.c}`);
}

console.log('\n--- yxyun-business nodes (qualifiedName/kind/change_type) ---');
for (const r of db.prepare(
  `SELECT file_path, kind, qualified_name, change_type
   FROM change_nodes WHERE service='yxyun-business' ORDER BY file_path, qualified_name`
).all()) {
  console.log(`[${r.change_type}] ${r.kind}  ${r.qualified_name}  (${r.file_path})`);
}

db.close();
