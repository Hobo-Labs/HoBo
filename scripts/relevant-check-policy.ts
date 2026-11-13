import { existsSync, readFileSync } from "node:fs";

import { workspaceForDraftFile } from "./lib/proof-manifest.ts";
import { turboConcurrencyArg } from "./lib/turbo-concurrency.ts";

export type Check = {
	command: string;
	args: string[];
	reason: string;
	serial?: boolean;
};

export type RelevantCheckPolicyOptions = {
	files: string[];
	base: string;
	workspaceTestFiles?: string[];
	staged?: boolean;
	all?: boolean;
	includeBuild?: boolean;
	includeBroadSweeps?: boolean;
	/**
	 * The caller requires separate jobs to run all selected workspace tests
	 * and the scripts lane (`workspace_tests` and `scripts-tests` in CI).
	 */
	workspaceTestsCoveredExternally?: boolean;
	rootPackageJsonScriptsOnlyChanged?: boolean;
	workspacePackageExists?: (workspace: string) => boolean;
	/** Whether a changed TypeScript file under packages/ names a ts-autocode module (default: reads it). */
	importsTsAutocode?: (file: string) => boolean;
};

export type RelevantCheckPolicy = {
	checks: Check[];
	scopes: string[];
	workspaces: string[];
};

export function workspaceFor(file: string) {
	const normalized = file.replaceAll("\\", "/");
	if (normalized.startsWith("site/")) return "site";
	const draft = normalized.match(
		/^src\/draft\/(technical-proofs|epic-proofs|projects)\/([^/]+)\//u,
	);
	if (draft) return `src/draft/${draft[1]}/${draft[2]}`;
	const exp = normalized.match(
		/^src\/draft\/exp-proofs\/(dx|ux|cx|ax|api)\/([^/]+)\//u,
	);
	if (exp) return `src/draft/exp-proofs/${exp[1]}/${exp[2]}`;
	const production = normalized.match(
		/^(packages|examples)\/(?:(runtimes|providers|iac|build)\/)?([^/]+)\//u,
	);
	if (!production) return undefined;
	return production[2]
		? `${production[1]}/${production[2]}/${production[3]}`
		: `${production[1]}/${production[3]}`;
}

function workspaceTestRelevant(file: string) {
	const normalized = file.replaceAll("\\", "/");
	const workspace = workspaceFor(normalized);
	if (!workspace) return false;

	const relative = normalized.slice(workspace.length + 1);
	return (
		/^(src|app|apps|test|tests|type-tests|features|contracts|simulation|scripts|data-models)\//u.test(
			relative,
		) ||
		/^(package|tsconfig(?:\.[^.]+)?)\.json$/u.test(relative) ||
		/^(pnpm-lock\.yaml|turbo\.json)$/u.test(relative) ||
		/\.(?:proto|cue|pact\.json)$/u.test(relative)
	);
}

function defaultWorkspacePackageExists(workspace: string) {
	return existsSync(`${workspace}/package.json`);
}

function defaultWorkspacePackageName(workspace: string): string | undefined {
	try {
		const manifest: { name?: string } = JSON.parse(
			readFileSync(`${workspace}/package.json`, "utf8"),
		);
		return manifest.name;
	} catch {
		return undefined;
	}
}

