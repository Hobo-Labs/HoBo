/**
 * Reaches into another workspace package that a file makes at run time, by a
 * path it assembles rather than an import the reader can follow, and the
 * registry that declares what each one needs.
 *
 * A path the file assembles (lib/test-import-specifiers `ModuleFacts.paths`)
 * names package P where, from its start, a computed part (`*`), `..` or
 * `node_modules`, it continues with P's directory, P's package name, or a run
 * of P's directory's trailing segments: `packages/runtimes/runtime-local` is
 * named by `../../runtimes/runtime-local` and `*`/`runtime-local` alike. In an
 * absolute path (`/…`, `C:\…`, `file:…`), whose root is unknown, P's whole
 * directory names it wherever it is. A path that starts `./` or `../` is also
 * read from the file's directory, as `new URL(…, import.meta.url)` resolves
 * it: from `packages/cli/test/`, `../../core` is `packages/core`. The file
 * reaches P at run time when the path:
 * - goes on into P's build output directory, the first segment of the
 *   `outDir` its build compiles with, else `dist/` (`join(dir, "packages",
 *   "hobo", "dist", "bin", "hobo.js")`, `"../../bindles/dist/index.js"`); or
 * - ends at P's directory or name, or goes on into a computed segment
 *   (`join(hoboDir, file)`), in a file that runs or loads something by a
 *   computed path (`ModuleFacts.loadsComputed`): `join(root, "packages",
 *   "adapters", "adapter-hono")` linked into a generated app, or
 *   `new URL("../../hobo", import.meta.url)` linked into a temporary root. It
 *   ends at P where it names P's directory in more than one segment
 *   (`packages/hobo`, `runtimes/runtime-local`) or right after `..`, or names
 *   P by its name after `node_modules` (or a scoped name after any anchor).
 *   One segment after a computed root (`join(evidence, "events")`) is a name,
 *   not a path to P; so is a package name at a string's start
 *   (`"@hobo/bindles"`, `` `@hobo/app-${name}` ``), unless it goes on into
 *   its build output directory.
 *
 * A path that names a package by a computed segment reaches a package the
 * check cannot name, and counts the same way: a directory that holds workspace
 * packages (`packages`, `packages/runtimes`, or `runtimes` after an anchor) or
 * a scope they are under (`@hobo`), then a computed segment, then any
 * workspace package's build output directory, the end, or another computed
 * segment (`join(root, "packages", name, "dist")`,
 * `` `node_modules/@hobo/${name}` ``, `` new URL(`../../${name}`, …) ``).
 * `join(root, "packages", name, "package.json")` reads a tracked file and does
 * not count.
 *
 * A path that goes on into anything else of P's (its source, `bin/`,
 * `package.json`, its `node_modules`) needs no build of P and is not a reach;
 * nor is one that names P only in the middle of another directory
 * (`…/s0-04-protobuf-cue-codegen/packages/schema-tools`), nor a glob's
 * literal `*`.
 *
 * What this cannot see, so passes: a path assembled across files or behind a
 * name (`join(packagesDir, "hobo")` with `packagesDir` bound elsewhere is one
 * segment after a computed root; a helper that returns a sibling's directory
 * to a test that spawns from it, where the helper itself loads nothing); a
 * path with no literal anchor (`join(here, "..", "..", name)`, a path from
 * the environment); one built another way (`segs.join("/")`, `+=`,
 * `path.format`); a loader reached only through another module; and what a
 * child process loads. A tracked file handed to a child (`bin/hobo.mjs`, a
 * sibling's `src/run.ts` under tsx) is tracked source, so it needs no build
 * here, and its own imports are not read.
 *
 * A reach whose path is rooted at a temporary directory the file visibly makes
 * (lib/test-import-specifiers `TEMPORARY`: `tmpdir()`, `mkdtempSync(prefix)`
 * under a temporary prefix, a `/tmp/` literal, or a name bound only to one)
 * and has no `..` is a stub tree: it still needs an entry, since the reader
 * may misjudge a root, but never a build. A temporary path with any `..` is
 * read as a real path, and also resolved lexically with its root unknown, so
 * `/tmp/../repo/packages/hobo/dist` reaches hobo; `mkdtempSync(join(repoRoot,
 * "x-"))` is a directory under the repository, not a temporary one. A file
 * whose only reaches are stubs is declared `{ "from", "stubOnly": true,
 * "reason" }`, which holds only while the reader sees no other reach from it.
 *
 * The check cannot see what such a reach loads, so an undeclared one fails.
 * A declaration in `scripts/test-deps-runtime-reaches.json` says what the file
 * needs built, `{ "from": "<file>", "needs": ["<package>#build"], "why": "…" }`,
 * and the check holds every test task that loads the file to those builds.
 */
import { posix } from "node:path";

import { z } from "zod";

import {
	COMPUTED,
	isTemporaryPath,
	isTemporaryRooted,
	type ModuleFacts,
	TEMPORARY,
} from "./test-import-specifiers.mts";

