import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { isRecursiveSubset, subsetMismatchPath } from "./subset.js";

export interface ConcernCase {
	readonly method: string;
	readonly name?: string;
	readonly input?: readonly unknown[];
	readonly expect?: unknown;
	readonly subset?: unknown;
	readonly match?: string;
	readonly throws?: string;
	readonly throwsSubset?: Readonly<Record<string, unknown>>;
}

const KEYS = new Set([
	"method",
	"name",
	"input",
	"expect",
	"subset",
	"match",
	"throws",
	"throwsSubset",
]);

export function parseConcernCases(
	text: string,
	source = "cases",
): readonly ConcernCase[] {
	const cases = text.split("\n").flatMap((line, index) => {
		const at = `${source}:${index + 1}`;
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) return [];
		let row: Record<string, unknown>;
		try {
			row = JSON.parse(trimmed) as Record<string, unknown>;
		} catch (error) {
			throw new Error(`${at} is not JSON — ${(error as Error).message}`);
		}
		const unknownKey = Object.keys(row).find((key) => !KEYS.has(key));
		if (unknownKey) throw new Error(`${at} has unknown key "${unknownKey}"`);
		if (typeof row.method !== "string" || !row.method)
			throw new Error(`${at} needs a non-empty "method"`);
		const asserts = [row.expect, row.subset, row.match].some(
			(value) => value !== undefined,
		);
		if (row.throwsSubset !== undefined && asserts)
			throw new Error(`${at} cannot assert both a throw and a value`);
		if (row.throws !== undefined && asserts)
			throw new Error(`${at} cannot assert both a throw and a value`);
		if (row.throws === undefined && row.throwsSubset === undefined && !asserts)
			throw new Error(`${at} asserts nothing`);
		return [row as unknown as ConcernCase];
	});
	if (!cases.length) throw new Error(`${source} declares no cases`);
	return cases;
}

export function callableMembers(subject: object): readonly string[] {
	const isModule =
		(subject as { [Symbol.toStringTag]?: string })[Symbol.toStringTag] ===
		"Module";
	const names = new Set<string>();
	for (
		let node: object | null = subject;
		node && node !== Object.prototype;
		node = Object.getPrototypeOf(node) as object | null
	) {
		for (const key of Object.getOwnPropertyNames(node)) {
			if (key === "constructor") continue;
			if (!isModule && Object.getOwnPropertyDescriptor(node, key)?.get)
				names.add(key);
			else if (typeof (subject as Record<string, unknown>)[key] === "function")
				names.add(key);
		}
	}
	return [...names].sort();
}

export interface ConcernOptions<T extends object> {
	readonly subject: () => T | Promise<T>;
	readonly cases: string;
	readonly teardown?: (subject: T) => unknown;
	readonly uncovered?: Readonly<Record<string, string>>;
}

export type CaseOutcome =
	| { readonly returned: unknown }
	| { readonly threw: unknown };

export function assertCase(row: ConcernCase, outcome: CaseOutcome): void {
	const wantsThrow = row.throws !== undefined || row.throwsSubset !== undefined;
	if ("threw" in outcome) {
		const error = outcome.threw;
		if (!wantsThrow) throw error;
		if (row.throws !== undefined)
			expect((error as Error).message).toMatch(new RegExp(row.throws, "u"));
		if (
			row.throwsSubset !== undefined &&
			!isRecursiveSubset(row.throwsSubset, error)
		)
			expect.unreachable(
				`thrown error mismatch at ${subsetMismatchPath(row.throwsSubset, error)} — got ${(error as Error).name}: ${(error as Error).message}`,
			);
		return;
	}
	const actual = outcome.returned;
	if (wantsThrow)
		expect.unreachable(
			`expected a throw matching ${row.throws ?? JSON.stringify(row.throwsSubset)}, got ${JSON.stringify(actual)}`,
		);
	if (row.match !== undefined)
		expect(
			typeof actual === "string" ? actual : JSON.stringify(actual),
		).toMatch(new RegExp(row.match, "u"));
	if (row.subset !== undefined && !isRecursiveSubset(row.subset, actual))
		expect.unreachable(
			`result mismatch at ${subsetMismatchPath(row.subset, actual)} — got ${JSON.stringify(actual)}`,
		);
	if (row.expect !== undefined) expect(actual).toEqual(row.expect);
}

export function describeConcern<T extends object>(
	name: string,
	options: ConcernOptions<T>,
): void {
	const cases = parseConcernCases(
		readFileSync(options.cases, "utf8"),
		options.cases,
	);
	const byMethod = new Map<string, ConcernCase[]>();
	for (const row of cases)
		byMethod.set(row.method, [...(byMethod.get(row.method) ?? []), row]);

	describe(name, () => {
		it("covers every member", async () => {
			const members = callableMembers(await options.subject());
			expect(
				members.filter(
					(m) => !byMethod.has(m) && options.uncovered?.[m] === undefined,
				),
			).toEqual([]);
			expect(
				Object.keys(options.uncovered ?? {}).filter(
					(m) => !members.includes(m) || byMethod.has(m),
				),
				"exemptions that no longer apply",
			).toEqual([]);
		});

		for (const [method, rows] of [...byMethod].sort())
			it.each(
				rows.map((r) => [r.name ?? JSON.stringify(r.input ?? []), r]),
			)(`${method} %s`, async (_label, row) => {
				const subject = await options.subject();
				let outcome: CaseOutcome;
				try {
					const member = (subject as Record<string, unknown>)[method];
					outcome = {
						returned:
							typeof member === "function"
								? await (member as (...a: unknown[]) => unknown).apply(
										subject,
										[...(row.input ?? [])],
									)
								: member,
					};
				} catch (error) {
					outcome = { threw: error };
				} finally {
					await options.teardown?.(subject);
				}
				assertCase(row, outcome);
			});
	});
}
