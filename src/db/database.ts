import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import schemaSql from "../../db/schema.sql?raw";
import type { Project } from "../model/project";
import type { Mapping, Side, SourceDoc, TreeData, TreeNode } from "../model/types";
import { idbGet, idbSet } from "./idb";

// Seed files run in name order: product sample, ESPR Annex I, sample mappings.
const seeds = Object.entries(
  import.meta.glob<string>("../../db/seed/*.sql", { query: "?raw", import: "default", eager: true }),
)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([, sql]) => sql);

const STORE_KEY = "dpp-trace.sqlite";
const FALLBACK_TREE_ID: Record<Side, string> = { left: "left", right: "right" };

let sqlPromise: Promise<SqlJsStatic> | null = null;
const sqlJs = () => (sqlPromise ??= initSqlJs({ locateFile: () => wasmUrl }));

function seeded(SQL: SqlJsStatic): Database {
  const db = new SQL.Database();
  db.exec(schemaSql);
  for (const sql of seeds) db.exec(sql);
  return db;
}

/** Opens the database saved in this browser, or creates one from the seed files. */
export async function openDatabase(): Promise<Database> {
  const SQL = await sqlJs();
  try {
    const bytes = await idbGet(STORE_KEY);
    if (bytes) {
      const db = new SQL.Database(bytes);
      db.exec("PRAGMA foreign_keys = ON;");
      return db;
    }
  } catch {
    // Unreadable or blocked storage: start from the seed.
  }
  return seeded(SQL);
}

export async function resetDatabase(): Promise<Database> {
  return seeded(await sqlJs());
}

/** Opens an uploaded .sqlite file; throws if it doesn't have this app's tables. */
export async function databaseFromFile(bytes: Uint8Array): Promise<Database> {
  const SQL = await sqlJs();
  const db = new SQL.Database(bytes);
  let tables: Set<string | number | null>;
  try {
    tables = new Set(rows(db, "SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name));
  } catch {
    db.close();
    throw new Error("This file is not a SQLite database.");
  }
  for (const t of ["tree", "node", "mapping", "source"]) {
    if (!tables.has(t)) {
      db.close();
      throw new Error(`Not a DPP traceability database (missing table "${t}").`);
    }
  }
  return db;
}

export async function persist(db: Database) {
  await idbSet(STORE_KEY, db.export());
}

type Row = Record<string, string | number | null>;

function rows(db: Database, sql: string, params: (string | number | null)[] = []): Row[] {
  const stmt = db.prepare(sql, params);
  const out: Row[] = [];
  while (stmt.step()) out.push(stmt.getAsObject() as Row);
  stmt.free();
  return out;
}

const opt = (v: string | number | null) => (v === null ? undefined : String(v));

export function readProject(db: Database): Project {
  const readTree = (side: Side): TreeData => {
    const [tree] = rows(db, "SELECT id, title, subtitle, root_id FROM tree WHERE side = ?", [side]);
    if (!tree) throw new Error(`The database has no ${side} tree.`);
    const nodes: Record<string, TreeNode> = {};
    const list = rows(
      db,
      `SELECT id, parent_id, name, meta, description, source_id, source_ref
         FROM node WHERE tree_id = ? ORDER BY parent_id, position`,
      [String(tree.id)],
    );
    for (const r of list) {
      nodes[String(r.id)] = {
        id: String(r.id),
        name: String(r.name),
        meta: opt(r.meta),
        description: opt(r.description),
        sourceId: opt(r.source_id),
        sourceRef: opt(r.source_ref),
      };
    }
    for (const r of list) {
      if (r.parent_id === null) continue;
      const parent = nodes[String(r.parent_id)];
      if (parent) (parent.children ??= []).push(String(r.id));
    }
    return {
      id: String(tree.id),
      title: String(tree.title),
      subtitle: String(tree.subtitle),
      rootId: String(tree.root_id),
      nodes,
    };
  };

  const left = readTree("left");
  const right = readTree("right");
  const mappings: Mapping[] = rows(
    db,
    "SELECT id, from_id, to_id FROM mapping WHERE from_tree = ? AND to_tree = ? ORDER BY created_at, id",
    [left.id!, right.id!],
  ).map((r) => ({ id: String(r.id), from: String(r.from_id), to: String(r.to_id) }));
  const sources: Record<string, SourceDoc> = {};
  for (const r of rows(db, "SELECT id, title, url FROM source")) {
    sources[String(r.id)] = { title: String(r.title), url: opt(r.url) };
  }
  return { left, right, mappings, sources };
}

/** Replaces the trees and mappings in the database with the project's. Sources are upserted. */
export function writeProject(db: Database, project: Project) {
  const ids = {
    left: project.left.id ?? FALLBACK_TREE_ID.left,
    right: project.right.id ?? FALLBACK_TREE_ID.right,
  };
  db.exec("BEGIN; PRAGMA defer_foreign_keys = ON;");
  try {
    db.exec("DELETE FROM mapping; DELETE FROM node; DELETE FROM tree;");
    const source = db.prepare("INSERT OR REPLACE INTO source (id, title, url) VALUES (?, ?, ?)");
    for (const [id, s] of Object.entries(project.sources)) source.run([id, s.title, s.url ?? null]);
    source.free();

    const tree = db.prepare("INSERT INTO tree (id, side, title, subtitle, root_id) VALUES (?, ?, ?, ?, ?)");
    const node = db.prepare(
      `INSERT INTO node (tree_id, id, parent_id, position, name, meta, description, source_id, source_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const side of ["left", "right"] as const) {
      const data = project[side];
      tree.run([ids[side], side, data.title, data.subtitle, data.rootId]);
      const parents: Record<string, { parent: string; position: number }> = {};
      for (const n of Object.values(data.nodes)) {
        n.children?.forEach((child, position) => (parents[child] = { parent: n.id, position }));
      }
      for (const n of Object.values(data.nodes)) {
        const p = parents[n.id];
        const sourceId = n.sourceId && project.sources[n.sourceId] ? n.sourceId : null;
        node.run([
          ids[side],
          n.id,
          p?.parent ?? null,
          p?.position ?? 0,
          n.name,
          n.meta ?? null,
          n.description ?? null,
          sourceId,
          n.sourceRef ?? null,
        ]);
      }
    }
    tree.free();
    node.free();

    const mapping = db.prepare(
      "INSERT OR IGNORE INTO mapping (id, from_tree, from_id, to_tree, to_id) VALUES (?, ?, ?, ?, ?)",
    );
    for (const m of project.mappings) mapping.run([m.id, ids.left, m.from, ids.right, m.to]);
    mapping.free();
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}
