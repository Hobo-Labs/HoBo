/**
 * Promoted-proof drift guard.
 *
 * packages/* are promoted from src/draft proofs; once promoted, the package
 * copy is canonical and the proof is FROZEN — further edits belong in the
 * package (AGENTS.md "Draft-proof promotion policy"). Before this guard the
 * two copies silently diverged (the deterministic-replay-engine proof and
 * packages/runtime/src/replay drifted apart with nothing noticing —
 * GAPS.md IMPL-005).
 *
 * scripts/promotions.json is the ledger: each entry pins a frozen proof's
 * files to sha256 digests and names the package that superseded it. This
 * check fails when a frozen file changed or disappeared. Refresh digests
 * deliberately with `--update` when a proof is re-frozen.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const ledgerPath = path.join(repoRoot, "scripts", "promotions.json");
const update = process.argv.includes("--update");

interface PromotionEntry {
	proof: string;
	promotedTo: string;
	status: "frozen" | "reference";
	note?: string;
	files?: string[];
	digests?: Record<string, string>;
}

interface Ledger {
	schema: string;
	promotions: PromotionEntry[];
}

function digest(filePath: string): string {
	const bytes = readFileSync(filePath);
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function listFiles(root: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(root)) {
		// Test/build caches (e.g. vitest .vite results) are run byproducts,
		// not proof edits — never treat them as drift.
		if (entry === "node_modules" || entry === "dist") continue;
		const full = path.join(root, entry);
		if (statSync(full).isDirectory()) {
			out.push(...listFiles(full).map((f) => path.join(entry, f)));
		} else {
			out.push(entry);
		}
	}
	return out.sort();
}

function entryFiles(entry: PromotionEntry, proofRoot: string): string[] {
	if (entry.files && entry.files.length > 0) return [...entry.files].sort();
	return listFiles(proofRoot);
}

// SAFETY: assertion to `arse(readFileSync(ledgerPath, "utf8")) as Ledger; cons` is required at this boundary.
const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as Ledger;
const problems: string[] = [];

for (const entry of ledger.promotions) {
	if (entry.status !== "frozen") continue;
	const proofRoot = path.join(repoRoot, entry.proof);
	let files: string[];
	try {
		files = entryFiles(entry, proofRoot);
	} catch {
		problems.push(`${entry.proof}: frozen proof directory is missing`);
		continue;
	}

	if (update) {
		entry.digests = Object.fromEntries(
			files.map((file) => [file, digest(path.join(proofRoot, file))]),
		);
		continue;
	}

	const digests = entry.digests ?? {};
	for (const file of files) {
		const pinned = digests[file];
		if (!pinned) {
			problems.push(
				`${entry.proof}/${file}: frozen file has no pinned digest (run with --update)`,
			);
			continue;
		}
		let actual: string;
		try {
			actual = digest(path.join(proofRoot, file));
		} catch {
			problems.push(
				`${entry.proof}/${file}: frozen file is missing (canonical copy: ${entry.promotedTo})`,
			);
			continue;
		}
		if (actual !== pinned) {
			problems.push(
				`${entry.proof}/${file}: frozen proof changed after promotion — edit ${entry.promotedTo} instead`,
			);
		}
	}
	for (const pinnedFile of Object.keys(digests)) {
		if (!files.includes(pinnedFile)) {
			problems.push(
				`${entry.proof}/${pinnedFile}: pinned file vanished from the frozen proof`,
			);
		}
	}
}

if (update) {
	writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, "\t")}\n`);
	console.log(`promotions ledger digests refreshed: ${ledgerPath}`);
	process.exit(0);
}

if (problems.length > 0) {
	console.error("Promoted-proof drift detected:");
	for (const problem of problems) console.error(`- ${problem}`);
	console.error(
		"Frozen proofs are read-only after promotion; make changes in the canonical package (AGENTS.md).",
	);
	process.exit(1);
}

const frozen = ledger.promotions.filter((e) => e.status === "frozen").length;
console.log(
	`promoted-proof drift OK: ${frozen} frozen proof(s), ${ledger.promotions.length} ledger entries.`,
);
