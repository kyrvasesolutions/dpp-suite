/** Characterisation of importProject in src/model/project.ts (portable project file, FUNC-043 at F1). */
import { describe, expect, it } from "vitest";
import { importProject, type Project } from "../../src/model/project";
import type { TreeData } from "../../src/model/types";

const tree = (title: string, ids: string[]): TreeData => ({
  title,
  subtitle: "",
  rootId: "root",
  nodes: {
    root: { id: "root", name: title, children: ids },
    ...Object.fromEntries(ids.map((id) => [id, { id, name: id }])),
  },
});

const current: Project = {
  left: tree("Product", ["p1", "p2"]),
  right: tree("Data categories", ["d1"]),
  mappings: [{ id: "m1", from: "p1", to: "d1" }],
  sources: {},
};

describe("importProject", () => {
  it("rejects text that is not JSON", () => {
    expect(importProject("{", current)).toEqual({ ok: false, error: "The file is not valid JSON." });
  });

  it("rejects a file with no left, right or mappings", () => {
    expect(importProject("{}", current)).toEqual({ ok: false, error: "The file has no left, right or mappings field." });
  });

  it("names the path of a schema problem", () => {
    const bad = { left: { ...tree("Product", ["p1"]), rootId: "missing" } };
    const result = importProject(JSON.stringify(bad), current);
    expect(result).toEqual({ ok: false, error: 'left: rootId "missing" is not in nodes' });
  });

  it("reports an unknown child", () => {
    const t = tree("Product", ["p1"]);
    t.nodes.p1.children = ["ghost"];
    const result = importProject(JSON.stringify({ left: t }), current);
    expect(result).toEqual({ ok: false, error: 'left: "p1" lists unknown child "ghost"' });
  });

  it("drops mappings that point at missing items and says how many", () => {
    const mappings = [
      { id: "a", from: "p1", to: "d1" },
      { id: "b", from: "p9", to: "d1" },
    ];
    const result = importProject(JSON.stringify({ mappings }), current);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.mappings).toEqual([mappings[0]]);
    expect(result.summary).toBe("Imported 1 mapping; skipped 1 pointing at unknown items.");
  });

  it("clears mappings when a tree is replaced without new mappings", () => {
    const result = importProject(JSON.stringify({ right: tree("Other", ["x"]) }), current);
    expect(result.ok && result.project.mappings).toEqual([]);
  });
});
