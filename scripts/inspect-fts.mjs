import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('D:/code/.codegraph-req/requirement.db');
const cut = (s, n = 300) => (s && s.length > n ? s.slice(0, n) + ' …' : s);

console.log('=== requirements_fts rows (segmented text) ===');
for (const r of db.prepare('SELECT rowid, title, feature_name, feature_path, original_text FROM requirements_fts').all()) {
  console.log(`rowid ${r.rowid}`);
  console.log(`  title        : ${r.title}`);
  console.log(`  feature_name : ${r.feature_name}`);
  console.log(`  feature_path : ${r.feature_path}`);
  console.log(`  original_text: ${cut(r.original_text)}`);
}

db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS temp.fts_vocab USING fts5vocab(main, 'requirements_fts', 'row')");
const total = db.prepare('SELECT COUNT(*) c FROM temp.fts_vocab').get();
console.log(`\n=== inverted index: ${total.c} distinct terms (top 40 by occurrences) ===`);
console.log('term\tdocs\toccurrences');
for (const r of db.prepare('SELECT term, doc, cnt FROM temp.fts_vocab ORDER BY cnt DESC, term LIMIT 40').all()) {
  console.log(`${r.term}\t${r.doc}\t${r.cnt}`);
}

db.close();
