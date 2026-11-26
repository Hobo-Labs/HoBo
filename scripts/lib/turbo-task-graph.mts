/**
 * Which packages turbo builds before a package's task, read from the same
 * inputs turbo reads: the root `turbo.json`, a package's own `turbo.json`
 * (`extends: ["//"]`), and the workspace dependencies in each `package.json`.
 *
 * - `"^build"` reaches the `build` of every workspace package named in
 *   `dependencies`, `devDependencies` or `optionalDependencies` with a specifier
 *   turbo orders (`orderedDependency`). Not `peerDependencies`: turbo orders no
 *   task on one.
 * - `"build"` reaches the package's own `build`; `"@s/x#build"` reaches that
 *   package's.
 * - A root `"<pkg>#<task>"` entry replaces the generic `"<task>"` for that
 *   package, and a package's own `turbo.json` replaces that `dependsOn` when it
 *   sets one, unless the list names `"$TURBO_EXTENDS$"`: then turbo appends it
 *   to the inherited list, wherever the marker sits. An override of one task
 *   orders nothing for another.
 * - A task a package has no script for is still a node: turbo follows its
 *   `dependsOn` and runs nothing for it.
 */
const TURBO_EXTENDS = "$TURBO_EXTENDS$";

/** pnpm's link-workspace-packages, as turbo reads it, and why. */
export interface LinkWorkspacePackages {
	readonly enabled: boolean;
	/** Which file sets it, or which default applies. */
	readonly source: string;
}

/** The root files turbo reads link-workspace-packages from; each absent where the file is. */
export interface LinkInputs {
	/** The root `package.json`'s `packageManager`. */
	readonly packageManager?: string | undefined;
	readonly npmrc?: string | undefined;
	readonly workspaceYaml?: string | undefined;
}

