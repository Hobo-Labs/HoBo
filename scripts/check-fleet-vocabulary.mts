#!/usr/bin/env node
/**
 * `pnpm run fleet:vocabulary` (O1, ADR-0182): one implementation of each fleet
 * idea. Nine rules, each over its own pathspecs and less its allowlist
 * (`scripts/fleet-vocabulary-allow.json`, entries `{ rule, path, reason }`;
 * adding one is a coordinator amendment):
 *
 * 1. an import of, or a dependency on, `@nats-io/*`;
 * 2. an import of, or a dependency on, `@number0/iroh`;
 * 3. a declaration named after a fleet-owned function (names only: a renamed
 *    copy is a review finding, not a rule finding);
 * 4. a protobuf `message` named after a fleet record;
 * 5. an identifier containing `InternalMesh`, `INTERNAL_MESH` or `internalMesh`;
 * 6. a removed environment variable name;
 * 7. a path a lane deletes that still exists;
 * 8. an import specifier `@hobo/backend-fleet` or `@hobo/ci/mesh`;
 * 9. an exported name starting with `Fleet`, `fleet` or `FLEET_` outside the
 *    fleet packages.
 *
 * The guard, its allowlist, its test and its fixtures are never scanned, nor
 * is anything under `docs/` or `site/`.
 *
 *   node --import tsx scripts/check-fleet-vocabulary.mts [--root=<dir>] [--json]
 *
 * `--root` points the guard at another tree, which is how its tests show it a
 * tree that breaks each rule (the pattern of `check-package-boundaries.mts`).
 * Exits 1 when any rule finds something.
 */
