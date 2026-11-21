import { CAPABILITY_TEXT, type Capability } from "../model/capabilities";

/** States how far the current screen can be relied on, and which plan functions it relates to. */
export function CapabilityBadge({ capability }: { capability: Capability }) {
  const text = CAPABILITY_TEXT[capability.label];
  const functions = capability.functions.length
    ? capability.functions
        .map((f) => (capability.functionLabels?.[f] ? `${f} (${CAPABILITY_TEXT[capability.functionLabels[f]]})` : f))
        .join(", ")
    : "outside the plan";
  const extension = capability.extends?.length ? ` Extension beyond: ${capability.extends.join(", ")}.` : "";
  return (
    <p
      className="capability"
      data-label={capability.label}
      data-testid="capability-badge"
      title={`${capability.basis} Plan functions: ${functions}.${extension}`}
    >
      <span className="capability-label">{text}</span>
      <span className="capability-detail">
        <span className="sr-only">{capability.name}: </span>
        {capability.basis}
      </span>
    </p>
  );
}