/** The registry, relative to the repository root. */
export const RUNTIME_REACHES_FILE = "scripts/test-deps-runtime-reaches.json";

export interface PackageDir {
	readonly name: string;
	/** Repository-relative, `/`-separated. */
	readonly dir: string;
	/** Its build output directories, each one segment under `dir` (`dist`). */
	readonly out: readonly string[];
}

/** What a file reaches at run time through the paths it assembles. */
export interface RuntimeReaches {
	/** Each package a path names, with the first path that names it. */
	readonly named: ReadonlyMap<string, string>;
	/** The first path that names a package by a computed segment, if one does. */
	readonly computed: string | undefined;
	/**
	 * The same for paths rooted at a temporary directory (lib/test-import-specifiers
	 * `isTemporaryPath`): stub trees a test writes, which need no build.
	 */
	readonly stubs: {
		readonly named: ReadonlyMap<string, string>;
		readonly computed: string | undefined;
	};
}

/** One way a path names a package, or a directory or scope that holds packages. */
interface Form {
	/** The package; undefined for a group of packages. */
	readonly name: string | undefined;
	/** The package's build output directories; for a group, every package's. */
	readonly out: ReadonlySet<string>;
	readonly parts: readonly string[];
	/** It is the package's name, not its directory. */
	readonly byName: boolean;
	/**
	 * A whole directory (a package's, or one that holds packages) or a scope:
	 * a group that may start a path, and a form that names on its own anywhere
	 * in an absolute path.
	 */
	readonly whole: boolean;
}

/** The literal segments after which a path may start naming a package; a computed one is one too. */
const ANCHORS = new Set(["..", "node_modules"]);

const isComputed = (part: string | undefined) =>
	part?.includes(COMPUTED) === true;

/** A path as the check reports it: each computed part reads `*`. */
export const shownPath = (text: string) =>
	text.replaceAll(TEMPORARY, COMPUTED).replaceAll(COMPUTED, "*");

const segments = (path: string) =>
	path.split(/[\\/]/u).filter((part) => part !== "" && part !== ".");

/** One way to read a path: its segments, and whether it is absolute (its root unknown). */
interface Reading {
	readonly parts: readonly string[];
	readonly absolute: boolean;
}

/** `/…`, `\\…`, `C:\\…`, `C:/…` or `file:…`. */
const ABSOLUTE = /^(?:[\\/]|[A-Za-z]:[\\/]|file:)/u;

/** `parts` with each `..` taken against the segment before it, as `path.normalize` would. */
function lexical(parts: readonly string[]): string[] {
	const out: string[] = [];
	for (const part of parts)
		if (part === ".." && out.length > 0 && out.at(-1) !== "..") out.pop();
		else out.push(part);
	return out;
}

/**
 * The segments of `text`; where it starts `./` or `../`, of it read from
 * `file`'s directory; and where it starts at a temporary directory and climbs
 * out with `..`, of it resolved lexically, its root unknown
 * (`/tmp/../repo/packages/hobo` is `repo/packages/hobo` under some directory).
 */
function readings(text: string, file: string): Reading[] {
	const own = { parts: segments(text), absolute: ABSOLUTE.test(text) };
	if (isTemporaryRooted(text) && !isTemporaryPath(text))
		return [own, { parts: lexical(own.parts), absolute: true }];
	if (!/^\.\.?(?:[\\/]|$)/u.test(text)) return [own];
	const resolved = posix.join(posix.dirname(file), text.replaceAll("\\", "/"));
	return resolved === ".." || resolved.startsWith("../")
		? [own]
		: [own, { parts: segments(resolved), absolute: false }];
}

