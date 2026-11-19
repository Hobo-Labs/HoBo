const TURBO_EXTENDS = "$TURBO_EXTENDS$";

export interface LinkWorkspacePackages {
	readonly enabled: boolean;
	readonly source: string;
}

export interface LinkInputs {
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
	readonly quoted: boolean;
	readonly column: number;
}

export class UnreadYaml extends Error {
	constructor(readonly construct: string) {
		super(
			`uses ${construct}, which this check does not read, so it cannot tell whether a catalog names a workspace package`,
		);
		this.name = "UnreadYaml";
	}
}

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

export interface WorkspaceIndex {
	byName(name: string): string | undefined;
	byPath(path: string): string | undefined;
	inside(path: string): boolean;
	versionOf(name: string): string | undefined;
	readonly catalogNamesWorkspace: boolean;
}

export type Ordered =
	| { readonly kind: "ordered"; readonly target: string }
	| { readonly kind: "external"; readonly reason: string }
	| { readonly kind: "unmodelled"; readonly reason: string };

const EXACT_VERSION =
	/^[=v]?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+[0-9A-Za-z.-]+)?$/u;

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
	readonly dependencies: readonly string[];
	readonly scripts: ReadonlySet<string>;
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

	needsBuilt(name: string): string[] {
		return [...this.buildsBefore(name, "build")].filter(
			(item) => this.packages.get(item)?.scripts.has("build") === true,
		);
	}
}
