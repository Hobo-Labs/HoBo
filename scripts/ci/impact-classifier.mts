/**
 * Which changed paths are non-meaningful ("inert") for package lanes.
 *
 * A path is inert only under a named rule whose comparison cannot hide a
 * behavior change: identical bytes, canonical-JSON equality, whitespace-only
 * markdown, or a TypeScript token stream unchanged once trivia is dropped
 * (directive comments, JSDoc, shebangs and ASI-significant newlines stay in
 * the stream). Everything else — added/deleted files, unparsable input, a
 * missing base or tokenizer, more than 300 changed paths — is meaningful.
 * Uncertainty always widens to today's behavior: feeding `meaningfulPaths`
 * to `affectedLanes`/`planDependentTests` can only narrow by inert paths,
 * and the workflow runs this in shadow mode (`HOBO_IMPACT_GATE=shadow`,
 * the default) where the classification changes nothing and only reports.
 * Shadow-only is load-bearing: some suites scan raw source text (design
 * lint, redaction walks), so a token-inert change can still fail them.
 * Enforcement needs those scan roots modeled first; until then nothing
 * consumes this output. A change to the classifier or its wiring always
 * classifies every path meaningful.
 *
 * Node builtins only. The token-stream rule needs the `typescript` package
 * (already a root dependency); when it cannot be loaded — the pre-install
 * path — code files stay meaningful and the JSON/markdown rules still run.
 *
 * CLI: `git diff --name-only BASE...HEAD | node --experimental-strip-types
 * scripts/ci/impact-classifier.mts --base=BASE [--meaningful-out=FILE]`
 * prints the classification as JSON and a shadow summary on stderr.
 * Omitting `--base` retains fail-closed behavior (every path meaningful).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import process from "node:process";
import {
	affectedLanes,
	type AffectedLanes,
	cliRootFileReader,
} from "./affected-lanes.mts";

/** Base/head file contents, injectable so tests can run in memory. */
export type ReadVersions = (
	path: string,
	side: "base" | "head",
) => string | undefined;

export type InertRule =
	| "identical"
	| "json-canonical"
	| "markdown-whitespace"
	| "code-trivia";

export type FileImpact = Readonly<{
	path: string;
	meaningful: boolean;
	/** The rule that proved the path inert; absent when meaningful. */
	rule?: InertRule;
}>;

export type ImpactClassification = Readonly<{
	/** Paths no inert rule proved safe to drop. */
	meaningfulPaths: readonly string[];
	inert: readonly FileImpact[];
	/** A scripts/ or test/ file changed at the byte level: biome's format
	 * gate reads bytes, so inert never implies unformatted. */
	formatCheck: boolean;
	/** The code-trivia rule ran (a tokenizer was available). */
	tokenizer: boolean;
	reason?: string;
}>;

/** Hash of a file's trivia-insensitive token stream; undefined = cannot prove. */
export type CodeTokenizer = (path: string, text: string) => string | undefined;

const CODE_PATH = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const MAX_PATHS = 300;

/**
 * Parsed JSON re-serialized. Key order is preserved on purpose: it is
 * observable data (package.json `exports` conditions resolve first-match,
 * golden manifests pin byte order), so only formatting differences are
 * inert, never a reorder.
 */
function canonicalJson(text: string): string | undefined {
	try {
		const value: unknown = JSON.parse(text);
		return JSON.stringify(value);
	} catch {
		return undefined;
	}
}

const markdownKey = (text: string): string => text.replace(/\s+/g, " ").trim();