import {
	existsSync,
	type Dirent,
	readdirSync,
	readFileSync,
	statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { importSpecifiersOf } from "./lib/test-import-specifiers.mts";

const scriptsDir = dirname(fileURLToPath(import.meta.url));

export interface VocabularyFinding {
	readonly rule: number;
	/** Repository-relative path, `/`-separated. */
	readonly path: string;
	readonly line: number;
	/** The offending name, specifier or path. */
	readonly name: string;
	readonly detail: string;
}

interface AllowEntry {
	readonly rule: number;
	readonly path: string;
	readonly reason: string;
}

/** Never scanned by any rule. */
const NEVER_SCANNED = [
	"scripts/check-fleet-vocabulary.mts",
	"scripts/fleet-vocabulary-allow.json",
	"scripts/test/check-fleet-vocabulary.test.ts",
	"scripts/test/fixtures/fleet-vocabulary/**",
	"docs/**",
	"site/**",
] as const;

/** Directories no rule looks inside. */
const SKIPPED_DIRECTORIES = new Set([
	"node_modules",
	".git",
	"dist",
	".turbo",
	"coverage",
]);

const CODE = /\.(?:[cm]?[jt]s|[jt]sx)$/u;

const RULE_3_NAMES = new Set([
	"verifyDpopProof",
	"mintDpopProof",
	"jwkThumbprint",
	"signEnvelope",
	"verifyEnvelope",
	"rankMembers",
	"rankNodes",
	"claimTurn",
	"proposeAssignment",
	"resolveAssignment",
]);

const RULE_4_MESSAGES = new Set([
	"MemberRecord",
	"FleetRecord",
	"Observation",
	"Assignment",
	"WorkOffer",
	"WorkOrder",
	"Claim",
	"SessionGrant",
]);

const RULE_5 = /InternalMesh|INTERNAL_MESH|internalMesh/u;

/** The removed environment variables of the surfaces section (§6.15). */
const RULE_6 =
	/\b(?:HOBO_CI_MESH_[A-Z0-9_]*|HOBO_CI_NATS_[A-Z0-9_]*|HOBO_CI_FLEET_CAPACITY[A-Z0-9_]*|HOBO_CI_FLEET_STATE|HOBO_CI_FLEET_ROUTES|HOBO_CI_LOCAL_RUNNER|HOBO_CI_LOCAL_REPOSITORY|HOBO_CI_LOCAL_TRUSTED|HOBO_TAILSCALE_AUTHKEY)\b/gu;

/** Every `deletes` path of the workflow manifest (§11.5), held as data. */
const RULE_7_DELETES = [
	"packages/connectivity/src/crypto/dpop.ts",
	"packages/connectivity/src/crypto/jwt-svid.ts",
	"packages/ci/src/mesh/**",
	"packages/ci/src/fleet/**",
	"packages/ci/src/fleet-overflow.ts",
	"packages/ci/scripts/fleet-docs.ts",
	"packages/hobo/src/ci-mesh-status.ts",
	"packages/hobo/test/bare-metal-mesh.test.ts",
	"packages/backend-routing/src/assignment.ts",
	"packages/backend-routing/src/ephemeral-replica.ts",
	"packages/backend-routing/src/backend.ts",
	"packages/backend-routing/test/ephemeral-replica.test.ts",
	"packages/backend-routing/test/fixtures.ts",
	"packages/backend-routing/test/replica-pact.test.ts",
	"packages/backend-routing/test/replica-pact.ts",
	"packages/backend-routing/contracts/ephemeral-assignment-replica.pact.json",
	"packages/data-postgres/src/fleet/policy.ts",
	"packages/data-postgres/test/fleet-assignment.test.ts",
	"scripts/ci/load-fleet-capacity.mts",
	"packages/ci-gh-actions/src/mesh-nats.ts",
	"packages/ci-gh-actions/src/mesh-records.ts",
	"packages/ci-gh-actions/src/mesh-nodes-reader.ts",
	"packages/ci-gh-actions/src/mesh-node.ts",
	"packages/ci-gh-actions/src/mesh-join.ts",
	"packages/ci-gh-actions/src/mesh-worker.ts",
	"packages/ci-gh-actions/src/fleet-state.ts",
	"packages/ci-gh-actions/src/fleet-capacity.ts",
	"packages/ci-gh-actions/src/fleet-routes.ts",
	"packages/ci-gh-actions/src/fleet-absorb.ts",
	"packages/ci-gh-actions/src/local-runner.ts",
	"packages/ci-gh-actions/scripts/local-runner.ts",
	"packages/ci-gh-actions/scripts/mesh-trust.mts",
	"packages/ci-gh-actions/scripts/mesh-demo.mts",
	"packages/ci-gh-actions/data-models/mesh.proto",
	"packages/ci-gh-actions/src/_generated/mesh_pb.ts",
] as const;

const RULE_9 = /^(?:Fleet|fleet|FLEET_)/u;

interface Rule {
	readonly rule: number;
	readonly pathspecs: readonly string[];
	readonly except?: readonly string[];
}

const IMPORT_PATHSPECS = [
	"packages/*/src/**",
	"packages/*/test/**",
	"packages/*/package.json",
	"scripts/**",
] as const;

const RULES: readonly Rule[] = [
	{ rule: 1, pathspecs: IMPORT_PATHSPECS },
	{ rule: 2, pathspecs: IMPORT_PATHSPECS },
	{ rule: 3, pathspecs: ["packages/*/src/**", "scripts/**"] },
	{ rule: 4, pathspecs: ["packages/**/*.proto"] },
	{
		rule: 5,
		pathspecs: ["packages/*/src/**", "packages/*/test/**", "scripts/**"],
	},
	{
		rule: 6,
		pathspecs: [
			"packages/*/src/**",
			"packages/*/test/**",
			"packages/*/scripts/**",
			"scripts/**",
			".github/**",
			".devcontainer/**",
			"deploy/**",
		],
	},
	{ rule: 8, pathspecs: [...IMPORT_PATHSPECS, ".github/**"] },
	{
		rule: 9,
		pathspecs: ["packages/*/src/**", "scripts/**"],
		except: ["packages/fleet*/**"],
	},
];

const globCache = new Map<string, RegExp>();

/** Whether a `/`-separated relative path matches a pathspec glob (`*` one segment, `**` any depth). */
export function matchesGlob(path: string, glob: string): boolean {
	let pattern = globCache.get(glob);
	if (pattern === undefined) {
		let source = "";
		for (let index = 0; index < glob.length; index += 1) {
			const char = glob[index];
			if (glob.startsWith("**/", index)) {
				source += "(?:.*/)?";
				index += 2;
			} else if (glob.startsWith("/**", index) && index + 3 === glob.length) {
				source += "(?:/.*)?";
				index += 2;
			} else if (glob.startsWith("**", index)) {
				source += ".*";
				index += 1;
			} else if (char === "*") source += "[^/]*";
			else source += (char ?? "").replace(/[.+?^${}()|[\]\\]/gu, "\\$&");
		}
		pattern = new RegExp(`^${source}$`, "u");
		globCache.set(glob, pattern);
	}
	return pattern.test(path);
}

function walk(root: string, relative: string, out: string[]): void {
	let entries: Dirent[];
	try {
		entries = readdirSync(join(root, relative), { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
		if (NEVER_SCANNED.some((glob) => matchesGlob(path, glob))) continue;
		if (entry.isDirectory()) {
			if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
			walk(root, path, out);
		} else if (entry.isFile()) out.push(path);
	}
}

function loadAllowlist(file: string): readonly AllowEntry[] {
	// SAFETY: the guard's own allowlist file, a JSON array of { rule, path, reason }.
	return JSON.parse(readFileSync(file, "utf8")) as AllowEntry[];
}

function lineOf(text: string, offset: number): number {
	let line = 1;
	for (let index = 0; index < offset && index < text.length; index += 1)
		if (text.charCodeAt(index) === 10) line += 1;
	return line;
}

function scriptKind(path: string): ts.ScriptKind {
	if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
	if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
	if (/\.[cm]?js$/u.test(path)) return ts.ScriptKind.JS;
	return ts.ScriptKind.TS;
}

function parse(path: string, text: string): ts.SourceFile {
	return ts.createSourceFile(
		path,
		text,
		ts.ScriptTarget.Latest,
		true,
		scriptKind(path),
	);
}

function isNatsSpecifier(specifier: string): boolean {
	return specifier.startsWith("@nats-io/");
}

function isIrohSpecifier(specifier: string): boolean {
	return (
		specifier === "@number0/iroh" || specifier.startsWith("@number0/iroh/")
	);
}

function isRetiredSpecifier(specifier: string): boolean {
	return [
		/^@hobo\/backend-fleet(?:\/.*)?$/u,
		/^@hobo\/ci\/mesh(?:\/.*)?$/u,
	].some((pattern) => pattern.test(specifier));
}

const RETIRED_TEXT =
	/(?<![\w@/.-])@hobo\/(?:backend-fleet|ci\/mesh)(?![\w-])/gu;

type DependencyMap = Readonly<Record<string, string>>;

function dependenciesOf(text: string): string[] {
	try {
		// SAFETY: a package.json read at this I/O boundary; only its dependency maps are read.
		const manifest = JSON.parse(text) as Readonly<
			Record<string, DependencyMap | undefined>
		>;
		return [
			"dependencies",
			"devDependencies",
			"peerDependencies",
			"optionalDependencies",
		].flatMap((field) => Object.keys(manifest[field] ?? {}));
	} catch {
		return [];
	}
}

function declarationNames(
	source: ts.SourceFile,
): Array<{ name: string; node: ts.Node }> {
	const found: Array<{ name: string; node: ts.Node }> = [];
	const nameOf = (name: ts.Node | undefined): string | undefined =>
		name !== undefined &&
		(ts.isIdentifier(name) ||
			ts.isStringLiteral(name) ||
			ts.isPrivateIdentifier(name))
			? name.text
			: undefined;
	const isFunctionLike = (node: ts.Node | undefined): boolean =>
		node !== undefined &&
		(ts.isArrowFunction(node) || ts.isFunctionExpression(node));
	const visit = (node: ts.Node): void => {
		let name: string | undefined;
		if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node))
			name = nameOf(node.name);
		else if (ts.isVariableDeclaration(node)) name = nameOf(node.name);
		else if (
			(ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) &&
			isFunctionLike(node.initializer)
		)
			name = nameOf(node.name);
		if (name !== undefined) found.push({ name, node });
		ts.forEachChild(node, visit);
	};
	visit(source);
	return found;
}

function hasExport(node: ts.Node): boolean {
	return (
		ts.canHaveModifiers(node) &&
		(ts.getModifiers(node) ?? []).some(
			(modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
		)
	);
}

function bindingNames(name: ts.BindingName): string[] {
	if (ts.isIdentifier(name)) return [name.text];
	return name.elements.flatMap((element) =>
		ts.isOmittedExpression(element) ? [] : bindingNames(element.name),
	);
}

function exportedNames(
	source: ts.SourceFile,
): Array<{ name: string; node: ts.Node }> {
	const found: Array<{ name: string; node: ts.Node }> = [];
	for (const statement of source.statements) {
		if (
			(ts.isFunctionDeclaration(statement) ||
				ts.isClassDeclaration(statement) ||
				ts.isInterfaceDeclaration(statement) ||
				ts.isTypeAliasDeclaration(statement) ||
				ts.isEnumDeclaration(statement)) &&
			hasExport(statement) &&
			statement.name !== undefined
		)
			found.push({ name: statement.name.text, node: statement });
		else if (ts.isVariableStatement(statement) && hasExport(statement))
			for (const declaration of statement.declarationList.declarations)
				for (const name of bindingNames(declaration.name))
					found.push({ name, node: declaration });
		else if (
			ts.isExportDeclaration(statement) &&
			statement.exportClause !== undefined &&
			ts.isNamedExports(statement.exportClause)
		)
			for (const element of statement.exportClause.elements)
				found.push({ name: element.name.text, node: element });
	}
	return found;
}

function identifiers(
	source: ts.SourceFile,
): Array<{ name: string; node: ts.Node }> {
	const found: Array<{ name: string; node: ts.Node }> = [];
	const visit = (node: ts.Node): void => {
		if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node))
			found.push({ name: node.text, node });
		ts.forEachChild(node, visit);
	};
	visit(source);
	return found;
}

