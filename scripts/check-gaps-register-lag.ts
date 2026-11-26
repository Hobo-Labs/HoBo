/**
 * GAPS.md register-lag guard.
 *
 * The intent-alignment register (`GAPS.md`) marks a finding 🧯 ("remediation documented,
 * not applied") until its remediation lands on main, then flips it to ✔. Two findings
 * (GAP-026, DRIFT-009) sat at 🧯 for weeks *after* their content had already landed — the
 * register lagged reality, and nobody noticed because nothing surfaced it. This check lists
 * every register row still at 🧯 so it cannot rot silently: for each, re-run its REM
 * "Acceptance" grep and flip to ✔ if it passes, or confirm it is genuinely still open.
 *
 * Advisory by default (exit 0) — 🧯 is a legitimate intermediate state for a genuinely-open
 * remediation. Pass `--strict` to fail when any 🧯 row exists (useful once a review
 * iteration has closed and no remediation should still be pending).
 *
 * Reference: the traceability gate at docs/design/traceability.md.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const gapsPath = path.join(repoRoot, "GAPS.md");

const strict = process.argv.includes("--strict");
const lines = readFileSync(gapsPath, "utf8").split("\n");

// A register row is a table row (`| ... |`) whose first id-shaped cell is GAP-NNN / DRIFT-NNN
// and whose status cell holds 🧯. The legend line and prose that merely mention 🧯 are not
// table rows and are ignored.
const stale: { id: string; line: number }[] = [];
for (const [i, line] of lines.entries()) {
	if (!line.startsWith("|") || !line.includes("🧯")) continue;
	const cells = line.split("|").map((c) => c.trim());
	const id = cells.find((c) => /^(GAP|DRIFT)-\d+$/u.test(c));
	if (id) stale.push({ id, line: i + 1 });
}

if (stale.length === 0) {
	console.log(
		"GAPS register-lag: OK — no 🧯 rows (register reconciled with main).",
	);
	process.exit(0);
}

console.log(
	`GAPS register-lag: ${stale.length} finding(s) at 🧯 (remediation documented, not verified applied):`,
);
for (const s of stale) {
	console.log(
		`  - ${s.id} (GAPS.md:${s.line}) — re-run its REM "Acceptance" grep; flip 🧯 → ✔ if it passes, else confirm it is still open.`,
	);
}
console.log(
	"A 🧯 row must not rest: either the remediation has landed (flip to ✔) or it is genuinely open (tracked in Linear).",
);
process.exit(strict ? 1 : 0);
