import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createResolverRegistry,
	parseResolverDirectives,
	ResolverError,
	type ResourceResolver,
} from "../src/index.js";

const here = import.meta.dirname;
const CUE = readFileSync(
	join(here, "..", "data-models", "resource_resolver.cue"),
	"utf8",
);
const SOURCE = readFileSync(
	join(here, "..", "src", "ports", "resource-resolver.ts"),
	"utf8",
);

function cuePattern(definition: string): string {
	const match = new RegExp(
		`^${definition}: =~("(?:[^"\\\\]|\\\\.)*")$`,
		"mu",
	).exec(CUE);
	const literal = match?.[1];
	if (literal === undefined) {
		throw new Error(`resource_resolver.cue defines no ${definition} pattern`);
	}
	return JSON.parse(literal);
}

function sourcePattern(name: string): string {
	const match = new RegExp(`^const ${name} = /(.+)/u;$`, "mu").exec(SOURCE);
	const body = match?.[1];
	if (body === undefined) {
		throw new Error(`resource-resolver.ts defines no ${name} regex literal`);
	}
	return body;
}

const TWINS = [
	["RESOLVER_ID_PATTERN", "#ResolverId"],
	["LOGICAL_ID_PATTERN", "#LogicalId"],
	["DIRECTIVE_PATTERN", "#Directive"],
] as const;

function resolverListing(directives: readonly string[]): ResourceResolver {
	return {
		providerId: "vercel",
		productId: "vercel.postgres",
		directives,
		reconcile: async () => {
			throw new Error("not called");
		},
		delete: async () => undefined,
	};
}

function parserAccepts(name: string): boolean {
	try {
		parseResolverDirectives(resolverListing([name]));
		return true;
	} catch (error) {
		if (error instanceof ResolverError) return false;
		throw error;
	}
}

function registryAccepts(id: string): boolean {
	try {
		createResolverRegistry([{ ...resolverListing([]), productId: id }]);
		return true;
	} catch (error) {
		if (error instanceof ResolverError) return false;
		throw error;
	}
}

describe("the resolver patterns and the CUE are one definition", () => {
	it.each(TWINS)("%s appears verbatim as %s", (constant, definition) => {
		expect(sourcePattern(constant)).toBe(cuePattern(definition));
	});

	it.each([
		["forceDelete", true],
		["restoreScheduled", true],
		["x_1", true],
		["a".repeat(64), true],
		["a".repeat(65), false],
		["", false],
		["force delete", false],
		["force-delete", false],
		["_force", false],
		["1force", false],
	])("a directive named %o is accepted by the parser exactly when #Directive accepts it (%s)", (name, accepted) => {
		const cue = new RegExp(cuePattern("#Directive"), "u");
		expect(cue.test(name)).toBe(accepted);
		expect(parserAccepts(name)).toBe(accepted);
	});

	it.each([
		["aws.secrets-manager/v1", true],
		["vercel.postgres", true],
		["Vercel", false],
		["", false],
		["a".repeat(129), false],
	])("a product id %o is accepted by the registry exactly when #ResolverId accepts it (%s)", (id, accepted) => {
		const cue = new RegExp(cuePattern("#ResolverId"), "u");
		expect(cue.test(id)).toBe(accepted);
		expect(registryAccepts(id)).toBe(accepted);
	});
});
