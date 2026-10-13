/**
 * Minimal async database interface shared by the Worker (Cloudflare D1) and
 * the Node test/CLI runner (node:sqlite):
 *
 *   db.prepare(sql).get(...params)  -> Promise<row | undefined>
 *   db.prepare(sql).all(...params)  -> Promise<row[]>
 *   db.prepare(sql).run(...params)  -> Promise<{ changes, lastInsertRowid }>
 *   db.batch([stmt, ...])           -> Promise<void>   (atomic on D1)
 *
 * `stmt.bind(...params)` returns a statement usable with db.batch().
 */

export function wrapD1(d1) {
  const make = (sql, params = []) => ({
    sql,
    params,
    bind: (...p) => make(sql, p),
    _d1: () => d1.prepare(sql).bind(...params),
    async get(...p) {
      const row = await d1.prepare(sql).bind(...(p.length ? p : params)).first();
      return row ?? undefined;
    },
    async all(...p) {
      const { results } = await d1.prepare(sql).bind(...(p.length ? p : params)).all();
      return results;
    },
    async run(...p) {
      const r = await d1.prepare(sql).bind(...(p.length ? p : params)).run();
      return { changes: r.meta?.changes ?? 0, lastInsertRowid: r.meta?.last_row_id };
    },
  });

  return {
    prepare: (sql) => make(sql),
    async batch(statements) {
      if (!statements.length) return;
      await d1.batch(statements.map((s) => s._d1()));
    },
  };
}

// Cloudflare D1 allows at most 100 bound parameters per statement; enforce it here so tests catch queries that would fail there.
const D1_MAX_PARAMS = 100;
function bound(passed, own) {
  const list = passed.length ? passed : own;
  if (list.length > D1_MAX_PARAMS) throw new Error(`D1 allows at most ${D1_MAX_PARAMS} bound parameters per statement (got ${list.length})`);
  return list;
}

export function wrapSqlite(sqlite) {
  const make = (sql, params = []) => ({
    sql,
    params,
    bind: (...p) => make(sql, p),
    async get(...p) {
      return sqlite.prepare(sql).get(...bound(p, params));
    },
    async all(...p) {
      return sqlite.prepare(sql).all(...bound(p, params));
    },
    async run(...p) {
      const r = sqlite.prepare(sql).run(...bound(p, params));
      return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    },
  });

  return {
    raw: sqlite,
    prepare: (sql) => make(sql),
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        for (const s of statements) await s.run();
        sqlite.exec('COMMIT');
      } catch (err) {
        sqlite.exec('ROLLBACK');
        throw err;
      }
    },
  };
}
