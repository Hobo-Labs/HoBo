// Enforcement tiers, so nobody mistakes one for the other:
// - Structural checks (data-models presence, PACT contract validity,
//   proto<->CUE type coverage, parallel-proto-type) inspect real artifacts
//   and cannot be satisfied by prose.
// - Documentation-presence checks (missing-parse-derived-type,
//   missing-event-architecture) grep for the vocabulary the architecture
//   rules require the package to document. They verify the package SAYS how
//   it applies parse-don't-validate and the event architecture, not that the
//   code does — behavioral verification lives in each package's tests and
//   PACT contracts.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const IMPLEMENTATION_EXTENSIONS = new Set([
	".cjs",
	".cts",
	".cue",
	".js",
	".json",
	".mjs",
	".mts",
	".proto",
	".ts",
	".wit",
]);

const DOC_ONLY_EXTENSIONS = new Set([".md", ".mdx", ".txt"]);
const DRAFT_PROOF_KINDS = new Set([
	"technical-proofs",
	"exp-proofs",
	"epic-proofs",
	"projects",
]);

const TEXT_EXTENSIONS = new Set([
	".cue",
	".js",
	".json",
	".md",
	".mjs",
	".mts",
	".proto",
	".ts",
	".wit",
]);

// Production packages under packages/ require full scaffolding (contracts/,
// data-models/). Barebones examples under examples/ are demos — only src/ +
// tests; they must not be forced to ship contracts/data-models/deploy in git.
const PRODUCTION_PACKAGE_PARENTS = new Set(["packages"]);
// Nested categories hold one package per subdirectory (e.g. runtimes/local,
// adapters/adapter-hono); the category dir itself is not a package.
const NESTED_PRODUCTION_CATEGORIES = new Set([
	"adapters",
	"runtimes",
	"providers",
	"iac",
	"connectors",
	"packs",
]);

export function isProductionPackageRoot(packageRoot) {
	return PRODUCTION_PACKAGE_PARENTS.has(
		normalizePath(packageRoot).split("/")[0],
	);
}

const PRODUCTION_CHECKS = [
	{
		code: "missing-data-models-folder",
		message:
			"Define protobuf records and CUE constraints inside the package-local data-models/ folder (at least one .proto and one .cue).",
		passes: (evidence) =>
			evidence.hasDataModelsProto && evidence.hasDataModelsCue,
	},
	{
		code: "misplaced-data-model",
		message:
			"Move all .proto/.cue files under the package-local data-models/ folder; production packages allow no other location.",
		passes: (evidence) => !evidence.hasMisplacedDataModel,
	},
	{
		code: "missing-contracts-pact",
		message:
			"Keep executable PACT consumer/provider evidence (*.pact.json with consumer, provider, interactions) under the package-local contracts/ folder.",
		passes: (evidence) => evidence.hasContractsPact,
	},
];

const REQUIRED_CHECKS = [
	{
		code: "missing-pact-contract",
		message:
			"Add an executable PACT contract for each changed service boundary.",
		passes: (evidence) => evidence.hasPactContract,
	},
	{
		code: "missing-protobuf-definition",
		message:
			"Define changed records, messages, data shapes, and objects in protobuf.",
		passes: (evidence) => evidence.hasProtobufDefinition,
	},
	{
		code: "missing-cue-constraints",
		message:
			"Add CUE constraints for every protobuf type in the changed package.",
		passes: (evidence) => evidence.hasCueConstraints,
	},
	{
		code: "missing-parse-derived-type",
		message:
			"Document or implement parse-don't-validate derived types for constrained values.",
		passes: (evidence) => evidence.hasParseDerivedTypes,
	},
	{
		code: "missing-event-architecture",
		message:
			"Name command/event, actor, event-store, materialized-view/projection, snapshot, and read-store behavior.",
		passes: (evidence) => evidence.hasEventArchitecture,
	},
	{
		code: "parallel-proto-type",
		message: (evidence) =>
			`Import generated types from src/_generated/**_pb.ts instead of hand-declaring proto-shaped types (technical-standards.md); annotate deliberate exceptions with // parallel-type-allowed: <why>. Offenders: ${evidence.parallelTypeDeclarations.join(", ")}`,
		passes: (evidence) => evidence.parallelTypeDeclarations.length === 0,
	},
];

