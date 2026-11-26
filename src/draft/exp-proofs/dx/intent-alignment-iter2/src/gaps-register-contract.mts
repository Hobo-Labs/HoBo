import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

export const ITER2_EXPECTED = {
  iterationLabel: "Iteration 2",
  lenses: "completeness critic + informed re-sweep + evidence audit",
  minNewGapId: 18,
  maxNewGapId: 28,
  minNewDriftId: 9,
  maxNewDriftId: 10,
  minNewRemId: 26,
  maxNewRemId: 38,
} as const;

export function validateIteration2Register(
  gapsMarkdown: string,
  expected: typeof ITER2_EXPECTED = ITER2_EXPECTED,
): ValidationResult {
  const errors: string[] = [];

  if (!gapsMarkdown.includes(`### ${expected.iterationLabel}`)) {
    errors.push(`missing iteration log heading for ${expected.iterationLabel}`);
  }
  if (!gapsMarkdown.includes(expected.lenses)) {
    errors.push(`iteration log missing lenses: ${expected.lenses}`);
  }

  for (let id = expected.minNewGapId; id <= expected.maxNewGapId; id += 1) {
    const token = `GAP-${String(id).padStart(3, "0")}`;
    if (!gapsMarkdown.includes(`| ${token} |`)) {
      errors.push(`gap register missing row ${token}`);
    }
  }

  for (let id = expected.minNewDriftId; id <= expected.maxNewDriftId; id += 1) {
    const token = `DRIFT-${String(id).padStart(3, "0")}`;
    if (!gapsMarkdown.includes(`| ${token} |`)) {
      errors.push(`drift register missing row ${token}`);
    }
  }

  for (let id = expected.minNewRemId; id <= expected.maxNewRemId; id += 1) {
    const token = `REM-${String(id).padStart(3, "0")}`;
    if (!gapsMarkdown.includes(`### ${token}`)) {
      errors.push(`remediations missing section ${token}`);
    }
  }

  if (!/Stop rule:\*\* open|Stop rule: open/.test(gapsMarkdown)) {
    errors.push("verdict must record stop rule open when new findings confirmed");
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export function validateGapsFileFromRepo(startDir = process.cwd()): ValidationResult {
  let dir = startDir;
  let gapsPath = resolve(dir, "GAPS.md");
  while (!existsSync(gapsPath)) {
    const parent = resolve(dir, "..");
    if (parent === dir) {
      throw new Error("GAPS.md not found from startDir");
    }
    dir = parent;
    gapsPath = resolve(dir, "GAPS.md");
  }
  const content = readFileSync(gapsPath, "utf8");
  return validateIteration2Register(content);
}