/** Every finding of the nine rules over the tree at `root`, less the allowlist. */
export function scanVocabulary(
	root: string,
	allowlistFile: string = join(scriptsDir, "fleet-vocabulary-allow.json"),
): VocabularyFinding[] {
	const allow = loadAllowlist(allowlistFile);
	const files: string[] = [];
	for (const top of [
		"packages",
		"scripts",
		".github",
		".devcontainer",
		"deploy",
	])
		walk(root, top, files);
	files.sort();

	const findings: VocabularyFinding[] = [];
	const allowed = (rule: number, path: string): boolean =>
		allow.some((entry) => entry.rule === rule && matchesGlob(path, entry.path));
	const inScope = (rule: Rule, path: string): boolean =>
		rule.pathspecs.some((glob) => matchesGlob(path, glob)) &&
		!(rule.except ?? []).some((glob) => matchesGlob(path, glob)) &&
		!allowed(rule.rule, path);

	for (const path of files) {
		const scopes = new Set(
			RULES.filter((rule) => inScope(rule, path)).map((rule) => rule.rule),
		);
		if (scopes.size === 0) continue;
		const absolute = join(root, path);
		if (statSync(absolute).size > 4 * 1024 * 1024) continue;
		const text = readFileSync(absolute, "utf8");
		if (text.includes("\u0000")) continue;
		const code = CODE.test(path);
		const manifest = path.endsWith("/package.json");
		let parsed: ts.SourceFile | undefined;
		const source = (): ts.SourceFile => {
			parsed ??= parse(path, text);
			return parsed;
		};
		const addAt = (
			rule: number,
			offset: number,
			name: string,
			detail: string,
		): void => {
			findings.push({ rule, path, line: lineOf(text, offset), name, detail });
		};
		const addNode = (
			rule: number,
			node: ts.Node,
			name: string,
			detail: string,
		): void => {
			const start = node.getStart(source());
			addAt(rule, start, name, detail);
		};

		// Rules 1, 2, 8: imports and dependencies.
		const specifierRules: Array<[number, (s: string) => boolean, string]> = [
			[1, isNatsSpecifier, "@nats-io/"],
			[2, isIrohSpecifier, "@number0/iroh"],
			[8, isRetiredSpecifier, "@hobo/"],
		];
		for (const [rule, matches, needle] of specifierRules) {
			if (!scopes.has(rule) || !text.includes(needle)) continue;
			if (code) {
				for (const { specifier } of importSpecifiersOf(text, path))
					if (matches(specifier))
						addAt(
							rule,
							text.indexOf(specifier),
							specifier,
							`imports ${specifier}`,
						);
			} else if (rule === 8) {
				for (const match of text.matchAll(RETIRED_TEXT))
					addAt(rule, match.index ?? 0, match[0], `names ${match[0]}`);
			} else if (manifest) {
				for (const dependency of dependenciesOf(text))
					if (matches(dependency))
						addAt(
							rule,
							text.indexOf(`"${dependency}"`),
							dependency,
							`depends on ${dependency}`,
						);
			}
		}

		// Rule 3: declarations named after a fleet-owned function.
		if (
			scopes.has(3) &&
			code &&
			[...RULE_3_NAMES].some((name) => text.includes(name))
		)
			for (const { name, node } of declarationNames(source()))
				if (RULE_3_NAMES.has(name))
					addNode(
						3,
						node,
						name,
						`declares ${name}, which only @hobo/fleet may implement`,
					);

		// Rule 4: protobuf messages named after a fleet record.
		if (scopes.has(4) && path.endsWith(".proto")) {
			const stripped = text.replace(/\/\/[^\n]*/gu, (comment) =>
				" ".repeat(comment.length),
			);
			for (const match of stripped.matchAll(/\bmessage\s+([A-Za-z_]\w*)/gu)) {
				const name = match[1] ?? "";
				if (RULE_4_MESSAGES.has(name))
					addAt(
						4,
						match.index ?? 0,
						name,
						`declares message ${name}, a fleet record`,
					);
			}
		}

		// Rule 5: identifiers naming the internal mesh.
		if (scopes.has(5) && RULE_5.test(text)) {
			if (code) {
				for (const { name, node } of identifiers(source()))
					if (RULE_5.test(name)) addNode(5, node, name, `identifier ${name}`);
			} else {
				for (const match of text.matchAll(/[A-Za-z_$][\w$]*/gu))
					if (RULE_5.test(match[0]))
						addAt(5, match.index ?? 0, match[0], `identifier ${match[0]}`);
			}
		}

		// Rule 6: removed environment variables.
		if (scopes.has(6))
			for (const match of text.matchAll(RULE_6))
				addAt(
					6,
					match.index ?? 0,
					match[0],
					`names removed variable ${match[0]}`,
				);

		// Rule 9: exported fleet-prefixed names outside the fleet packages.
		if (scopes.has(9) && code && /\b(?:Fleet|fleet|FLEET_)/u.test(text))
			for (const { name, node } of exportedNames(source()))
				if (RULE_9.test(name))
					addNode(9, node, name, `exports ${name} outside the fleet packages`);
	}

	// Rule 7: a deleted path that still exists.
	for (const entry of RULE_7_DELETES) {
		const path = entry.replace(/\/\*\*$/u, "");
		if (allowed(7, path)) continue;
		if (existsSync(join(root, path)))
			findings.push({
				rule: 7,
				path,
				line: 0,
				name: path,
				detail: `${path} is deleted by the fleet work and still exists`,
			});
	}

	return findings.sort(
		(a, b) =>
			a.rule - b.rule || a.path.localeCompare(b.path) || a.line - b.line,
	);
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const args = process.argv.slice(2);
	const rootArg = args
		.find((arg) => arg.startsWith("--root="))
		?.slice("--root=".length);
	const root = rootArg ? resolve(rootArg) : resolve(scriptsDir, "..");
	const findings = scanVocabulary(root);
	if (args.includes("--json"))
		process.stdout.write(`${JSON.stringify({ findings }, null, "\t")}\n`);
	for (const finding of findings)
		process.stderr.write(
			`rule ${finding.rule}: ${finding.path}${finding.line > 0 ? `:${finding.line}` : ""}: ${finding.detail}\n`,
		);
	if (findings.length > 0) {
		process.stderr.write(`fleet:vocabulary: ${findings.length} finding(s)\n`);
		process.exit(1);
	}
	if (!args.includes("--json"))
		process.stdout.write("fleet:vocabulary: no findings\n");
}