export function foreignLockfileProblems(files) {
	const problems = [];
	for (const file of unique(files.map(normalizePath))) {
		if (
			/(^|\/)(package-lock\.json|yarn\.lock)$/u.test(file) ||
			(file.endsWith("/pnpm-lock.yaml") && file !== "pnpm-lock.yaml")
		) {
			problems.push({
				code: "single-lockfile",
				message:
					"pnpm workspace allows only the root pnpm-lock.yaml; remove nested or npm/yarn lockfiles",
				packageRoot: file,
			});
		}
	}
	return problems;
}

export async function checkArchitectureGuardrails({
	root = process.cwd(),
	files,
} = {}) {
	const normalizedFiles = unique((files ?? []).map(normalizePath));
	const frozen = frozenPromotedProofRoots(root);
	const packageRoots = implementationPackageRoots(normalizedFiles).filter(
		(packageRoot) => !frozen.has(packageRoot),
	);
	const problems = foreignLockfileProblems(normalizedFiles);

	const evidenceByPackage = await Promise.all(
		packageRoots.map(async (packageRoot) => ({
			packageRoot,
			evidence: await collectEvidence(root, packageRoot),
		})),
	);

	const checksFor = (packageRoot) =>
		isProductionPackageRoot(packageRoot)
			? [...REQUIRED_CHECKS, ...PRODUCTION_CHECKS]
			: REQUIRED_CHECKS;

	for (const { packageRoot, evidence } of evidenceByPackage) {
		for (const check of checksFor(packageRoot)) {
			if (!check.passes(evidence)) {
				problems.push({
					code: check.code,
					message:
						Object.prototype.toString.call(check.message) ===
						"[object Function]"
							? check.message(evidence)
							: check.message,
					packageRoot,
				});
			}
		}
	}

	return { packageRoots, problems };
}

// Frozen promoted proofs (scripts/promotions.json) are read-only by the
// promoted-proof drift gate — their canonical successors in packages/ carry
// the architecture evidence now. Evaluating them here would demand edits the
// drift gate forbids, so they are excluded from guard evaluation.
function frozenPromotedProofRoots(root) {
	try {
		const ledger = JSON.parse(
			readFileSync(path.join(root, "scripts", "promotions.json"), "utf8"),
		);
		return new Set(
			(ledger.promotions ?? [])
				.filter((entry) => entry.status === "frozen")
				.map((entry) => normalizePath(entry.proof))
				.map((proofPath) => {
					const parts = proofPath.split("/");
					return parts.slice(0, 4).join("/");
				}),
		);
	} catch {
		return new Set();
	}
}

export function implementationPackageRoots(files) {
	const roots = [];

	for (const file of files) {
		const normalized = normalizePath(file);
		if (!isImplementationFile(normalized)) continue;
		const root = implementationPackageRoot(normalized);
		if (!root) continue;
		roots.push(root);
	}

	return unique(roots);
}

