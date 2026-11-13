/**
 * Ship-readiness gap closure guard (plans 0011/0012).
 *
 * Asserts every residual human ID remains on the residual ledger, that key
 * agent remediations exist on disk, and that honesty markers forbid false
 * "CI green" / "npm published" claims in the residual ledger itself.
 *
 * Exit 0 when the inventory is complete; exit 1 with a list of failures.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(import.meta.dirname, "..");

const REQUIRED_RESIDUAL_IDS = [
	"H-V1",
	"H-O2",
	"H-O3",
	"H-O4",
	"H-E1b",
	"H-E3b",
	"H-E5",
	"H-E6",
	"H-T1",
] as const;

const REQUIRED_PATHS = [
	"docs/plans/0011-ship-readiness-gap-review.md",
	"docs/design/launch-ship-targets.md",
	"docs/design/npm-publish-allowlist.md",
	"docs/design/instances/README.md",
	"docs/design/instances/v1-readiness-dashboard-2026-07-30.md",
	"docs/design/instances/go-no-go-repo-public-2026-07-30.md",
	"docs/design/instances/go-no-go-developer-tooling-2026-07-30.md",
	"docs/design/instances/accepted-risks-2026-07-30.md",
	"docs/design/instances/residual-human-blockers-2026-07-30.md",
	"docs/design/pre-public-secret-scan.md",
	"packages/componentize/src/componentize.ts",
] as const;

/**
 * Hosted CI is switched off by keeping the workflow files in
 * `.github/workflows-disabled/`, where GitHub does not discover them. A
 * workflow counts as present in either directory, and its integrity markers
 * are checked wherever it lives, so switching CI off or back on never turns
 * this check red or silently skips it.
 */
const WORKFLOW_DIRS = [
	".github/workflows",
	".github/workflows-disabled",
] as const;

function workflowPath(name: string): string | undefined {
	return WORKFLOW_DIRS.map((dir) => `${dir}/${name}`).find((rel) =>
		existsSync(path.join(repoRoot, rel)),
	);
}

const REQUIRED_WORKFLOWS = ["publish.yml"] as const;

function read(rel: string): string {
	return readFileSync(path.join(repoRoot, rel), "utf8");
}

const failures: string[] = [];

for (const rel of REQUIRED_PATHS) {
	if (!existsSync(path.join(repoRoot, rel))) {
		failures.push(`missing required path: ${rel}`);
	}
}
for (const name of REQUIRED_WORKFLOWS) {
	if (workflowPath(name) === undefined) {
		failures.push(
			`missing required workflow: ${name} (in ${WORKFLOW_DIRS.join(" or ")})`,
		);
	}
}

const residualPath =
	"docs/design/instances/residual-human-blockers-2026-07-30.md";
if (existsSync(path.join(repoRoot, residualPath))) {
	const residual = read(residualPath);
	for (const id of REQUIRED_RESIDUAL_IDS) {
		if (!residual.includes(id)) {
			failures.push(`residual ledger missing ${id}`);
		}
	}
	// Residual ledger must not claim these closed
	const falseClosed =
		/\bH-V1\b[^\n]{0,80}\b(fixed|closed|resolved|green)\b/iu.test(residual) &&
		!/does \*\*not\*\* claim H-V1 fixed/iu.test(residual);
	if (falseClosed) {
		failures.push("residual ledger appears to claim H-V1 fixed");
	}
	if (!/Agents must not mark these fixed/iu.test(residual)) {
		failures.push("residual ledger missing agents-must-not-mark-fixed guard");
	}
}

// ADR-0140 present
const adrTheme = "docs/design/adr/07-portability-extensibility.md";
if (existsSync(path.join(repoRoot, adrTheme))) {
	const adr = read(adrTheme);
	if (!/## ADR-0140\b/u.test(adr)) {
		failures.push(
			"ADR-0140 section missing from 07-portability-extensibility.md",
		);
	}
}

// Dual-bin: product bin on @hobo/hobo, not @hobo/cli
// SAFETY: assertion to `JSON.parse(read("packages/cli/package.json")) as { bin?: unknown; }` is required at this boundary.
const cliPkg = JSON.parse(read("packages/cli/package.json")) as {
	bin?: unknown;
};
// SAFETY: assertion to `JSON.parse(read("packages/hobo/package.json")) as { bin?: Record<string, string>; }` is required at this boundary.
const hoboPkg = JSON.parse(read("packages/hobo/package.json")) as {
	bin?: Record<string, string>;
};
if (cliPkg.bin) {
	failures.push("@hobo/cli must not ship a public bin (dual-bin conflict)");
}
if (!hoboPkg.bin?.hobo) {
	failures.push("@hobo/hobo must expose bin.hobo as product CLI");
}

// Workflow integrity markers
const s0Path = workflowPath("stage-gate-s0.yml");
const s0 = s0Path === undefined ? "" : read(s0Path);
if (s0 && !/stage-gate-s0-record-linux/u.test(s0)) {
	failures.push("stage-gate-s0.yml missing stable linux artifact name");
}
if (s0 && /stage-gate-s0-record-ubuntu-latest/u.test(s0)) {
	failures.push(
		"stage-gate-s0.yml still hardcodes ubuntu-latest artifact path",
	);
}

