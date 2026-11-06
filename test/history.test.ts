import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { addEntry, HistoryStore, MAX_SQL, searchEntries } from '../src/core/history';

const dir = mkdtempSync(path.join(tmpdir(), 'bindb-hist-'));
after(() => rmSync(dir, { recursive: true, force: true }));

describe('query history', () => {
  it('newest first, folds repeats (ignoring whitespace), caps the size, truncates huge SQL', () => {
    let l = addEntry([], { sql: 'select 1', at: 1 });
    l = addEntry(l, { sql: 'select  1\n', at: 2, ms: 5 });
    assert.deepEqual(l, [{ sql: 'select  1\n', at: 2, ms: 5, count: 2 }]);
    l = addEntry(l, { sql: 'select 2', at: 3 }, 2);
    l = addEntry(l, { sql: 'select 3', at: 4 }, 2);
    assert.deepEqual(l.map((e) => e.sql), ['select 3', 'select 2']);
    const huge = addEntry([], { sql: 'x'.repeat(MAX_SQL + 10), at: 1 })[0].sql;
    assert.ok(huge.length < MAX_SQL + 100 && huge.includes('truncated'));
  });

  it('searches by all words, case-insensitive', () => {
    const l = [{ sql: 'SELECT * FROM orders', at: 1 }, { sql: 'select * from users', at: 2 }];
    assert.deepEqual(searchEntries(l, 'from ORDERS').map((e) => e.at), [1]);
    assert.equal(searchEntries(l, '  ').length, 2);
  });

  it('persists, serialises concurrent writes, removes per connection', async () => {
    const file = path.join(dir, 'a', 'history.json');
    const s = new HistoryStore(file);
    await Promise.all(Array.from({ length: 20 }, (_, i) => s.add('c1', { sql: `select ${i}`, at: i })));
    await s.add('c2', { sql: 'x', at: 1 });
    const again = new HistoryStore(file);
    assert.equal((await again.list('c1')).length, 20, 'no write was lost');
    await again.remove('c1');
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8'))), ['c2']);
  });

  it('keeps a corrupt file aside and starts empty', async () => {
    const file = path.join(dir, 'bad.json');
    writeFileSync(file, '{not json');
    const s = new HistoryStore(file);
    assert.deepEqual(await s.list('c'), []);
    assert.ok(existsSync(`${file}.corrupt`));
    await s.add('c', { sql: 'ok', at: 1 });
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).c[0].sql, 'ok');
  });
});
