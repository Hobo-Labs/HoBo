import { posix } from "node:path";

import { z } from "zod";

import {
	COMPUTED,
	isTemporaryPath,
	isTemporaryRooted,
	type ModuleFacts,
	TEMPORARY,
} from "./test-import-specifiers.mts";

export const RUNTIME_REACHES_FILE = "scripts/test-deps-runtime-reaches.json";

export interface PackageDir {
	readonly name: string;
	readonly dir: string;
	readonly out: readonly string[];
}

export interface RuntimeReaches {
	readonly named: ReadonlyMap<string, string>;
	readonly computed: string | undefined;
	readonly stubs: {
		readonly named: ReadonlyMap<string, string>;
		readonly computed: string | undefined;
	};
}

interface Form {
	readonly name: string | undefined;
	readonly out: ReadonlySet<string>;
	readonly parts: readonly string[];
	readonly byName: boolean;
	readonly whole: boolean;
}

const ANCHORS = new Set(["..", "node_modules"]);

const isComputed = (part: string | undefined) =>
	part?.includes(COMPUTED) === true;

export const shownPath = (text: string) =>
	text.replaceAll(TEMPORARY, COMPUTED).replaceAll(COMPUTED, "*");

const segments = (path: string) =>
	path.split(/[\\/]/u).filter((part) => part !== "" && part !== ".");

interface Reading {
	readonly parts: readonly string[];
	readonly absolute: boolean;
}

const ABSOLUTE = /^(?:[\\/]|[A-Za-z]:[\\/]|file:)/u;

function lexical(parts: readonly string[]): string[] {
	const out: string[] = [];
	for (const part of parts)
		if (part === ".." && out.length > 0 && out.at(-1) !== "..") out.pop();
		else out.push(part);
	return out;
}

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

export function runtimeReachReader(
	packages: readonly PackageDir[],
): (facts: ModuleFacts, file: string) => RuntimeReaches {
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
					const anchor = anchored ? before : undefined;
					for (const form of forms.get(part) ?? []) {
						if (!anchored && !(absolute && form.whole)) continue;
						if (!form.parts.every((item, j) => parts[i + j] === item)) continue;
						const next = parts[i + form.parts.length];
						if (form.name === undefined) {
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

const StubOnlySchema = z.object({
	from: z.string(),
	stubOnly: z.literal(true),
	reason: z.string().optional(),
	needs: z.unknown().optional(),
});

export type RuntimeReach =
	| z.infer<typeof RuntimeReachSchema>
	| { readonly from: string; readonly stubOnly: true; readonly reason: string };

const RegistrySchema = z.object({ reaches: z.array(z.json()) });

export interface RuntimeReachRegistry {
	readonly reaches: readonly RuntimeReach[];
	readonly problems: readonly string[];
}

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
	const counts = new Map<string, number>();
	for (const { from } of reaches) counts.set(from, (counts.get(from) ?? 0) + 1);
	for (const [from, count] of counts)
		if (count > 1)
			problems.push(`"${from}" is declared ${count} times; keep one entry`);
	return { reaches, problems };
}