function yamlSetting(text: string | undefined): boolean | undefined {
	const match = /^linkWorkspacePackages:[ \t]*(.*?)[ \t]*(?:#.*)?$/mu.exec(
		text ?? "",
	);
	const value = match?.[1];
	if (value === undefined || /^(?:|~|null|Null|NULL)$/u.test(value))
		return undefined;
	if (/^(?:true|True|TRUE)$/u.test(value)) return true;
	if (/^(?:false|False|FALSE)$/u.test(value)) return false;
	// Any other value is a string, and only "deep" turns it on.
	return value.replace(/^(["'])(.*)\1$/u, "$2") === "deep";
}

function npmrcSetting(text: string | undefined): boolean | undefined {
	let setting: boolean | undefined;
	for (const line of (text ?? "").split(/\r?\n/u)) {
		if (/^\s*\[/u.test(line)) break;
		const value = /^\s*link-workspace-packages\s*=\s*(.*?)\s*$/u.exec(
			line,
		)?.[1];
		if (value === "true" || value === "deep") setting = true;
		else if (value === "false") setting = false;
	}
	return setting;
}

/**
 * Whether turbo links a workspace package for a specifier without the
 * `workspace:` protocol, as it decides for pnpm: from pnpm 9,
 * `linkWorkspacePackages` in pnpm-workspace.yaml, else
 * `link-workspace-packages` in .npmrc, else off; before pnpm 9, .npmrc, else
 * on. Read for pnpm only, the package manager this repository names.
 */
export function linkWorkspacePackages(
	inputs: LinkInputs,
): LinkWorkspacePackages {
	const major = /^pnpm@(\d+)\./u.exec(inputs.packageManager ?? "")?.[1];
	const pnpm9 = major === undefined || Number(major) >= 9;
	const yaml = pnpm9 ? yamlSetting(inputs.workspaceYaml) : undefined;
	if (yaml !== undefined)
		return { enabled: yaml, source: "pnpm-workspace.yaml sets it" };
	const npmrc = npmrcSetting(inputs.npmrc);
	if (npmrc !== undefined) return { enabled: npmrc, source: ".npmrc sets it" };
	return pnpm9
		? {
				enabled: false,
				source:
					"the default from pnpm 9; neither pnpm-workspace.yaml nor .npmrc sets it",
			}
		: {
				enabled: true,
				source: "the default before pnpm 9, which reads it from .npmrc only",
			};
}

/** A token of the YAML subset pnpm-workspace.yaml is written in. */
interface YamlToken {
	readonly kind:
		| "scalar"
		| "colon"
		| "open"
		| "close"
		| "comma"
		| "dash"
		| "newline";
	readonly text: string;
	/** Whether a scalar was quoted, so no indicator in it means anything. */
	readonly quoted: boolean;
	/** Where it starts on its line. */
	readonly column: number;
}

/**
 * A YAML construct `catalogValues` does not read: it stops rather than guess
 * what a catalog says.
 */
export class UnreadYaml extends Error {
	constructor(readonly construct: string) {
		super(
			`uses ${construct}, which this check does not read, so it cannot tell whether a catalog names a workspace package`,
		);
		this.name = "UnreadYaml";
	}
}

/**
 * A quoted scalar from `start`, its text and the index after its closing
 * quote. A line break inside it folds, with the next line's indentation, to a
 * space.
 */
function quoted(text: string, start: number): [string, number] {
	const quote = text[start];
	let value = "";
	let i = start + 1;
	while (i < text.length) {
		const char = text[i]!;
		if (char === "\n" || char === "\r") {
			while (i < text.length && /\s/u.test(text[i]!)) i += 1;
			value += " ";
		} else if (quote === "'" && char === "'" && text[i + 1] === "'") {
			value += "'";
			i += 2;
		} else if (quote === '"' && char === "\\" && i + 1 < text.length) {
			value += text[i + 1];
			i += 2;
		} else if (char === quote) return [value, i + 1];
		else {
			value += char;
			i += 1;
		}
	}
	return [value, i];
}

/**
 * The tokens of `text`: scalars (plain, or quoted with their quotes taken
 * off), a mapping's `:`, a flow collection's brackets and commas, a block
 * sequence's `- `, and line ends. A comment is a `#` at a line's start or
 * after a space, outside quotes; a `:` is a mapping's only before a space, a
 * line's end or, in a flow collection, `,`, `}` or `]`.
 */
function yamlTokens(text: string): YamlToken[] {
	const tokens: YamlToken[] = [];
	let flow = 0;
	let lineStart = 0;
	let i = 0;
	const isSpace = (char: string | undefined) =>
		char === undefined ||
		char === " " ||
		char === "\t" ||
		char === "\r" ||
		char === "\n";
	const mapping = (at: number) =>
		text[at] === ":" &&
		(isSpace(text[at + 1]) || (flow > 0 && /[,}\]]/u.test(text[at + 1]!)));
	const push = (
		kind: YamlToken["kind"],
		value: string,
		at: number,
		isQuoted = false,
	) =>
		tokens.push({
			kind,
			text: value,
			quoted: isQuoted,
			column: at - lineStart,
		});
	while (i < text.length) {
		const char = text[i]!;
		const start = i;
		if (char === "\n") {
			push("newline", "", i);
			i += 1;
			lineStart = i;
		} else if (char === " " || char === "\t" || char === "\r") i += 1;
		else if (char === "#" && (i === lineStart || isSpace(text[i - 1])))
			while (i < text.length && text[i] !== "\n") i += 1;
		else if (char === '"' || char === "'") {
			const [value, end] = quoted(text, i);
			push("scalar", value, start, true);
			i = end;
			lineStart = text.lastIndexOf("\n", i - 1) + 1;
		} else if (char === "{" || char === "[") {
			flow += 1;
			push("open", char, start);
			i += 1;
		} else if (flow > 0 && (char === "}" || char === "]")) {
			flow -= 1;
			push("close", char, start);
			i += 1;
		} else if (flow > 0 && char === ",") {
			push("comma", char, start);
			i += 1;
		} else if (mapping(i)) {
			push("colon", char, start);
			i += 1;
		} else if (char === "-" && flow === 0 && isSpace(text[i + 1])) {
			push("dash", char, start);
			i += 1;
		} else {
			while (
				i < text.length &&
				text[i] !== "\n" &&
				!mapping(i) &&
				!(flow > 0 && /[,}\]]/u.test(text[i]!)) &&
				!(text[i] === "#" && isSpace(text[i - 1]))
			)
				i += 1;
			push("scalar", text.slice(start, i).trim(), start);
		}
	}
	return tokens;
}

/**
 * The construct a plain scalar is, where this reader does not read it: an
 * anchor, an alias, a tag other than `!!str`, an explicit key, a merge key, a
 * block scalar, a directive or a second document marker.
 */
function unread(token: YamlToken, next: YamlToken | undefined, first: boolean) {
	if (token.kind !== "scalar" || token.quoted) return undefined;
	const word = token.text.split(/\s/u)[0]!;
	if (word.startsWith("&")) return `an anchor (${word})`;
	if (word.startsWith("*")) return `an alias (${word})`;
	if (word.startsWith("!") && word !== "!!str") return `a tag (${word})`;
	if (word === "?") return "an explicit key (?)";
	if (word === "<<" && next?.kind === "colon") return "a merge key (<<)";
	if (/^[|>][-+0-9]*$/u.test(token.text))
		return `a block scalar (${token.text})`;
	if (token.column === 0 && word.startsWith("%"))
		return `a directive (${word})`;
	if (token.column === 0 && (word === "---" || word === "...") && !first)
		return `a second document (${word})`;
	return undefined;
}

