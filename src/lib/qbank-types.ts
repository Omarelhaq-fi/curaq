// Bank types + taxonomy shapes.
//
// - license_exam (default, all legacy banks): old 4-level taxonomy
//     Objective > Organ System > Clinical Specialty > Sub-topic / Disease
// - module_academic: 3-level taxonomy
//     Objective > Subject (Physiology, Anatomy, ...) > Topic
// - module_clinical: 3-level taxonomy
//     Objective (e.g. Pediatrics) > System (e.g. General Peds) > Topic
// Stored taxonomyPath for modules has 3 segments; client pads to 4 for
// rendering (leaf topic duplicated). Modules can be audience-linked to
// majors/colleges (Linked audience only); unlinked modules are for everyone.
// License Exams are always for everyone.

export type BankType = "license_exam" | "module_academic" | "module_clinical";

export const BANK_TYPES: BankType[] = ["license_exam", "module_academic", "module_clinical"];

export function normalizeBankType(value: unknown): BankType {
  const v = String(value == null ? "" : value).trim();
  if (v === "module_academic" || v === "module_clinical" || v === "license_exam") return v;
  return "license_exam";
}

export function isModuleBankType(bankType: unknown): boolean {
  const t = normalizeBankType(bankType);
  return t === "module_academic" || t === "module_clinical";
}

export function bankTypeLabel(bankType: unknown): string {
  switch (normalizeBankType(bankType)) {
    case "module_academic":
      return "Module · Academic";
    case "module_clinical":
      return "Module · Clinical";
    default:
      return "License Exam";
  }
}

/** Middle level label for module banks ("Subject" academic, "System" clinical). */
export function moduleLevel2Label(bankType: unknown): string {
  return normalizeBankType(bankType) === "module_clinical" ? "System" : "Subject";
}

/** Minimum taxonomyPath depth stored for this bank type. */
export function taxonomyMinDepth(bankType: unknown): number {
  return isModuleBankType(bankType) ? 3 : 4;
}
