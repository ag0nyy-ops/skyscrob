/**
 * Minimal Cloudflare D1 implementation over Node's built-in SQLite, enough for integration
 * tests to run the real SQL in migrations/ and src/ without Miniflare.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

type Val = SQLInputValue;
const norm = (v: unknown): Val =>
  v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : (v as Val);

class Stmt {
  constructor(
    readonly db: DatabaseSync,
    readonly sql: string,
    readonly params: Val[] = [],
  ) {}
  bind(...values: unknown[]) {
    return new Stmt(this.db, this.sql, values.map(norm));
  }
  async first<T>(col?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.params) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (col ? row[col] : { ...row }) as T;
  }
  async all<T>() {
    return {
      results: this.db
        .prepare(this.sql)
        .all(...this.params)
        .map((r) => ({ ...r })) as T[],
      success: true,
      meta: {},
    };
  }
  runSync() {
    const st = this.db.prepare(this.sql);
    if (/\bRETURNING\b/i.test(this.sql)) {
      const rows = st.all(...this.params);
      return { success: true, results: rows, meta: { changes: rows.length, last_row_id: 0 } };
    }
    const r = st.run(...this.params);
    return {
      success: true,
      results: [],
      meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) },
    };
  }
  async run() {
    return this.runSync();
  }
}

export class TestD1 {
  readonly db = new DatabaseSync(':memory:');
  /** Set to make the next batch() throw after executing (simulates a crash). */
  failNextBatch = false;

  constructor() {
    this.db.exec('PRAGMA foreign_keys = ON');
    const dir = join(import.meta.dirname, '..', '..', 'migrations');
    for (const f of readdirSync(dir).sort()) this.db.exec(readFileSync(join(dir, f), 'utf8'));
  }
  prepare(sql: string) {
    return new Stmt(this.db, sql);
  }
  async batch(stmts: Stmt[]) {
    if (this.failNextBatch) {
      this.failNextBatch = false;
      throw new Error('simulated D1 failure');
    }
    this.db.exec('BEGIN');
    try {
      const out = stmts.map((s) => s.runSync());
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  async exec(sql: string) {
    this.db.exec(sql);
    return { count: 1, duration: 0 };
  }
  rows<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...params.map(norm)) as T[];
  }
}