const PACKAGE_TYPESCRIPT = /^packages\/.+\.(?:[cm]?ts|tsx)$/u;
/** In any quote, a template literal's included: the surface test scans those too. */
const TS_AUTOCODE_SPECIFIER =
	/["'`]ts-autocode(?:-[a-z]+)?(?:\/[^"'`]*)?["'`]/u;

/**
 * What the grounding drift test compiles granular.ts with, beyond ts-autocode
 * itself: the types its conversion assigns to and the compiler options. None
 * of them imports ts-autocode, so the import check alone would not select it.
 */
const GROUNDING_DRIFT_INPUTS = new Set([
	"packages/runtime/src/json.ts",
	"packages/runtime/src/training/types.ts",
	"packages/runtime/tsconfig.json",
	"tsconfig.base.json",
]);

/** Whether source text names a ts-autocode module specifier. */
export function namesTsAutocode(text: string) {
	return TS_AUTOCODE_SPECIFIER.test(text);
}

/** A file that is gone (deleted, renamed away) imports nothing. */
function defaultImportsTsAutocode(file: string) {
	try {
		return namesTsAutocode(readFileSync(file, "utf8"));
	} catch {
		return false;
	}
}

/** The tests that hold signed local runs (pnpm ci:attest) to their rules. */
export const SIGNED_LOCAL_RUN_TESTS = [
	"scripts/test/attestation.test.ts",
	"scripts/test/verify-attestation.test.ts",
	"scripts/test/attested-jobs.test.ts",
	"scripts/test/merge-group-gate.test.ts",
	"scripts/test/lint-actions-runner.test.ts",
	"scripts/test/local-attest.test.ts",
];

const SIGNED_LOCAL_RUN_GUARDED = new Set([
	".github/workflows/hobo-ci.yml",
	".github/workflows/release-hobo.yml",
	".hobo/ci-attestors.json",
	"scripts/ci/attested-jobs.json",
	"scripts/ci/attested-jobs.mts",
	"scripts/ci/attestation.mts",
	"scripts/ci/verify-attestation.mts",
	"scripts/ci/local-attest.mts",
	"scripts/ci/route-runner.mts",
	"scripts/lib/workflow-job-steps.mts",
	"scripts/lint-actions.ts",
	...SIGNED_LOCAL_RUN_TESTS,
]);

/** Whether a changed file is one the signed-local-run guards protect. */
function guardsSignedLocalRuns(file: string): boolean {
	return (
		SIGNED_LOCAL_RUN_GUARDED.has(file) ||
		file.startsWith(".github/actions/route-runner/")
	);
}

export function selectRelevantChecks(
	options: RelevantCheckPolicyOptions,
): RelevantCheckPolicy {
	const files = options.files.map((file) => file.replaceAll("\\", "/"));
	const workspaceTestFiles = (options.workspaceTestFiles ?? options.files).map(
		(file) => file.replaceAll("\\", "/"),
	);
	const staged = Boolean(options.staged);
	const includeBuild = Boolean(options.includeBuild);
	const includeBroadSweeps = Boolean(options.includeBroadSweeps || options.all);
	const workspacePackageExists =
		options.workspacePackageExists ?? defaultWorkspacePackageExists;
	const importsTsAutocode =
		options.importsTsAutocode ?? defaultImportsTsAutocode;

	const workspaces = [
		...new Set(
			workspaceTestFiles
				.filter(workspaceTestRelevant)
				.map(workspaceFor)
				.filter((value): value is string => Boolean(value)),
		),
	].filter(workspacePackageExists);
	const draftWorkspaces = [
		...new Set(
			files
				.map(workspaceForDraftFile)
				.filter((value): value is string => Boolean(value)),
		),
	].filter(workspacePackageExists);
	const touched = (prefixes: string[]) =>
		files.some((file) =>
			prefixes.some(
				(prefix) => file === prefix || file.startsWith(`${prefix}/`),
			),
		);
	const touchedAny = (patterns: RegExp[]) =>
		files.some((file) => patterns.some((pattern) => pattern.test(file)));

	const automationChanged =
		touched([
			"scripts",
			".githooks",
			".github",
			".codex",
			".cursor",
			".claude",
			".agents",
		]) ||
		touchedAny([
			/^package\.json$/u,
			/^pnpm-lock\.yaml$/u,
			/^pnpm-workspace\.yaml$/u,
			/^turbo\.json$/u,
		]);
	const rootConfigChanged = touchedAny([
		/^package\.json$/u,
		/^pnpm-lock\.yaml$/u,
		/^pnpm-workspace\.yaml$/u,
		/^turbo\.json$/u,
		/^tsconfig.*\.json$/u,
	]);
	const konsistentConfigChanged = touchedAny([/^konsistent\.json$/u]);
	const sourceChanged = touched([
		"src",
		"contracts",
		"test",
		"tests",
		"packages",
		"examples",
		"site",
	]);
	const docsChanged =
		touched(["docs"]) ||
		touchedAny([
			/^README\.md$/u,
			/^CONTRIBUTING\.md$/u,
			/^AGENTS\.md$/u,
			/^CLAUDE\.md$/u,
		]);
	const workspaceSchemaChanged = files.some(
		(file) => /\.(?:proto|cue)$/u.test(file) && Boolean(workspaceFor(file)),
	);
	const rootSchemaChanged =
		touched(["contracts"]) ||
		touchedAny([/(^|\/)_generated\//u, /(^|\/)buf(\.gen)?\.yaml$/u]) ||
		files.some((file) => /\.(?:proto|cue)$/u.test(file) && !workspaceFor(file));
	const schemaChanged = rootSchemaChanged || workspaceSchemaChanged;
	const pactChanged = touchedAny([/(^|\/)pacts\//u, /\.pact\.json$/u]);
	const rootPactChanged = files.some(
		(file) =>
			(/(^|\/)pacts\//u.test(file) || file.endsWith(".pact.json")) &&
			!workspaceFor(file),
	);
	const uiChanged =
		touched(["apps/web", "packages/ui", "site"]) ||
		touchedAny([
			/\.(tsx|jsx|css|astro)$/u,
			/(^|\/)DESIGN\.md$/u,
			/^scripts\/check-design-md\.mts$/u,
		]);
	const designMdChanged =
		touchedAny([
			/(^|\/)DESIGN\.md$/u,
			/^scripts\/check-design-md\.mts$/u,
			/^site\/(src\/styles|src\/components|src\/layouts)\//u,
		]) || uiChanged;
	const behaviorChanged =
		touched(["tests/behavior"]) ||
		// Feature files and step definitions live inside proof packages
		// (src/draft/<kind>/<slug>/features/...), so match the path segment,
		// not a repo-root prefix. The cucumber config is cucumber.yaml.
		// Catalog starter trees may ship Gherkin fixtures; they are not the
		// repository behavior lane.
		files.some(
			(file) =>
				!/(^|\/)\.optimizexp\/features\//u.test(file) &&
				!/(^|\/)packages\/patterns\/patterns\//u.test(file) &&
				[
					/(^|\/)features\//u,
					/\.feature$/u,
					/^cucumber\.ya?ml$/u,
					/playwright\.behavior\.config\./u,
				].some((pattern) => pattern.test(file)),
		);
	const visualChanged =
		touched(["tests/visual", "storybook"]) ||
		touchedAny([/playwright\.visual\.config\./u, /\.stories\./u]);
	const agentEvalChanged =
		touched(["evals"]) ||
		touchedAny([
			/(^|\/)(prompts?|agent-evals?)(\/|$)/iu,
			/\.(?:prompt|eval)\.(?:ts|md|json)$/iu,
		]);
	const deploymentDeltaChanged =
		touched(["docs/design/proofs/hobo-50-deployment-set-delta"]) ||
		touchedAny([/^scripts\/validate-deployment-set-delta\.ts$/u]);
	const optimizexpChanged = touchedAny([
		/(^|\/)\.optimizexp(\/|$)/u,
		/^\.(agents|claude)\/skills\/optimizexp(\/|$)/u,
		/^\.(agents|claude)\/skills\/sdlc(\/|$)/u,
		/^scripts\/check-optimizexp\.mts$/u,
	]);
	const traceabilityChanged =
		touched(["docs/design/proofs"]) ||
		touchedAny([
			/^docs\/design\/(?:traceability|index)\.md$/u,
			/^docs\/design\/adr\//u,
			/^scripts\/validate-traceability\.ts$/u,
		]);

	const checks: Check[] = [];

	if (rootConfigChanged) {
		checks.push({
			command: "pnpm",
			args: ["run", "install:check"],
			reason: "package manager or root task graph changed",
			serial: true,
		});
	}

	if (sourceChanged || automationChanged) {
		checks.push({
			command: "pnpm",
			args: ["run", "case:check"],
			reason: "Windows case-collision preflight for tracked paths",
		});
		checks.push({
			command: "pnpm",
			args: [
				"run",
				staged ? "architecture:guard:staged" : "architecture:guard",
				"--",
				`--base=${options.base}`,
			],
			reason: "architecture-sensitive source or automation changed",
		});
		checks.push({
			command: "pnpm",
			args: ["run", "lint:code"],
			reason:
				"Biome code formatting is enforced for source or automation changes",
		});
	}

	const slopLintChanged =
		sourceChanged ||
		automationChanged ||
		touchedAny([/^oxlint\.config\.ts$/u, /^tools\/oxlint\//u]);
	if (slopLintChanged) {
		checks.push({
			command: "pnpm",
			args: [
				"run",
				"lint:slop:changed",
				"--",
				staged ? "--staged" : `--base=${options.base}`,
			],
			reason:
				"anti-slop Oxlint rules enforced on changed TS/JS files (warnings denied); pre-existing backlog stays out of scope",
		});
	}

	const shellChanged =
		automationChanged ||
		files.some((file) => file.endsWith(".sh") || file.endsWith(".bash"));
	if (shellChanged) {
		checks.push({
			command: "pnpm",
			args: [
				"run",
				"lint:shell:changed",
				"--",
				staged ? "--staged" : `--base=${options.base}`,
			],
			reason: "changed shell scripts must pass bash -n and shellcheck in CI",
		});
	}

	if (sourceChanged || automationChanged || konsistentConfigChanged) {
		checks.push({
			command: "pnpm",
			args: ["run", "konsistent"],
			reason:
				"structural package conventions (konsistent.json) are enforced when packages, automation, or the convention config change",
		});
	}

	if (rootSchemaChanged) {
		checks.push({
			command: "pnpm",
			args: ["run", "test:schema"],
			reason:
				"root protobuf/CUE/schema changed; run repository schema compatibility lane",
		});
		if (includeBroadSweeps) {
			checks.push({
				command: "pnpm",
				args: ["run", "test:contract:consumer"],
				reason:
					"final/all root schema validation can affect consumer contracts",
			});
			checks.push({
				command: "pnpm",
				args: ["run", "test:contract:provider"],
				reason:
					"final/all root schema validation can affect provider verification",
			});
		}
	} else if (rootPactChanged && includeBroadSweeps) {
		checks.push({
			command: "pnpm",
			args: ["run", "test:contract:consumer"],
			reason: "final/all root Pact validation can affect consumer contracts",
		});
		checks.push({
			command: "pnpm",
			args: ["run", "test:contract:provider"],
			reason: "final/all root Pact validation can affect provider verification",
		});
	}

	const narrowWorkspaceTests = workspaces.flatMap((workspace) => {
		if (!staged) return [];
		const relevantFiles = workspaceTestFiles.filter(
			(file) => workspaceTestRelevant(file) && workspaceFor(file) === workspace,
		);
		const testFiles = relevantFiles.filter((file) =>
			file.startsWith(`${workspace}/test/`),
		);
		const vitestPaths = testFiles
			.filter((file) => /\.(?:test|spec)\./u.test(file))
			.map((file) => file.slice(`${workspace}/`.length));
		const requiresFullWorkspaceTest =
			relevantFiles.length !== testFiles.length ||
			testFiles.includes(`${workspace}/test/subprocess-teardown.ts`) ||
			files.some((file) => file.startsWith(`${workspace}/vitest.config.`)) ||
			(testFiles.length > 0 && vitestPaths.length === 0);
		if (requiresFullWorkspaceTest) return [];
		const packageName = defaultWorkspacePackageName(workspace);
		if (!packageName) return [];
		return [{ workspace, packageName, vitestPaths }];
	});
	const narrowWorkspaces = new Set(
		narrowWorkspaceTests.map(({ workspace }) => workspace),
	);

	if (workspaces.length > 0 && !options.workspaceTestsCoveredExternally) {
		const turboWorkspaces = workspaces.filter(
			(workspace) => !narrowWorkspaces.has(workspace),
		);
		if (turboWorkspaces.length > 0) {
			checks.push({
				command: "pnpm",
				args: [
					"exec",
					"turbo",
					"run",
					"test",
					...turboWorkspaces.map((workspace) => `--filter=./${workspace}`),
					"--continue",
					"--output-logs=new-only",
					turboConcurrencyArg(),
				],
				reason: `workspace tests for ${turboWorkspaces.length} changed package(s) via Turbo; strict env passes HOBO_* and NODE_OPTIONS; warm runs replay from cache`,
			});
		}
	}

	for (const {
		packageName,
		vitestPaths,
	} of options.workspaceTestsCoveredExternally ? [] : narrowWorkspaceTests) {
		checks.push({
			command: "pnpm",
			args: ["--filter", packageName, "exec", "vitest", "run", ...vitestPaths],
			reason: `staged changes are test-only; run ${vitestPaths.length} changed test file(s) directly`,
		});
	}

	if (workspaces.includes("site")) {
		checks.push({
			command: "pnpm",
			args: [
				"exec",
				"turbo",
				"run",
				"typecheck",
				"--filter=./site",
				"--output-logs=new-only",
				turboConcurrencyArg(),
			],
			reason: "site browser code must stay type-clean",
		});
	}

	if (draftWorkspaces.length > 0) {
		checks.push({
			command: "pnpm",
			args: [
				"run",
				staged ? "draft:artifacts:staged" : "draft:artifacts",
				"--",
				`--base=${options.base}`,
			],
			reason:
				"changed proof packages must satisfy the draft-artifact requirements (grandfathered packages get advisories)",
		});
		checks.push({
			command: "pnpm",
			args: [
				"run",
				staged ? "draft:cascade:staged" : "draft:cascade",
				"--",
				`--base=${options.base}`,
			],
			reason:
				"changed technical/exp proofs must cascade into referencing epic/project rollups",
		});
	}

	if (files.some((file) => /^\.(claude|agents)\/skills\//u.test(file))) {
		checks.push({
			command: "pnpm",
			args: ["run", "skills:mirror-check"],
			reason:
				"repo-local skill mirrors must stay byte-identical across .claude and .agents",
		});
	}

	if (
		files.some(
			(file) =>
				/^(?:tools\/oxlint\/anti-slop|\.(?:claude|agents)\/skills\/install-anti-slop\/assets\/anti-slop)\//u.test(
					file,
				) || file === "scripts/test/anti-slop-vendor.test.ts",
		)
	) {
		checks.push({
			command: "node",
			args: [
				"--import",
				"tsx",
				"--test",
				"scripts/test/anti-slop-vendor.test.ts",
			],
			reason:
				"vendored anti-slop copies must match their SHA-256 manifests and each other (ADR-0173)",
		});
	}

	if (
		files.some(
			(file) =>
				file === "scripts/ci/gitleaks-main-scan.mts" ||
				file === "scripts/test/gitleaks-main-scan.test.ts" ||
				file === ".github/workflows/hobo-ci.yml",
		)
	) {
		checks.push({
			command: "node",
			args: [
				"--import",
				"tsx",
				"--test",
				"scripts/test/gitleaks-main-scan.test.ts",
			],
			reason:
				"blobless main-gate gitleaks must write an exit file and bound the wait (finding 75)",
		});
	}

	// The guards on signed local runs must run on the changes they guard: the
	// workflows that skip jobs for one, the verifier, the trusted keys, the
	// description a local run executes, and the lint that pins all of it.
	if (files.some(guardsSignedLocalRuns)) {
		checks.push({
			command: "node",
			args: ["--import", "tsx", "--test", ...SIGNED_LOCAL_RUN_TESTS],
			reason:
				"signed local runs: the verifier, the trusted keys, the gate's decision table and the job conditions must hold",
		});
		checks.push({
			command: "pnpm",
			args: ["run", "actions:lint"],
			reason:
				"signed local runs: only a covered job may be skipped for one, and a gate must read the route job's result",
		});
	}

	if (
		files.some(
			(file) =>
				file === "scripts/lib/read-stdin.mts" ||
				file === "scripts/test/read-stdin.test.ts" ||
				file === "scripts/test/job-scope.test.ts" ||
				file === "scripts/ci/job-scope.mts" ||
				file === "scripts/ci/dependent-tests.mts" ||
				file === "scripts/ci/impact-classifier.mts",
		)
	) {
		checks.push({
			command: "node",
			args: [
				"--import",
				"tsx",
				"--test",
				"scripts/test/read-stdin.test.ts",
				"scripts/test/job-scope.test.ts",
			],
			reason:
				"changed-path stdin readers must keep surviving a late writer on a non-blocking pipe (EAGAIN)",
		});
	}

	if (
		files.some(
			(file) =>
				file === "external/ts-autocode" ||
				file === "pnpm-workspace.yaml" ||
				file === "tools/pins/siblings.json" ||
				file === "scripts/test/ts-autocode-consumer-surface.test.ts" ||
				file === "scripts/test/ts-autocode-grounding-drift.test.ts" ||
				GROUNDING_DRIFT_INPUTS.has(file) ||
				(PACKAGE_TYPESCRIPT.test(file) && importsTsAutocode(file)),
		)
	) {
		checks.push({
			command: "node",
			args: [
				"--import",
				"tsx",
				"--test",
				"scripts/test/ts-autocode-consumer-surface.test.ts",
				"scripts/test/ts-autocode-grounding-drift.test.ts",
			],
			reason:
				"every name HoBo imports from ts-autocode must still be exported at the pinned commit, and the grounding fields @hobo/runtime registers must still be checked against it (ADR-0128)",
		});
	}

	if (uiChanged) {
		checks.push({
			command: "pnpm",
			args: ["run", "test:dom"],
			reason: "UI rendered-state lane for component/browser-surface changes",
		});
		checks.push({
			command: "pnpm",
			args: ["run", "test:component"],
			reason: "component behavior lane uses mocked service boundaries",
		});
	}

	if (behaviorChanged) {
		checks.push({
			command: "pnpm",
			args: [
				"exec",
				"turbo",
				"run",
				"build",
				"--filter={./src/draft/epic-proofs/*}^...",
				"--filter={./src/draft/projects/*}^...",
				"--output-logs=new-only",
				"--concurrency=100%",
			],
			reason:
				"behavior steps import the proofs' workspace dependencies from dist, which a scoped run has not built",
			serial: true,
		});
		checks.push({
			command: "pnpm",
			args: ["run", "test:behavior"],
			reason: "browser-driven behavior specs; never full-stack E2E",
		});
	}
	if (visualChanged)
		checks.push({
			command: "pnpm",
			args: ["run", "test:visual"],
			reason: "visual/story state changed",
		});
	const propertyOracleChanged = touchedAny([
		/^packages\/bindles\/src\/manifest\//u,
		/^packages\/control-api\/src\//u,
	]);
	if (propertyOracleChanged && !workspaces.includes("packages/fuzz")) {
		checks.push({
			command: "pnpm",
			args: ["run", "test:property"],
			reason:
				"Bindle canonicalization or control-api surface changed; run bounded fast-check oracles",
		});
	}
	if (agentEvalChanged)
		checks.push({
			command: "pnpm",
			args: ["run", "eval:agent:mock"],
			reason: "agent workflow/eval changed; live evals are manual only",
		});

	if (touched(["scripts", "test", "tests"]) || rootConfigChanged) {
		checks.push({
			command: "pnpm",
			args: ["run", "test:root"],
			reason: "root scripts/tests changed",
		});
		checks.push({
			command: "pnpm",
			args: [
				"exec",
				"turbo",
				"run",
				"typecheck:root",
				"--output-logs=new-only",
				turboConcurrencyArg(),
			],
			reason:
				"root scripts/tests must stay type-clean (turbo builds workspace deps first)",
		});
	}

	// Every test under scripts/test (finding 0144). A staged commit leaves it
	// to the pull request, and CI runs it in the required job scripts-tests.
	if (
		touched(["scripts", "test", ".github"]) &&
		!staged &&
		!options.workspaceTestsCoveredExternally
	) {
		checks.push({
			command: "pnpm",
			args: ["run", "test:scripts"],
			reason:
				"scripts, root tests or workflows changed; the scripts lane gates pull requests",
		});
	}

	if (automationChanged || sourceChanged) {
		checks.push({
			command: "pnpm",
			args: staged
				? ["run", "standards:check", "--", "--staged", `--base=${options.base}`]
				: ["run", "standards:check", "--", `--base=${options.base}`],
			reason: "technical standards evidence may need refreshing",
		});
	}

	// Any manifest or lockfile edit can change outbound licence metadata or
	// pull in a dependency whose licence is not on the allowlist.
	if (
		rootConfigChanged ||
		touchedAny([
			/^(packages|examples|site)\/.*package\.json$/u,
			/^(packages|examples)\/.*\/LICENSE$/u,
		])
	) {
		checks.push({
			command: "pnpm",
			args: ["run", "licenses:check"],
			reason:
				"package manifests or dependencies changed; licence metadata must stay compliant",
		});
	}

	if (docsChanged || automationChanged) {
		checks.push({
			command: "pnpm",
			args: [
				"run",
				staged ? "lint:docs:staged" : "lint:docs:changed",
				"--",
				`--base=${options.base}`,
			],
			reason: "markdown docs linters may be affected",
		});
		checks.push({
			command: "pnpm",
			args: ["run", "docs:coverage"],
			reason: "documentation coverage may be affected",
		});
		checks.push({
			command: "pnpm",
			args: ["run", "plans:guard"],
			reason: "plans are working documents and are never committed",
		});
		checks.push({
			command: "pnpm",
			args: ["run", "docs:findings", "--", "--check"],
			reason:
				"CI performance findings and their generated index must stay valid",
		});
	}

	// Google DESIGN.md visual contract for every web UI package (site + future apps).
	// Pre-commit routes here via check:relevant:staged when UI/DESIGN.md changes.
	if (designMdChanged || automationChanged) {
		checks.push({
			command: "pnpm",
			args: ["run", "design:lint"],
			reason:
				"web UI or DESIGN.md changed; Google designmd lint must pass for all web UI projects",
		});
	}

	if (sourceChanged || automationChanged) {
		checks.push({
			command: "pnpm",
			args: staged
				? ["run", "docs:freshness:staged"]
				: ["run", "docs:freshness", "--", `--base=${options.base}`],
			reason: "docs freshness gate for code/config changes",
		});
	}
	if (traceabilityChanged)
		checks.push({
			command: "node",
			args: ["--import", "tsx", "scripts/validate-traceability.ts"],
			reason: "traceability evidence changed",
		});
	if (deploymentDeltaChanged)
		checks.push({
			command: "node",
			args: ["--import", "tsx", "scripts/validate-deployment-set-delta.ts"],
			reason: "deployment delta proof changed",
		});
	if (optimizexpChanged)
		checks.push({
			command: "pnpm",
			args: ["run", "optimizexp:check"],
			reason:
				"OptimizeXP personas/features/bus or its gate changed; drift-protection lane",
		});
	if (includeBuild) {
		checks.push({
			command: "pnpm",
			args: [
				"exec",
				"turbo",
				"run",
				"build",
				"typecheck",
				"lint",
				"test",
				"--filter=[HEAD^...HEAD]",
				turboConcurrencyArg(),
			],
			reason: "explicit build-impact check requested",
		});
	}

	const scopes = [
		schemaChanged && "schema",
		pactChanged && "contract",
		uiChanged && "ui",
		designMdChanged && "design-md",
		behaviorChanged && "behavior",
		visualChanged && "visual",
		agentEvalChanged && "agent-eval",
		optimizexpChanged && "optimizexp",
		docsChanged && "docs",
		automationChanged && "automation",
	].filter((scope): scope is string => Boolean(scope));

	return { checks, scopes, workspaces };
}