async function collectEvidence(root, packageRoot) {
	const absolutePackageRoot = path.join(root, ...packageRoot.split("/"));
	const files = existsSync(absolutePackageRoot)
		? await listFiles(absolutePackageRoot, absolutePackageRoot)
		: [];
	const text = [];
	const typeScriptSources = [];
	const protoTypes = new Set();
	const cueTexts = [];
	let hasPactContract = false;
	let hasProtobufDefinition = false;
	let hasDataModelsProto = false;
	let hasDataModelsCue = false;
	let hasMisplacedDataModel = false;
	let hasContractsPact = false;

	for (const file of files) {
		const normalized = normalizePath(file);
		const ext = path.extname(file).toLowerCase();

		if (
			/\.pact\.json$/i.test(normalized) ||
			/(^|\/)pacts?\//i.test(normalized)
		) {
			hasPactContract =
				hasPactContract ||
				(await isPactContract(path.join(absolutePackageRoot, file)));
		}
		if (ext === ".proto") {
			hasProtobufDefinition = true;
			for (const typeName of protoTypeNames(
				await readFile(path.join(absolutePackageRoot, file), "utf8"),
			)) {
				protoTypes.add(typeName);
			}
		}
		if (ext === ".cue") {
			cueTexts.push(
				await readFile(path.join(absolutePackageRoot, file), "utf8"),
			);
		}
		if (ext === ".proto" || ext === ".cue") {
			if (normalized.startsWith("data-models/")) {
				if (ext === ".proto") hasDataModelsProto = true;
				if (ext === ".cue") hasDataModelsCue = true;
			} else {
				hasMisplacedDataModel = true;
			}
		}
		if (
			normalized.startsWith("contracts/") &&
			normalized.toLowerCase().endsWith(".pact.json")
		) {
			hasContractsPact =
				hasContractsPact ||
				(await isPactContract(path.join(absolutePackageRoot, file)));
		}

		if (TEXT_EXTENSIONS.has(ext)) {
			const contents = await readFile(
				path.join(absolutePackageRoot, file),
				"utf8",
			);
			text.push(contents);
			if (
				ext === ".ts" &&
				normalized.startsWith("src/") &&
				!/(^|\/)_generated(\/|$)/.test(normalized)
			) {
				typeScriptSources.push({ file: normalized, contents });
			}
		}
	}

	const combinedText = text.join("\n");
	const combinedCueText = cueTexts.join("\n");

	return {
		hasPactContract,
		hasProtobufDefinition,
		hasCueConstraints:
			protoTypes.size > 0 &&
			[...protoTypes].every((typeName) =>
				cueDefinesType(combinedCueText, typeName),
			),
		hasParseDerivedTypes:
			/parse,?\s+don['’]?t\s+validate/i.test(combinedText) &&
			/\b(derived|parsed)\s+(?:domain\s+)?types?\b/i.test(combinedText),
		hasEventArchitecture:
			/\bcommand/i.test(combinedText) &&
			/\bevents?\b/i.test(combinedText) &&
			/\bactors?\b/i.test(combinedText) &&
			/\bevent[-\s]?stores?\b/i.test(combinedText) &&
			/\b(materialized\s+views?|projections?)\b/i.test(combinedText) &&
			/\bsnapshots?\b/i.test(combinedText) &&
			/\bread\s+stores?\b/i.test(combinedText),
		hasDataModelsProto,
		hasDataModelsCue,
		hasMisplacedDataModel,
		hasContractsPact,
		parallelTypeDeclarations: parallelTypeDeclarations(
			typeScriptSources,
			protoTypes,
		),
	};
}

// Hand-declared TS types that duplicate a proto message/enum name are the
// "parallel interfaces" the architecture rules forbid — record types must be
// the generated ones (technical-standards.md). Two markers on the
// declaration line (or the line above) suppress a hit, for the two legitimate
// cases the standard recognizes:
//   // domain-view: <why>          — a deliberately richer parse-don't-validate
//                                     domain type (branded ids, generics, extra
//                                     fields) whose generated *_pb.ts is its
//                                     wire form; permanent by design.
//   // parallel-type-allowed: <why> — temporary debt awaiting migration.
const PARALLEL_TYPE_MARKERS = ["domain-view:", "parallel-type-allowed:"];

/**
 * True when the marker sits on the declaration line or anywhere in the comment
 * block immediately above it.
 *
 * This read exactly one preceding line, so a marker written as the *first* line
 * of a multi-line block — the natural place, since the reason usually needs a
 * sentence — was silently ignored and the guard reported an unannotated type
 * that was in fact annotated. `check-technical-standards.ts` had the identical
 * bug for `// public-contract:`; both are fixed, and they should stay
 * symmetric, because an author who learns the rule from one gate will apply it
 * at the other.
 */
function hasMarkerAbove(lines, index, marker) {
	if ((lines[index] ?? "").includes(marker)) return true;
	for (let above = index - 1; above >= 0; above -= 1) {
		const text = (lines[above] ?? "").trim();
		const isComment =
			text.startsWith("//") ||
			text.startsWith("*") ||
			text.startsWith("/*") ||
			text.endsWith("*/");
		if (!isComment) return false;
		if (text.includes(marker)) return true;
	}
	return false;
}
function parallelTypeDeclarations(typeScriptSources, protoTypes) {
	if (protoTypes.size === 0) return [];
	const offenders = [];
	for (const { file, contents } of typeScriptSources) {
		const lines = contents.split(/\r?\n/u);
		for (const [index, line] of lines.entries()) {
			// Declarations only: `interface X ...` or `type X = {` (an alias whose
			// right-hand side derives from another type is a legitimate narrowing,
			// and `type X,` inside import/export lists is not a declaration).
			const match = line.match(
				/^\s*(?:export\s+)?(?:interface\s+([A-Za-z_$][\w$]*)[\s<{]|type\s+([A-Za-z_$][\w$]*)(?:<[^>]*>)?\s*=\s*\{)/u,
			);
			const name = match?.[1] ?? match?.[2];
			if (!name || !protoTypes.has(name)) continue;
			if (
				PARALLEL_TYPE_MARKERS.some((marker) =>
					hasMarkerAbove(lines, index, marker),
				)
			) {
				continue;
			}
			offenders.push(`${file}:${index + 1} ${name}`);
		}
	}
	return offenders;
}

/**
 * Comments are stripped first, because this scrapes declarations out of prose
 * otherwise. A doc comment reading "a proto enum is a varint" registered a type
 * named `is`, and `missing-cue-constraints` then demanded a CUE constraint for
 * it — naming no type the author could find, because there wasn't one. Two
 * swarms lost a round trip to that in one day.
 */
function protoTypeNames(content) {
	const withoutComments = content
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.replace(/\/\/[^\n]*/g, " ");
	return [
		...withoutComments.matchAll(
			/\b(?:message|enum)\s+([A-Za-z_][A-Za-z0-9_]*)\b/g,
		),
	].map((match) => match[1]);
}

function cueDefinesType(content, typeName) {
	const escaped = escapeRegExp(typeName);
	return new RegExp(`(^|\\n)\\s*#?${escaped}\\s*:`, "m").test(content);
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function isPactContract(file) {
	if (!/\.pact\.json$/i.test(file)) return false;

	try {
		const pact = JSON.parse(await readFile(file, "utf8"));
		return Boolean(
			pact.consumer && pact.provider && Array.isArray(pact.interactions),
		);
	} catch {
		return false;
	}
}

async function listFiles(base, current) {
	const entries = await readdir(current, { withFileTypes: true });
	const files = [];

	for (const entry of entries) {
		if (entry.name === "node_modules" || entry.name === ".git") continue;

		const absolute = path.join(current, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await listFiles(base, absolute)));
		} else if (entry.isFile()) {
			files.push(path.relative(base, absolute));
		}
	}

	return files;
}

function changedFiles(args) {
	const baseArg = [...args].find((arg) => arg.startsWith("--base="));
	const base =
		baseArg?.slice("--base=".length) ?? process.env.HOBO_ARCHITECTURE_BASE;

	// Full-repo mode: evaluate every production package regardless of diff.
	// Used by check:all and the CI main gate, where a fresh checkout has no
	// diff and the bare invocation would otherwise pass vacuously.
	if (args.has("--all")) {
		return split(git(["ls-files", "packages", "examples"]));
	}

	if (args.has("--staged")) {
		return split(
			git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]),
		);
	}

	if (base) {
		return split(
			git(["diff", "--name-only", "--diff-filter=ACMR", `${base}...HEAD`]),
		);
	}

	return unique([
		...split(git(["diff", "--name-only", "--diff-filter=ACMR", "HEAD"])),
		...split(git(["ls-files", "--others", "--exclude-standard"])),
	]);
}

