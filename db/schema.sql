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

-- ---------- Regulatory chain ----------
-- legislation -> data requirement -> standard -> ontology -> data point

CREATE TABLE IF NOT EXISTS product_group (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  position    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS legislation (
  id             TEXT PRIMARY KEY,
  short          TEXT NOT NULL,
  title          TEXT NOT NULL,
  ref            TEXT NOT NULL,
  celex          TEXT NOT NULL,
  category       TEXT NOT NULL,
  -- Said in the app when the act's own text names no standard.
  standards_note TEXT,
  position       INTEGER NOT NULL DEFAULT 0
);

-- Why and from when a legislation applies to a product group.
CREATE TABLE IF NOT EXISTS legislation_scope (
  legislation_id   TEXT NOT NULL REFERENCES legislation (id) ON DELETE CASCADE,
  product_group_id TEXT NOT NULL REFERENCES product_group (id) ON DELETE CASCADE,
  note             TEXT NOT NULL,
  PRIMARY KEY (legislation_id, product_group_id)
);

CREATE TABLE IF NOT EXISTS standard (
  id            TEXT PRIMARY KEY,
  ref           TEXT NOT NULL UNIQUE,
  title         TEXT,
  body          TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('technical', 'test-guideline', 'guideline', 'convention', 'scheme')),
  position      INTEGER NOT NULL DEFAULT 0
);

-- Which legislation references which standard.
CREATE TABLE IF NOT EXISTS legislation_standard (
  legislation_id TEXT NOT NULL REFERENCES legislation (id) ON DELETE CASCADE,
  standard_id    TEXT NOT NULL REFERENCES standard (id) ON DELETE CASCADE,
  PRIMARY KEY (legislation_id, standard_id)
);

-- Where the legislation references it, in the act's own words.
CREATE TABLE IF NOT EXISTS standard_citation (
  legislation_id TEXT NOT NULL,
  standard_id    TEXT NOT NULL,
  provision      TEXT NOT NULL,
  force          TEXT NOT NULL CHECK (force IN ('operative', 'recital')),
  excerpt        TEXT NOT NULL,
  cited_as       TEXT,
  source_celex   TEXT NOT NULL,
  position       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (legislation_id, standard_id, provision),
  FOREIGN KEY (legislation_id, standard_id) REFERENCES legislation_standard (legislation_id, standard_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS data_requirement (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  theme    TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);

-- A standard behind a data requirement, on the path through one legislation.
CREATE TABLE IF NOT EXISTS standard_requirement (
  legislation_id      TEXT NOT NULL,
  standard_id         TEXT NOT NULL,
  data_requirement_id TEXT NOT NULL REFERENCES data_requirement (id) ON DELETE CASCADE,
  basis               TEXT NOT NULL CHECK (basis IN ('stated', 'inferred')),
  note                TEXT NOT NULL,
  -- JSON array of the standard_citation provisions this rests on; all of them when NULL.
  provisions          TEXT,
  PRIMARY KEY (legislation_id, standard_id, data_requirement_id),
  FOREIGN KEY (legislation_id, standard_id) REFERENCES legislation_standard (legislation_id, standard_id) ON DELETE CASCADE
);

-- A standard no act names, whose own scope targets a data requirement, per product group.
CREATE TABLE IF NOT EXISTS standard_target (
  standard_id         TEXT NOT NULL REFERENCES standard (id) ON DELETE CASCADE,
  data_requirement_id TEXT NOT NULL REFERENCES data_requirement (id) ON DELETE CASCADE,
  product_group_id    TEXT NOT NULL REFERENCES product_group (id) ON DELETE CASCADE,
  note                TEXT NOT NULL,
  source_url          TEXT NOT NULL,
  PRIMARY KEY (standard_id, data_requirement_id, product_group_id)
);

-- The legislation sets the data requirement here: its legal basis.
CREATE TABLE IF NOT EXISTS requirement_provision (
  id                  INTEGER PRIMARY KEY,
  data_requirement_id TEXT NOT NULL REFERENCES data_requirement (id) ON DELETE CASCADE,
  legislation_id      TEXT NOT NULL REFERENCES legislation (id) ON DELETE CASCADE,
  ref                 TEXT NOT NULL,
  text                TEXT NOT NULL,
  -- JSON array of excerpts copied word for word from the act.
  quotes              TEXT,
  -- CELEX number of the act quoted, when not the legislation itself.
  source_celex        TEXT
);

CREATE INDEX IF NOT EXISTS requirement_provision_path ON requirement_provision (legislation_id, data_requirement_id);

-- The product groups a provision binds.
CREATE TABLE IF NOT EXISTS provision_group (
  provision_id     INTEGER NOT NULL REFERENCES requirement_provision (id) ON DELETE CASCADE,
  product_group_id TEXT NOT NULL REFERENCES product_group (id) ON DELETE CASCADE,
  PRIMARY KEY (provision_id, product_group_id)
);

CREATE TABLE IF NOT EXISTS ontology (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  uri         TEXT,
  description TEXT,
  position    INTEGER NOT NULL DEFAULT 0,
  license     TEXT,
  license_url TEXT,
  -- When the definitions of its terms were copied.
  retrieved   TEXT
);

-- A term of an ontology, with its definition copied word for word.
CREATE TABLE IF NOT EXISTS ontology_term (
  id          TEXT PRIMARY KEY,
  ontology_id TEXT NOT NULL REFERENCES ontology (id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  uri         TEXT NOT NULL UNIQUE,
  definition  TEXT NOT NULL,
  position    INTEGER NOT NULL DEFAULT 0
);

-- A term that defines a data requirement; `match` says how closely, after SKOS mapping properties.
CREATE TABLE IF NOT EXISTS data_requirement_term (
  data_requirement_id TEXT NOT NULL REFERENCES data_requirement (id) ON DELETE CASCADE,
  term_id             TEXT NOT NULL REFERENCES ontology_term (id) ON DELETE CASCADE,
  match               TEXT NOT NULL CHECK (match IN ('exact', 'close', 'broad', 'narrow')),
  note                TEXT,
  PRIMARY KEY (data_requirement_id, term_id)
);

CREATE TABLE IF NOT EXISTS data_point (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  position    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ontology_data_point (
  ontology_id   TEXT NOT NULL REFERENCES ontology (id) ON DELETE CASCADE,
  data_point_id TEXT NOT NULL REFERENCES data_point (id) ON DELETE CASCADE,
  PRIMARY KEY (ontology_id, data_point_id)
);
