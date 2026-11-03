-- DPP traceability database (SQLite).
-- Runs in the browser through sql.js; the same file works with the sqlite3 CLI:
--   sqlite3 dpp.sqlite < db/schema.sql && cat db/seed/*.sql | sqlite3 dpp.sqlite

PRAGMA foreign_keys = ON;

-- Legal or reference documents that data categories are extracted from.
CREATE TABLE IF NOT EXISTS source (
  id        TEXT PRIMARY KEY,
  title     TEXT NOT NULL,
  celex     TEXT,
  url       TEXT,
  section   TEXT,
  retrieved TEXT
);

-- One hierarchy shown as a column in the app ("left" or "right").
CREATE TABLE IF NOT EXISTS tree (
  id       TEXT PRIMARY KEY,
  side     TEXT NOT NULL UNIQUE CHECK (side IN ('left', 'right')),
  title    TEXT NOT NULL,
  subtitle TEXT NOT NULL DEFAULT '',
  root_id  TEXT NOT NULL
);

-- Items of a tree. The root row (parent_id NULL) is hidden in the app.
CREATE TABLE IF NOT EXISTS node (
  tree_id     TEXT NOT NULL REFERENCES tree (id) ON DELETE CASCADE,
  id          TEXT NOT NULL,
  parent_id   TEXT,
  position    INTEGER NOT NULL DEFAULT 0,
  name        TEXT NOT NULL,
  meta        TEXT,
  description TEXT,
  source_id   TEXT REFERENCES source (id),
  source_ref  TEXT,
  PRIMARY KEY (tree_id, id),
  FOREIGN KEY (tree_id, parent_id) REFERENCES node (tree_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS node_parent ON node (tree_id, parent_id, position);

-- A traceability link from an item of one tree to an item of another.
CREATE TABLE IF NOT EXISTS mapping (
  id         TEXT PRIMARY KEY,
  from_tree  TEXT NOT NULL,
  from_id    TEXT NOT NULL,
  to_tree    TEXT NOT NULL,
  to_id      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (from_tree, from_id, to_tree, to_id),
  FOREIGN KEY (from_tree, from_id) REFERENCES node (tree_id, id) ON DELETE CASCADE,
  FOREIGN KEY (to_tree, to_id) REFERENCES node (tree_id, id) ON DELETE CASCADE
);