function classifyOne(
	path: string,
	read: ReadVersions,
	tokenize: CodeTokenizer | undefined,
): FileImpact {
	const meaningful: FileImpact = { path, meaningful: true };
	if (path.split("/").some((part) => part === ".." || part === "."))
		return meaningful;
	const base = read(path, "base");
	const head = read(path, "head");
	if (base === undefined || head === undefined) return meaningful;
	if (base === head) return { path, meaningful: false, rule: "identical" };
	if (path.endsWith(".json")) {
		const sortedBase = canonicalJson(base);
		const sortedHead = canonicalJson(head);
		return sortedBase !== undefined && sortedBase === sortedHead
			? { path, meaningful: false, rule: "json-canonical" }
			: meaningful;
	}
	if (path.endsWith(".md"))
		return markdownKey(base) === markdownKey(head)
			? { path, meaningful: false, rule: "markdown-whitespace" }
			: meaningful;
	if (CODE_PATH.test(path) && tokenize) {
		const baseKey = tokenize(path, base);
		const headKey = tokenize(path, head);
		return baseKey !== undefined && baseKey === headKey
			? { path, meaningful: false, rule: "code-trivia" }
			: meaningful;
	}
	return meaningful;
}

export function classifyImpact(
	paths: readonly string[],
	read: ReadVersions,
	tokenize?: CodeTokenizer,
): ImpactClassification {
	const changed = paths
		.map((path) => path.trim())
		.filter((path) => path !== "");
	const formatCheck = changed.some(
		(path) => path.startsWith("scripts/") || path.startsWith("test/"),
	);
	if (changed.length > MAX_PATHS)
		return {
			meaningfulPaths: changed,
			inert: [],
			formatCheck,
			tokenizer: tokenize !== undefined,
			reason: `diff too large to classify (${changed.length} paths)`,
		};
	const selfChange = changed.find((path) => SELF_PATHS.has(path));
	if (selfChange !== undefined)
		return {
			meaningfulPaths: changed,
			inert: [],
			formatCheck,
			tokenizer: tokenize !== undefined,
			reason: `classifier self-change: ${selfChange}`,
		};
	const impacts = changed.map((path) => classifyOne(path, read, tokenize));
	return {
		meaningfulPaths: impacts
			.filter((impact) => impact.meaningful)
			.map((impact) => impact.path),
		inert: impacts.filter((impact) => !impact.meaningful),
		formatCheck,
		tokenizer: tokenize !== undefined,
	};
}

export type ShadowComparison = Readonly<{
	current: AffectedLanes;
	proposed: AffectedLanes;
	/** Inert paths the proposal drops, each explained by its rule. */
	dropped: readonly FileImpact[];
	/** Paths dropped without an inert rule. Must always be empty. */
	unexplained: readonly string[];
}>;

/**
 * Today's lanes against the lanes for the meaningful paths only. An
 * all-inert diff proposes `skip` (an empty path list would otherwise widen
 * to `all` in `affectedLanes`); an empty diff stays fail-closed.
 */
export function shadowLanes(
	paths: readonly string[],
	classification: ImpactClassification,
	lanes: (paths: readonly string[]) => AffectedLanes = (changed) =>
		affectedLanes(changed),
): ShadowComparison {
	const changed = paths
		.map((path) => path.trim())
		.filter((path) => path !== "");
	const current = lanes(changed);
	const proposed: AffectedLanes =
		changed.length > 0 && classification.meaningfulPaths.length === 0
			? { mode: "skip", reason: "every changed path is inert" }
			: lanes(classification.meaningfulPaths);
	const meaningful = new Set(classification.meaningfulPaths);
	const inertPaths = new Set(classification.inert.map((file) => file.path));
	return {
		current,
		proposed,
		dropped: classification.inert,
		unexplained: changed.filter(
			(path) => !meaningful.has(path) && !inertPaths.has(path),
		),
	};
}

/** The slice of the TypeScript compiler API the tokenizer needs. */
type TypescriptLike = Readonly<{
	ScriptTarget: Readonly<Record<string, number>>;
	LanguageVariant: Readonly<Record<string, number>>;
	ScriptKind: Readonly<Record<string, number>>;
	SyntaxKind: Readonly<Record<string, number>>;
	createScanner: (
		target: number,
		skipTrivia: boolean,
		variant: number,
		text: string,
	) => Readonly<{
		scan: () => number;
		getTokenText: () => string;
		getTextPos: () => number;
	}>;
	createSourceFile: (
		path: string,
		text: string,
		target: number,
		setParentNodes: boolean,
		kind: number,
	) => Readonly<{ parseDiagnostics?: readonly unknown[] }>;
}>;