const hoboCiPath = workflowPath("hobo-ci.yml");
const hoboCi = hoboCiPath === undefined ? "" : read(hoboCiPath);
if (hoboCi) {
	// Require push trigger targeting main (inline list form used in this repo).
	const hasPushMain =
		/^  push:\s*$/m.test(hoboCi) && /branches:\s*\[\s*main\s*\]/u.test(hoboCi);
	if (!hasPushMain) {
		failures.push("hobo-ci.yml missing push: branches including main");
	}
}

// Immature packages private
const mustPrivate = [
	"packages/camps/package.json",
	"packages/yards/package.json",
	"packages/junctions/package.json",
	"packages/componentize/package.json",
	"packages/stage-gate/package.json",
];
for (const rel of mustPrivate) {
	if (!existsSync(path.join(repoRoot, rel))) continue;
	// SAFETY: assertion to `JSON.parse(read(rel)) as { private?: boolean; name?: string }` is required at this boundary.
	const pkg = JSON.parse(read(rel)) as { private?: boolean; name?: string };
	if (pkg.private !== true) {
		failures.push(`${pkg.name ?? rel} must be private: true`);
	}
}

// Componentize honesty
const componentize = existsSync(
	path.join(repoRoot, "packages/componentize/src/componentize.ts"),
)
	? read("packages/componentize/src/componentize.ts")
	: "";
if (
	componentize &&
	!/buildWasmContractBytes/u.test(componentize) &&
	!/contract-shaped|HONEST SCOPE|synthetic/iu.test(componentize)
) {
	failures.push(
		"componentize.ts missing contract-bytes / HONEST SCOPE markers",
	);
}
if (
	componentize &&
	!/HONEST SCOPE|contract-shaped|buildWasmContractBytes/u.test(componentize)
) {
	failures.push("componentize.ts honesty markers incomplete");
}

// Instance reconciliation: Target A secret scan Met must not be contradicted
const goA = "docs/design/instances/go-no-go-repo-public-2026-07-30.md";
if (existsSync(path.join(repoRoot, goA))) {
	const text = read(goA);
	if (
		!/secret scan.*\*\*Met \(2026-07-30\)\*\*|Met \(2026-07-30\).*secret|history secret scan \(condition 3\) is \*\*clean/iu.test(
			text,
		) &&
		!/\*\*Met \(2026-07-30\)\*\*.*gitleaks/iu.test(text)
	) {
		// Require explicit Met marker for condition 3
		if (!/\*\*Met \(2026-07-30\)\*\*/u.test(text) || !/gitleaks/iu.test(text)) {
			failures.push(
				`${goA}: Target A secret scan must record Met (2026-07-30) with gitleaks evidence`,
			);
		}
	}
	if (
		/Pending secret scan/iu.test(text) ||
		/missing secret-scan completion/iu.test(text)
	) {
		failures.push(
			`${goA}: frontmatter/blocker deltas still claim secret scan pending/missing`,
		);
	}
}

const goB = "docs/design/instances/go-no-go-developer-tooling-2026-07-30.md";
if (existsSync(path.join(repoRoot, goB))) {
	const text = read(goB);
	if (
		/secret scan\*\* still open|secret scan still open|Target A secret scan\./iu.test(
			text,
		)
	) {
		failures.push(`${goB}: still claims Target A secret scan open after Met`);
	}
	if (!/secret scan Met/iu.test(text) && !/secret scan \*\*Met/iu.test(text)) {
		failures.push(`${goB}: must acknowledge Target A secret scan Met`);
	}
}

const dash = "docs/design/instances/v1-readiness-dashboard-2026-07-30.md";
if (existsSync(path.join(repoRoot, dash))) {
	const text = read(dash);
	if (
		/S0 CI columns `TODO`|bare TODO/iu.test(text) &&
		!/pending runner restoration/iu.test(text)
	) {
		failures.push(
			`${dash}: S0 still described as bare TODO without pending-runner honesty`,
		);
	}
	if (/dual-bin and immature `publishConfig` risk/iu.test(text)) {
		failures.push(
			`${dash}: still lists dual-bin/publishConfig as open B blockers after WP-D`,
		);
	}
	if (/Secret history scan still required before Target A go/iu.test(text)) {
		failures.push(
			`${dash}: still claims secret scan required before Target A after Met`,
		);
	}
	if (!/secret scan.*Met|Secret scan.*Met/iu.test(text)) {
		failures.push(`${dash}: must note secret scan Met for Target A`);
	}
}

if (failures.length > 0) {
	console.error(`ship-gap-closure: FAIL (${failures.length})`);
	for (const f of failures) console.error(`  - ${f}`);
	process.exit(1);
}

console.log(
	`ship-gap-closure: OK — ${REQUIRED_RESIDUAL_IDS.length} residual IDs present, remediations on disk, dual-bin + CI markers hold`,
);
process.exit(0);