function git(args) {
	return execFileSync("git", args, {
		encoding: "utf8",
		// monorepo `git ls-files` exceeds Node's default 1 MiB maxBuffer
		maxBuffer: 32 * 1024 * 1024,
	}).trim();
}

function implementationPackageRoot(file) {
	const parts = normalizePath(file).split("/");
	if (PRODUCTION_PACKAGE_PARENTS.has(parts[0]) && parts.length >= 3) {
		if (parts[1] && NESTED_PRODUCTION_CATEGORIES.has(parts[1]) && parts[2]) {
			return parts.slice(0, 3).join("/");
		}
		return parts.slice(0, 2).join("/");
	}

	if (parts[0] !== "src" || parts[1] !== "draft" || !parts[2]) return undefined;

	// Aggregate metadata (underscore-prefixed like _templates/_grandfathered.json/_registry.md)
	// and loose files directly under src/draft/<kind>/ are never proof packages.
	const isPackageDir = (segment, next) =>
		segment && !segment.startsWith("_") && next !== undefined;

	if (parts[2] === "exp-proofs" && parts[3] && !parts[3].startsWith("_")) {
		return isPackageDir(parts[4], parts[5])
			? parts.slice(0, 5).join("/")
			: undefined;
	}

	if (DRAFT_PROOF_KINDS.has(parts[2])) {
		return isPackageDir(parts[3], parts[4])
			? parts.slice(0, 4).join("/")
			: undefined;
	}

	return undefined;
}

