/**
 * Confidentiality classes for content the app logs, stores or exports (LEAN-DEF-12; criterion C0-07).
 * Content without a class is treated as restricted. Later cycles route every log line and output field
 * through `classify` (C5-03, C6-02), so nothing unclassified is ever handled as public by accident.
 */
export const CLASSIFICATIONS = ["public", "internal", "restricted"] as const;

export type Classification = (typeof CLASSIFICATIONS)[number];

export const DEFAULT_CLASSIFICATION: Classification = "restricted";

/** The class to apply: the stated one when it is valid, otherwise the restricted default. */
export function classify(stated?: string | null): Classification {
  return CLASSIFICATIONS.includes(stated as Classification) ? (stated as Classification) : DEFAULT_CLASSIFICATION;
}

/** Whether content of this class may go to a recipient cleared for `clearance`. */
export function mayDisclose(content: Classification, clearance: Classification): boolean {
  return CLASSIFICATIONS.indexOf(content) <= CLASSIFICATIONS.indexOf(clearance);
}