/**
 * The scalar values under pnpm-workspace.yaml's `catalog` and `catalogs`
 * keys, read in the subset of YAML the file is written in: a key quoted or
 * not, entries in block or flow form, a named catalog a level deeper, a
 * double-quoted value over several lines, `!!str`, a leading `---`, and
 * comments after a `#` outside quotes. Nothing under any other key, such as
 * pnpm 10's `overrides`, is a catalog entry. Any construct outside that subset
 * (an anchor, an alias, a merge key, a block scalar, a value on the line
 * after its key, a document in flow style, an explicit key, a tag other than
 * `!!str`, a directive, a second document), wherever it is, throws
 * `UnreadYaml` naming it.
 */
export function catalogValues(text: string): string[] {
	const tokens = yamlTokens(text);
	const values: string[] = [];
	const content = tokens.findIndex((token) => token.kind !== "newline");
	const opening = tokens[content];
	if (opening?.kind === "open" && opening.column === 0)
		throw new UnreadYaml("a document in flow style");
	let inCatalog = false;
	let depth = 0;
	tokens.forEach((token, i) => {
		const construct = unread(token, tokens[i + 1], i === content);
		if (construct !== undefined) throw new UnreadYaml(construct);
		if (token.kind === "open") depth += 1;
		else if (token.kind === "close") depth -= 1;
		if (token.kind !== "scalar") return;
		let before = i - 1;
		while (tokens[before]?.kind === "newline") before -= 1;
		if (
			depth === 0 &&
			before < i - 1 &&
			tokens[before]?.kind === "colon" &&
			tokens[i + 1]?.kind !== "colon"
		)
			throw new UnreadYaml(`a value on the line after its key (${token.text})`);
		const value = token.quoted
			? token.text
			: token.text.replace(/^!!str\s+/u, "");
		if (depth === 0 && token.column === 0 && tokens[i + 1]?.kind === "colon")
			inCatalog = value === "catalog" || value === "catalogs";
		else if (inCatalog && tokens[i - 1]?.kind === "colon") values.push(value);
	});
	return values;
}

/** How a dependency's specifier resolves to a workspace package. */
export interface WorkspaceIndex {
	/** The workspace package of that name. */
	byName(name: string): string | undefined;
	/** The workspace package at a path relative to the dependent's directory. */
	byPath(path: string): string | undefined;
	/** Whether a path relative to the dependent's directory stays in the repository. */
	inside(path: string): boolean;
	/** The `version` of the workspace package of that name, if it has one. */
	versionOf(name: string): string | undefined;
	/** Whether a pnpm catalog may name a workspace package (a `catalog`/`catalogs` entry says `workspace:`). */
	readonly catalogNamesWorkspace: boolean;
}

/**
 * The workspace package turbo orders a dependency on; why it orders none; or
 * why this model cannot tell, which the check reports rather than guesses.
 */
export type Ordered =
	| { readonly kind: "ordered"; readonly target: string }
	| { readonly kind: "external"; readonly reason: string }
	| { readonly kind: "unmodelled"; readonly reason: string };

/** `1.2.3`, `1.2.3-rc.1`, with an optional `=`/`v` and build metadata, which semver ignores. */
const EXACT_VERSION =
	/^[=v]?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+[0-9A-Za-z.-]+)?$/u;

/**
 * Whether turbo's dependency splitter (2.11.10) counts `"<key>": "<specifier>"`
 * as a workspace package, and which.
 * - `workspace:` always counts: `workspace:<name>@*` (`^`, `~`) names
 *   `<name>`, a specifier with a `/` is a path from the dependent, and
 *   anything else names `<key>`. A path is read from the dependent's directory,
 *   then from the repository root.
 * - Anything else counts only where link-workspace-packages is on, and names
 *   `<key>`: `*`, a version the workspace package's own matches, or a
 *   `file:`/`link:` path that stays in the repository. Not an npm alias
 *   (`npm:<name>@<version>`) or another protocol (`github:`, `git+https:`).
 *
 * Unmodelled, so reported: a `catalog:` specifier where the key names a
 * workspace package or a catalog may (turbo resolves the catalog first), and,
 * with link-workspace-packages on, a range or tag (turbo decides it with a
 * semver parser this model does not have).
 */