const DIRECTIVE_COMMENT =
	/@ts-(?:ignore|expect-error|nocheck)|biome-ignore|eslint|oxlint|prettier-ignore|istanbul ignore|c8 ignore|@__PURE__|@__NO_SIDE_EFFECTS__|vite-ignore|webpackIgnore|sourceMappingURL|^\/{2,}\s*<reference/u;

/**
 * Paths whose own change must run under today's behavior, never under a
 * classification the change itself could have rigged.
 */
const SELF_PATHS = new Set([
	"scripts/ci/impact-classifier.mts",
	"scripts/ci/affected-lanes.mts",
	"scripts/ci/dependent-tests.mts",
	"scripts/ci/job-scope.mts",
	".github/workflows/hobo-ci.yml",
]);

/**
 * Trivia-insensitive token-stream hash. Two versions hash equal only when
 * they tokenize identically outside whitespace and plain comments: string,
 * template and regex literal text is hashed, directive comments and JSDoc
 * are kept, a newline after `return`/`throw`/`break`/`continue`/`yield`
 * or before `++`/`--` is significant (ASI), and either side failing to
 * parse proves nothing.
 */
export function typescriptTokenizer(ts: TypescriptLike): CodeTokenizer {
	const kind = (name: string): number => ts.SyntaxKind[name] ?? -1;
	const trivia = new Set(
		[
			"WhitespaceTrivia",
			"NewLineTrivia",
			"SingleLineCommentTrivia",
			"MultiLineCommentTrivia",
			"ShebangTrivia",
			"ConflictMarkerTrivia",
		].map(kind),
	);
	const comments = new Set(
		["SingleLineCommentTrivia", "MultiLineCommentTrivia"].map(kind),
	);
	const asiAfter = new Set(
		[
			"ReturnKeyword",
			"ThrowKeyword",
			"BreakKeyword",
			"ContinueKeyword",
			"YieldKeyword",
		].map(kind),
	);
	const newline = kind("NewLineTrivia");
	const shebang = kind("ShebangTrivia");
	const conflict = kind("ConflictMarkerTrivia");
	const endOfFile = kind("EndOfFileToken");
	const plusPlus = kind("PlusPlusToken");
	const minusMinus = kind("MinusMinusToken");
	return (path, text) => {
		try {
			const scriptKind = path.endsWith(".tsx")
				? (ts.ScriptKind.TSX ?? 0)
				: path.endsWith(".jsx")
					? (ts.ScriptKind.JSX ?? 0)
					: /\.[cm]?js$/u.test(path)
						? (ts.ScriptKind.JS ?? 0)
						: (ts.ScriptKind.TS ?? 0);
			const parsed = ts.createSourceFile(
				path,
				text,
				ts.ScriptTarget.Latest ?? 99,
				false,
				scriptKind,
			);
			if ((parsed.parseDiagnostics?.length ?? 0) > 0) return undefined;
			const scanner = ts.createScanner(
				ts.ScriptTarget.Latest ?? 99,
				false,
				path.endsWith("x")
					? (ts.LanguageVariant.JSX ?? 1)
					: (ts.LanguageVariant.Standard ?? 0),
				text,
			);
			const parts: string[] = [];
			let previous = -1;
			let sawNewline = false;
			let lastPos = -1;
			// Every scan must advance; a stuck scanner proves nothing.
			for (let guard = text.length * 2 + 100; guard > 0; guard--) {
				const token = scanner.scan();
				if (token === endOfFile)
					return createHash("sha256").update(parts.join("\0")).digest("hex");
				if (token === conflict) return undefined;
				const pos = scanner.getTextPos();
				if (pos <= lastPos) return undefined;
				lastPos = pos;
				const tokenText = scanner.getTokenText();
				if (token === newline) sawNewline = true;
				if (trivia.has(token)) {
					if (token === shebang) parts.push(`#!${tokenText}`);
					else if (
						comments.has(token) &&
						(tokenText.startsWith("/**") || DIRECTIVE_COMMENT.test(tokenText))
					)
						parts.push(`C:${token}:${tokenText}`);
					continue;
				}
				const asi =
					sawNewline &&
					(asiAfter.has(previous) || token === plusPlus || token === minusMinus)
						? "N"
						: "";
				parts.push(`${asi}${token}:${tokenText}`);
				previous = token;
				sawNewline = false;
			}
			return undefined;
		} catch {
			return undefined;
		}
	};
}