/** Reads what a file reaches at run time, against these workspace packages. */
export function runtimeReachReader(
	packages: readonly PackageDir[],
): (facts: ModuleFacts, file: string) => RuntimeReaches {
	// Each way a path can name a package: its directory, its name, and each
	// run of its directory's trailing segments (`runtimes/runtime-local`,
	// `runtime-local`), as a path relative to a sibling or to the packages
	// directory reads it. And each group: the directory that holds a package,
	// each run of that one's trailing segments, and its name's scope.
	const forms = new Map<string, Form[]>();
	const add = (form: Form) => {
		const first = form.parts[0]!;
		forms.set(first, [...(forms.get(first) ?? []), form]);
	};
	const groups = new Map<string, boolean>();
	const group = (parts: readonly string[], whole: boolean) => {
		const key = parts.join("/");
		groups.set(key, whole || groups.get(key) === true);
	};
	const every = new Set(packages.flatMap((pkg) => pkg.out));
	for (const { name, dir, out: outputs } of packages) {
		const parts = dir.split("/");
		const out = new Set(outputs);
		add({ name, out, parts, byName: false, whole: parts.length > 1 });
		add({ name, out, parts: name.split("/"), byName: true, whole: false });
		parts.slice(1).forEach((_, k) => {
			add({
				name,
				out,
				parts: parts.slice(k + 1),
				byName: false,
				whole: false,
			});
		});
		const holder = parts.slice(0, -1);
		holder.forEach((_, k) => {
			group(holder.slice(k), k === 0);
		});
		if (name.startsWith("@") && name.includes("/"))
			group([name.slice(0, name.indexOf("/"))], true);
	}
	for (const [key, whole] of groups)
		add({
			name: undefined,
			out: every,
			parts: key.split("/"),
			byName: key.startsWith("@"),
			whole,
		});
	return (facts, file) => {
		const real = { named: new Map<string, string>(), computed: "" };
		const stub = { named: new Map<string, string>(), computed: "" };
		for (const text of facts.paths) {
			const found = isTemporaryPath(text) ? stub : real;
			const { named } = found;
			for (const { parts, absolute } of readings(text, file))
				parts.forEach((part, i) => {
					const before = parts[i - 1];
					const anchored =
						before === undefined || isComputed(before) || ANCHORS.has(before);
					// What precedes the form, as the rules below read it; in an absolute
					// path a whole directory starts a path wherever it is.
					const anchor = anchored ? before : undefined;
					for (const form of forms.get(part) ?? []) {
						if (!anchored && !(absolute && form.whole)) continue;
						if (!form.parts.every((item, j) => parts[i + j] === item)) continue;
						const next = parts[i + form.parts.length];
						if (form.name === undefined) {
							// A group, then a package it computes, then what of that package.
							if ((anchor === undefined && !form.whole) || !isComputed(next))
								continue;
							const then = parts[i + form.parts.length + 1];
							if (
								(then !== undefined && form.out.has(then)) ||
								((then === undefined || isComputed(then)) &&
									(anchor !== undefined || !form.byName) &&
									facts.loadsComputed)
							)
								found.computed ||= text;
							continue;
						}
						// Where a path that stops here is a path to the package.
						const ends = form.byName
							? anchor === "node_modules" ||
								(anchor !== undefined && form.parts.length > 1)
							: form.parts.length > 1 || anchor === "..";
						if (
							(next !== undefined && form.out.has(next)) ||
							((next === undefined || isComputed(next)) &&
								ends &&
								facts.loadsComputed)
						)
							if (!named.has(form.name)) named.set(form.name, text);
					}
				});
		}
		return {
			named: real.named,
			computed: real.computed || undefined,
			stubs: { named: stub.named, computed: stub.computed || undefined },
		};
	};
}

const RuntimeReachSchema = z.object({
	from: z.string(),
	needs: z.array(z.string()),
	why: z.string().trim().min(1),
});

/** A file whose only reaches are stub trees it writes under a temporary root. */
const StubOnlySchema = z.object({
	from: z.string(),
	stubOnly: z.literal(true),
	reason: z.string().optional(),
	needs: z.unknown().optional(),
});

/** An entry: what a file needs built, or that it only writes stub trees. */
export type RuntimeReach =
	| z.infer<typeof RuntimeReachSchema>
	| { readonly from: string; readonly stubOnly: true; readonly reason: string };

const RegistrySchema = z.object({ reaches: z.array(z.json()) });

/** The registry's declarations, and what is wrong with its shape. */
export interface RuntimeReachRegistry {
	readonly reaches: readonly RuntimeReach[];
	readonly problems: readonly string[];
}

/** The registry's declarations, parsed from its text, and a `from` declared twice; absent text declares nothing. */
export function parseRuntimeReaches(
	text: string | undefined,
): RuntimeReachRegistry {
	if (text === undefined) return { reaches: [], problems: [] };
	let json: z.core.util.JSONType;
	try {
		json = z.json().parse(JSON.parse(text));
	} catch (error) {
		return { reaches: [], problems: [`is not JSON: ${String(error)}`] };
	}
	const registry = RegistrySchema.safeParse(json);
	if (!registry.success)
		return { reaches: [], problems: ['has no "reaches" list'] };
	const reaches: RuntimeReach[] = [];
	const problems: string[] = [];
	registry.data.reaches.forEach((entry, i) => {
		const stub = StubOnlySchema.safeParse(entry);
		if (stub.success) {
			const { from, reason = "", needs } = stub.data;
			const at = `entry ${i} ("${from}") is stubOnly and`;
			if (reason.trim() === "")
				problems.push(`${at} needs a non-empty "reason"`);
			else if (needs !== undefined) problems.push(`${at} cannot carry "needs"`);
			else reaches.push({ from, stubOnly: true, reason });
			return;
		}
		const parsed = RuntimeReachSchema.safeParse(entry);
		if (parsed.success) reaches.push(parsed.data);
		else
			problems.push(
				`entry ${i} is not { "from": string, "needs": string[], "why": string } or { "from": string, "stubOnly": true, "reason": string }`,
			);
	});
	// One file, one entry: with two, which one holds is a guess.
	const counts = new Map<string, number>();
	for (const { from } of reaches) counts.set(from, (counts.get(from) ?? 0) + 1);
	for (const [from, count] of counts)
		if (count > 1)
			problems.push(`"${from}" is declared ${count} times; keep one entry`);
	return { reaches, problems };
}
