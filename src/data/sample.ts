import type { Mapping, TreeData, TreeNode } from "../model/types";

// Sample data only: a simplified battery bill of materials on the left and a
// subset of battery-passport data points on the right.

const n = (id: string, name: string, meta?: string, children?: string[]): TreeNode => ({
  id,
  name,
  meta,
  children,
});

export const productTree: TreeData = {
  title: "Product structure",
  subtitle: "E-bike battery pack BP-48V",
  rootId: "root",
  nodes: Object.fromEntries(
    [
      n("root", "root", undefined, ["pack", "docs"]),
      n("pack", "Battery pack BP-48V", "PN 48-1100", ["module", "bms", "housing"]),
      n("module", "Cell module", "PN 48-2010", ["cells", "busbar"]),
      n("cells", "Li-ion cells 21700", "52 pcs", ["cathode", "anode", "electrolyte", "separator"]),
      n("cathode", "NMC 811 cathode", "Supplier A"),
      n("anode", "Graphite anode", "Supplier B"),
      n("electrolyte", "LiPF6 electrolyte", "Supplier C"),
      n("separator", "PE separator film"),
      n("busbar", "Nickel-plated copper busbar"),
      n("bms", "Battery management system", "PN 48-3100", ["pcb", "firmware"]),
      n("pcb", "PCB assembly"),
      n("firmware", "BMS firmware", "v3.2"),
      n("housing", "Housing", "PN 48-4000", ["case", "gasket", "screws"]),
      n("case", "Aluminium case", "6061-T6"),
      n("gasket", "EPDM gasket"),
      n("screws", "Torx screws M4", "24 pcs"),
      n("docs", "Supplier documents", undefined, ["coa", "lca", "un383", "manual"]),
      n("coa", "Cobalt origin certificate", "PDF"),
      n("lca", "Life-cycle assessment report", "PDF"),
      n("un383", "UN 38.3 test report", "PDF"),
      n("manual", "Service manual", "PDF"),
    ].map((x) => [x.id, x]),
  ),
};

export const passportTree: TreeData = {
  title: "Passport requirements",
  subtitle: "Battery passport data points (sample)",
  rootId: "root",
  nodes: Object.fromEntries(
    [
      n("root", "root", undefined, ["general", "materials", "carbon", "recycled", "performance", "eol"]),
      n("general", "General information", undefined, ["mfr", "model", "date"]),
      n("mfr", "Manufacturer identification"),
      n("model", "Battery model identifier"),
      n("date", "Date of manufacture"),
      n("materials", "Materials & composition", undefined, ["chem", "crm", "hazard"]),
      n("chem", "Battery chemistry"),
      n("crm", "Critical raw materials"),
      n("hazard", "Hazardous substances"),
      n("carbon", "Carbon footprint", undefined, ["cf-total", "cf-stage"]),
      n("cf-total", "Total carbon footprint", "kg CO2e/kWh"),
      n("cf-stage", "Footprint per life-cycle stage"),
      n("recycled", "Recycled content", undefined, ["rc-co", "rc-li", "rc-ni"]),
      n("rc-co", "Recycled cobalt share", "%"),
      n("rc-li", "Recycled lithium share", "%"),
      n("rc-ni", "Recycled nickel share", "%"),
      n("performance", "Performance & durability", undefined, ["capacity", "soh", "lifetime"]),
      n("capacity", "Rated capacity", "Ah"),
      n("soh", "State of health"),
      n("lifetime", "Expected lifetime", "cycles"),
      n("eol", "Dismantling & safety", undefined, ["dismantle", "safety"]),
      n("dismantle", "Dismantling information"),
      n("safety", "Safety measures"),
    ].map((x) => [x.id, x]),
  ),
};

export const sampleMappings: Mapping[] = [
  { id: "m1", from: "cathode", to: "chem" },
  { id: "m2", from: "cathode", to: "crm" },
  { id: "m3", from: "coa", to: "rc-co" },
  { id: "m4", from: "lca", to: "cf-total" },
  { id: "m5", from: "lca", to: "cf-stage" },
  { id: "m6", from: "firmware", to: "soh" },
  { id: "m7", from: "un383", to: "safety" },
  { id: "m8", from: "electrolyte", to: "hazard" },
  { id: "m9", from: "manual", to: "dismantle" },
  { id: "m10", from: "pack", to: "model" },
];
