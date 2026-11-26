/**
 * What `.gitmodules` records for a submodule, read the way git reads it, and
 * the refusals for what git could read differently from the script.
 *
 * Erasable TypeScript with node builtins only.
 */
import { git, gitFailure, Refusal } from "./pins-git-core.ts";

export interface ModulesEntry {
	/** The submodule's name in `.gitmodules` (often, not always, its path). */
	readonly name: string;
	readonly url: string;
}

/** A section as written: git matches its path exactly, so `./a` or `a/` registers nothing. */
export interface ModulesSection {
	readonly name: string;
	readonly path: string | undefined;
	readonly url: string | undefined;
}

function hasControl(value: string): boolean {
	return [...value].some((char) => {
		const code = char.codePointAt(0) ?? 0;
		return code < 0x20 || code === 0x7f;
	});
}

/** `./a//b/` and `a/b` name the same directory. */
function samePath(left: string, right: string): boolean {
	const normal = (value: string): string =>
		value
			.replace(/^(\.\/)+/u, "")
			.replace(/\/{2,}/gu, "/")
			.replace(/\/+$/u, "");
	return normal(left) === normal(right);
}

/**
 * git 2.43's `check_submodule_name` (submodule-config.c): a name that is
 * empty or has a `..` component, split on `/` and on `\` alike, is ignored
 * with "ignoring suspicious submodule name". git keeps a submodule's
 * repository at `<git dir>/modules/<name>`, so such a name would reach out
 * of that directory.
 */
export function gitIgnoresName(name: string): boolean {
	return name === "" || name.split(/[/\\]/u).includes("..");
}

/**
 * Every `submodule.<name>.<key>` value, NUL-separated so no value can forge a
 * line. A `.gitmodules` git cannot read (an exit other than 0, values, or 1,
 * none) is refused naming where git stopped, never read as "nothing there".
 */
function modulesValues(root: string): Map<string, Map<string, string[]>> {
	const read = git(root, [
		"config",
		"-z",
		"-f",
		".gitmodules",
		"--get-regexp",
		"^submodule\\.",
	]);
	if (read.status !== 0 && read.status !== 1) {
		throw new Refusal(
			"GITMODULES_AMBIGUOUS",
			`git cannot read .gitmodules: ${gitFailure("git config", read)}`,
			"correct .gitmodules where git says it stops (git config -f .gitmodules --list reads it the same way)",
		);
	}
	const out = read.stdout;
	const sections = new Map<string, Map<string, string[]>>();
	for (const entry of out.split("\0")) {
		if (entry === "") continue;
		const cut = entry.indexOf("\n");
		const key = cut === -1 ? entry : entry.slice(0, cut);
		const value = cut === -1 ? "" : entry.slice(cut + 1);
		if (hasControl(key) || hasControl(value)) {
			throw new Refusal(
				"GITMODULES_AMBIGUOUS",
				`.gitmodules: ${key.slice(0, 80)} holds a line break or another control character, which git reads from an escape such as \\n; such a value is refused`,
				`remove the escape from that value in .gitmodules`,
			);
		}
		const dot = key.lastIndexOf(".");
		const name = key.slice("submodule.".length, dot);
		const values = sections.get(name) ?? new Map<string, string[]>();
		values.set(key.slice(dot + 1), [
			...(values.get(key.slice(dot + 1)) ?? []),
			value,
		]);
		sections.set(name, values);
	}
	return sections;
}

/**
 * What `.gitmodules` records for the submodule at `path`, read the way git
 * reads it (`git config -z`). Refused (GITMODULES_AMBIGUOUS) when git could
 * pick a repository the script did not compare: two sections naming the path,
 * a path or url set twice in one section, a value with a control character,
 * or a section name git ignores (checked before anything builds the module
 * directory from it).
 */
export function modulesEntry(root: string, path: string): ModulesEntry | null {
	const section = modulesSection(root, path);
	return section?.path === path && section.url !== undefined
		? { name: section.name, url: section.url }
		: null;
}

/** The one section that names `path` in any spelling, as written; refused as `modulesEntry` says. */
export function modulesSection(
	root: string,
	path: string,
): ModulesSection | null {
	const sections = modulesValues(root);
	const naming = [...sections].filter(([, values]) =>
		(values.get("path") ?? []).some((value) => samePath(value, path)),
	);
	if (naming.length > 1) {
		throw new Refusal(
			"GITMODULES_AMBIGUOUS",
			`.gitmodules has ${naming.length} sections for ${path} (${naming.map(([name]) => `"${name}"`).join(", ")}); git uses one of them, so which repository it would contact is not certain`,
			`keep one [submodule] section for ${path} in .gitmodules`,
		);
	}
	const [found] = naming;
	if (found === undefined) return null;
	const [name, values] = found;
	if (gitIgnoresName(name)) {
		throw new Refusal(
			"GITMODULES_AMBIGUOUS",
			`.gitmodules names the section for ${path} "${name}", which git ignores (an empty name, or one with a ".." component), so git and the script would not read the same submodule`,
			`rename the section: [submodule "${path}"] in place of [submodule "${name}"] in .gitmodules`,
		);
	}
	for (const key of ["path", "url"]) {
		if ((values.get(key) ?? []).length > 1) {
			throw new Refusal(
				"GITMODULES_AMBIGUOUS",
				`.gitmodules sets submodule.${name}.${key} more than once`,
				`keep one ${key} line in the [submodule "${name}"] section of .gitmodules`,
			);
		}
	}
	return { name, path: values.get("path")?.[0], url: values.get("url")?.[0] };
}

/** The names of every `[submodule]` section in `.gitmodules`. */
export function modulesSectionNames(root: string): readonly string[] {
	return [...modulesValues(root).keys()];
}

/** The url `.gitmodules` records for the submodule at `path`, if any. */
export function modulesUrl(root: string, path: string): string | null {
	return modulesEntry(root, path)?.url ?? null;
}