function split(output) {
	return output ? output.split(/\r?\n/).map(normalizePath) : [];
}

function isImplementationFile(file) {
	const ext = path.extname(file).toLowerCase();
	if (DOC_ONLY_EXTENSIONS.has(ext)) return false;

	const basename = path.basename(file);
	if (
		basename === "package.json" ||
		basename === "pnpm-lock.yaml" ||
		basename === "pnpm-workspace.yaml"
	)
		return true;

	return IMPLEMENTATION_EXTENSIONS.has(ext);
}

function normalizePath(file) {
	return file.split(path.sep).join("/");
}

function unique(values) {
	return [...new Set(values)];
}

function formatProblems(problems) {
	const lines = [
		"HoBo architecture guardrails failed for changed implementation packages.",
		"Each changed package must provide PACT, protobuf, CUE, parse-don't-validate, and event architecture evidence before CI.",
	];

	for (const problem of problems) {
		lines.push(
			`- ${problem.packageRoot}: ${problem.code} - ${problem.message}`,
		);
	}

	return lines.join("\n");
}

function trackedForeignLockfiles() {
	return split(git(["ls-files"])).filter((file) => {
		const normalized = normalizePath(file);
		return (
			/(^|\/)(package-lock\.json|yarn\.lock)$/u.test(normalized) ||
			(normalized.endsWith("/pnpm-lock.yaml") &&
				normalized !== "pnpm-lock.yaml")
		);
	});
}

async function main() {
	const args = new Set(process.argv.slice(2));
	const files = unique([...changedFiles(args), ...trackedForeignLockfiles()]);
	const result = await checkArchitectureGuardrails({ files });

	if (result.problems.length > 0) {
		console.error(formatProblems(result.problems));
		process.exit(1);
	}

	console.log(
		result.packageRoots.length > 0
			? `Architecture guardrails OK: ${result.packageRoots.length} changed implementation package(s).`
			: "Architecture guardrails OK: no changed implementation packages.",
	);
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
	await main();
}