export function orderedDependency(
	key: string,
	specifier: string,
	link: LinkWorkspacePackages,
	index: WorkspaceIndex,
): Ordered {
	const external = (reason: string): Ordered => ({
		kind: "external",
		reason: `"${specifier}", and turbo ${reason}`,
	});
	const found = (target: string | undefined): Ordered =>
		target === undefined
			? external("finds no workspace package it names")
			: { kind: "ordered", target };
	if (
		specifier.startsWith("catalog:") &&
		(index.byName(key) !== undefined || index.catalogNamesWorkspace)
	)
		return {
			kind: "unmodelled",
			reason:
				"a catalog this check does not resolve; turbo may order the build it names",
		};
	if (specifier.startsWith("workspace:")) {
		const rest = specifier.slice("workspace:".length);
		const alias = /^(.+)@[*^~]$/u.exec(rest)?.[1];
		if (alias !== undefined) return found(index.byName(alias));
		return found(rest.includes("/") ? index.byPath(rest) : index.byName(key));
	}
	if (!link.enabled)
		return external(
			`orders only a workspace: specifier: link-workspace-packages is off (${link.source})`,
		);
	const colon = specifier.indexOf(":");
	const protocol = colon < 0 ? undefined : specifier.slice(0, colon);
	const version = specifier.slice(colon + 1);
	if (protocol === "file" || protocol === "link")
		return index.inside(version)
			? found(index.byName(key))
			: external(`orders no ${protocol}: path outside the repository`);
	if (protocol === "npm" && /^@?[^@]+@/u.test(version))
		return external("orders no npm alias to another package");
	if (protocol !== undefined && protocol !== "npm")
		return external(
			`orders no ${protocol}: specifier although link-workspace-packages is on (${link.source})`,
		);
	const target = index.byName(key);
	if (target === undefined || version === "*") return found(target);
	const own = index.versionOf(target) ?? "";
	if (own === "")
		return external("orders no version on a workspace package that has none");
	const ownExact = EXACT_VERSION.exec(own)?.[1];
	// turbo counts a workspace package whose version it cannot parse.
	if (ownExact === undefined) return found(target);
	const wanted = EXACT_VERSION.exec(version)?.[1];
	if (wanted !== undefined)
		return wanted === ownExact
			? found(target)
			: external(`orders no version other than the workspace package's ${own}`);
	return {
		kind: "unmodelled",
		reason: `a range or tag this check does not compare with the workspace package's ${own} (link-workspace-packages is on: ${link.source})`,
	};
}

export interface TaskConfig {
	readonly dependsOn?: readonly string[];
}

export interface GraphPackage {
	readonly name: string;
	/** Workspace packages it depends on through the fields and specifiers turbo orders. */
	readonly dependencies: readonly string[];
	readonly scripts: ReadonlySet<string>;
	/** The `tasks` of the package's own turbo.json, if it has one. */
	readonly tasks?: Readonly<Record<string, TaskConfig>> | undefined;
}

export class TurboTaskGraph {
	private readonly reached = new Map<string, ReadonlySet<string>>();

	constructor(
		private readonly packages: ReadonlyMap<string, GraphPackage>,
		private readonly rootTasks: Readonly<Record<string, TaskConfig>>,
	) {}

	private dependsOn(pkg: GraphPackage, task: string): readonly string[] {
		const inherited =
			this.rootTasks[`${pkg.name}#${task}`]?.dependsOn ??
			this.rootTasks[task]?.dependsOn ??
			[];
		const own = pkg.tasks?.[task]?.dependsOn;
		if (own === undefined) return inherited;
		if (!own.includes(TURBO_EXTENDS)) return own;
		return [...inherited, ...own.filter((entry) => entry !== TURBO_EXTENDS)];
	}

	/** The packages whose `build` turbo runs before `<pkg>#<task>` (and, for `build`, the package itself). */
	buildsBefore(name: string, task: string): ReadonlySet<string> {
		const key = `${name}#${task}`;
		const cached = this.reached.get(key);
		if (cached !== undefined) return cached;
		const builds = new Set<string>();
		const seen = new Set<string>();
		const queue: [string, string][] = [[name, task]];
		while (queue.length > 0) {
			const [current, currentTask] = queue.pop()!;
			const id = `${current}#${currentTask}`;
			if (seen.has(id)) continue;
			seen.add(id);
			const pkg = this.packages.get(current);
			if (pkg === undefined) continue;
			if (currentTask === "build" && id !== key) builds.add(current);
			for (const entry of this.dependsOn(pkg, currentTask)) {
				if (entry.startsWith("^")) {
					for (const dependency of pkg.dependencies)
						queue.push([dependency, entry.slice(1)]);
				} else if (entry.includes("#")) {
					const at = entry.lastIndexOf("#");
					queue.push([entry.slice(0, at), entry.slice(at + 1)]);
				} else if (!entry.startsWith("$")) queue.push([current, entry]);
			}
		}
		if (task === "build") builds.add(name);
		this.reached.set(key, builds);
		return builds;
	}

	/**
	 * The packages that must be built before code can load `name`'s files: it
	 * and everything its `build` builds first, where each has a `build` script.
	 * Empty for a package whose closure builds nothing.
	 */
	needsBuilt(name: string): string[] {
		return [...this.buildsBefore(name, "build")].filter(
			(item) => this.packages.get(item)?.scripts.has("build") === true,
		);
	}
}