/** The real tokenizer, or undefined when `typescript` cannot be loaded. */
export function loadTokenizer(): CodeTokenizer | undefined {
	try {
		// SAFETY: the pinned `typescript` package supplies every member of
		// TypescriptLike; a mismatched module throws on first use inside the
		// tokenizer, which fails closed to undefined there.
		const ts = createRequire(import.meta.url)("typescript") as TypescriptLike;
		return typescriptTokenizer(ts);
	} catch {
		return undefined;
	}
}

function cliVersionReader(baseRef: string): ReadVersions {
	let mergeBase = baseRef;
	try {
		mergeBase = execFileSync("git", ["merge-base", baseRef, "HEAD"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		// An unrelated or unavailable history falls back to the ref itself.
	}
	if (mergeBase === "") mergeBase = baseRef;
	return (path, side) => {
		try {
			return side === "head"
				? readFileSync(path, "utf8")
				: execFileSync("git", ["show", `${mergeBase}:${path}`], {
						encoding: "utf8",
						stdio: ["ignore", "pipe", "ignore"],
					});
		} catch {
			return undefined;
		}
	};
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const mode = process.env.HOBO_IMPACT_GATE ?? "shadow";
	const input = readFileSync(0, "utf8");
	const paths = input.split("\n");
	if (mode === "off") {
		console.error("impact-gate: off");
		process.exit(0);
	}
	const baseArgument = process.argv.find((argument) =>
		argument.startsWith("--base="),
	);
	const meaningfulOut = process.argv
		.find((argument) => argument.startsWith("--meaningful-out="))
		?.slice("--meaningful-out=".length);
	const classification: ImpactClassification =
		baseArgument === undefined
			? {
					meaningfulPaths: paths
						.map((path) => path.trim())
						.filter((path) => path !== ""),
					inert: [],
					formatCheck: paths.some(
						(path) => path.startsWith("scripts/") || path.startsWith("test/"),
					),
					tokenizer: false,
					reason: "no --base given",
				}
			: classifyImpact(
					paths,
					cliVersionReader(baseArgument.slice("--base=".length)),
					loadTokenizer(),
				);
	const shadow =
		baseArgument === undefined
			? shadowLanes(paths, classification)
			: shadowLanes(paths, classification, (changed) =>
					affectedLanes(
						changed,
						undefined,
						undefined,
						cliRootFileReader(baseArgument.slice("--base=".length)),
					),
				);
	if (meaningfulOut)
		writeFileSync(
			meaningfulOut,
			classification.meaningfulPaths.length === 0
				? ""
				: `${classification.meaningfulPaths.join("\n")}\n`,
		);
	console.error(
		[
			`impact-gate(${mode}): ${classification.meaningfulPaths.length} meaningful, ${classification.inert.length} inert, formatCheck=${classification.formatCheck}, tokenizer=${classification.tokenizer}`,
			...classification.inert.map(
				(file) => `  inert ${file.path} (${file.rule})`,
			),
			`  lanes: current=${shadow.current.mode} proposed=${shadow.proposed.mode} unexplained=${shadow.unexplained.length}`,
			...(mode === "enforce"
				? ["  enforce is not wired in this slice: execution unchanged"]
				: ["  shadow only: execution unchanged"]),
		].join("\n"),
	);
	process.stdout.write(
		`${JSON.stringify({ mode, ...classification, shadow }, null, 2)}\n`,
	);
}
