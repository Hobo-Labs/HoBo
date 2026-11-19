import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	BINDLE_SOURCE_CANDIDATES,
	compileProjectManifest,
	DEFAULT_COMPONENT_HOST,
	loadBindleDefinition,
	loadProjectCollectionTarget,
	targetFromBindleDefinition,
} from "../src/cloud/loader.js";
import { BindleImportError } from "../src/shell/errors.js";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function project(): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-cli-loader-"));
	dirs.push(dir);
	return dir;
}

function withModule(relative: string, source: string): string {
	const dir = project();
	const absolute = join(dir, relative);
	mkdirSync(join(absolute, ".."), { recursive: true });
	writeFileSync(absolute, source);
	return dir;
}

function definitionSource(
	body = `{ name: "shop", resources: {}, edges: [] }`,
	exportName = "default",
): string {
	return exportName === "default"
		? `export default ${body};\n`
		: `export const ${exportName} = ${body};\n`;
}

const DEFINITION = {
	name: "shop",
	resources: {
		api: { kind: "api", annotations: [] },
		db: { kind: "data", annotations: [] },
		cache: { kind: "kv", annotations: [] },
	},
	edges: [{ from: "api", to: "db" }],
} as never;

describe("candidate order", () => {
	it("prefers a built artifact over TypeScript source", () => {
		const js = BINDLE_SOURCE_CANDIDATES.indexOf("dist/bindle.js");
		const ts = BINDLE_SOURCE_CANDIDATES.indexOf("src/bindle.ts");
		expect(js).toBeGreaterThanOrEqual(0);
		expect(js).toBeLessThan(ts);
	});

	it("prefers bindle.* over the try-site app.* convention", () => {
		const bindle = BINDLE_SOURCE_CANDIDATES.indexOf("src/bindle.js");
		const app = BINDLE_SOURCE_CANDIDATES.indexOf("app.js");
		expect(bindle).toBeLessThan(app);
	});

	it("lists no duplicates", () => {
		expect(new Set(BINDLE_SOURCE_CANDIDATES).size).toBe(
			BINDLE_SOURCE_CANDIDATES.length,
		);
	});
});

describe("loadBindleDefinition", () => {
	it("returns null for a project with no bindle source at all", async () => {
		expect(await loadBindleDefinition(project())).toBeNull();
	});

	it("loads a definition from the default export", async () => {
		const dir = withModule("dist/bindle.js", definitionSource());
		const definition = await loadBindleDefinition(dir);
		expect(definition?.name).toBe("shop");
	});

	it("accepts a named bindle export when there is no default", async () => {
		const dir = withModule(
			"dist/bindle.js",
			definitionSource(undefined, "bindle"),
		);
		expect((await loadBindleDefinition(dir))?.name).toBe("shop");
	});

	it("prefers the default export when a module has both", async () => {
		const dir = withModule(
			"dist/bindle.js",
			`export const bindle = { name: "named", resources: {}, edges: [] };\nexport default { name: "defaulted", resources: {}, edges: [] };\n`,
		);
		expect((await loadBindleDefinition(dir))?.name).toBe("defaulted");
	});

	it("takes the first candidate that exists", async () => {
		const dir = withModule(
			"dist/bindle.js",
			definitionSource(`{ name: "built", resources: {}, edges: [] }`),
		);
		writeFileSync(
			join(dir, "app.js"),
			definitionSource(`{ name: "example", resources: {}, edges: [] }`),
		);
		expect((await loadBindleDefinition(dir))?.name).toBe("built");
	});

	it("returns null when the export is not a bindle definition", async () => {
		for (const body of [
			`"shop"`,
			`42`,
			`null`,
			`() => ({})`,
			`{ resources: {}, edges: [] }`,
			`{ name: "", resources: {}, edges: [] }`,
			`{ name: "shop", edges: [] }`,
			`{ name: "shop", resources: null, edges: [] }`,
			`{ name: "shop", resources: {} }`,
			`{ name: "shop", resources: {}, edges: "none" }`,
		]) {
			const dir = withModule("dist/bindle.js", `export default ${body};\n`);
			expect(await loadBindleDefinition(dir)).toBeNull();
		}
	});

	it("raises a typed import error when the module throws for a real reason", async () => {
		const dir = withModule(
			"dist/bindle.js",
			`throw new Error("boom from user code");\n`,
		);
		await expect(loadBindleDefinition(dir)).rejects.toBeInstanceOf(
			BindleImportError,
		);
	});

	it("names the module it failed to import", async () => {
		const dir = withModule("dist/bindle.js", `throw new Error("boom");\n`);
		try {
			await loadBindleDefinition(dir);
			expect.unreachable("a throwing module must be reported");
		} catch (error) {
			expect((error as Error).message).toContain("bindle.js");
		}
	});

	it("raises rather than skipping when a JavaScript candidate fails", async () => {
		const dir = withModule("dist/bindle.js", `import "./nowhere.js";\n`);
		writeFileSync(join(dir, "app.js"), definitionSource());
		await expect(loadBindleDefinition(dir)).rejects.toBeInstanceOf(
			BindleImportError,
		);
	});

	it("skips a TypeScript source this process cannot import", async () => {
		const dir = withModule(
			"src/bindle.ts",
			`const x: string = "shop";\nexport default { name: x, resources: {}, edges: [] };\n`,
		);
		await expect(loadBindleDefinition(dir)).resolves.toBeDefined();
	});
});

describe("targetFromBindleDefinition", () => {
	it("carries the bindle name as the target id", () => {
		expect(targetFromBindleDefinition(DEFINITION).bindleId).toBe("shop");
	});

	it("defaults the component host to the pinned wasmtime", () => {
		expect(targetFromBindleDefinition(DEFINITION).componentHost).toEqual(
			DEFAULT_COMPONENT_HOST,
		);
		expect(DEFAULT_COMPONENT_HOST.kind).toBe("wasmtime");
		expect(DEFAULT_COMPONENT_HOST.version).toMatch(/^\d+\.\d+\.\d+$/u);
	});

	it("honours an explicit component host", () => {
		expect(
			targetFromBindleDefinition(DEFINITION, {
				kind: "browser",
				version: "1.0.0",
			}).componentHost,
		).toEqual({ kind: "browser", version: "1.0.0" });
	});

	it("declares backing resources before components", () => {
		const order: string[] = [];
		targetFromBindleDefinition(DEFINITION).define({
			data: (name: string) => {
				order.push(`data:${name}`);
				return { name } as never;
			},
			service: (name: string) => {
				order.push(`service:${name}`);
				return { name } as never;
			},
		} as never);
		expect(order.indexOf("data:db")).toBeLessThan(order.indexOf("service:api"));
	});

	it("maps each backing kind onto its data paradigm", () => {
		const seen: Array<{ name: string; paradigm: string }> = [];
		targetFromBindleDefinition({
			name: "shop",
			resources: {
				d: { kind: "data", annotations: [] },
				k: { kind: "kv", annotations: [] },
				b: { kind: "bucket", annotations: [] },
				q: { kind: "queue", annotations: [] },
				t: { kind: "topic", annotations: [] },
				s: { kind: "secret", annotations: [] },
			},
			edges: [],
		} as never).define({
			data: (name: string, options: { paradigm: string }) => {
				seen.push({ name, paradigm: options.paradigm });
				return { name } as never;
			},
			service: () => ({}) as never,
		} as never);
		expect(seen).toEqual([
			{ name: "d", paradigm: "relational" },
			{ name: "k", paradigm: "key-value" },
			{ name: "b", paradigm: "object" },
			{ name: "q", paradigm: "queue" },
			{ name: "t", paradigm: "topic" },
			{ name: "s", paradigm: "secret" },
		]);
	});

	it("passes an unmapped kind through as its own paradigm", () => {
		const seen: string[] = [];
		targetFromBindleDefinition({
			name: "shop",
			resources: { x: { kind: "vector-index", annotations: [] } },
			edges: [],
		} as never).define({
			data: (_name: string, options: { paradigm: string }) => {
				seen.push(options.paradigm);
				return {} as never;
			},
			service: () => ({}) as never,
		} as never);
		expect(seen).toEqual(["vector-index"]);
	});

	it("binds a component to the backing resources it depends on", () => {
		const binds: Array<Record<string, unknown>> = [];
		targetFromBindleDefinition(DEFINITION).define({
			data: (name: string) => ({ handle: name }) as never,
			service: (_name: string, options: { bind?: Record<string, unknown> }) => {
				binds.push(options.bind ?? {});
				return {} as never;
			},
		} as never);
		expect(Object.keys(binds[0] ?? {})).toEqual(["db"]);
	});

	it("omits the bind option entirely for a component with no dependencies", () => {
		const options: Array<Record<string, unknown>> = [];
		targetFromBindleDefinition({
			name: "shop",
			resources: { api: { kind: "api", annotations: [] } },
			edges: [],
		} as never).define({
			data: () => ({}) as never,
			service: (_name: string, opts: Record<string, unknown>) => {
				options.push(opts);
				return {} as never;
			},
		} as never);
		expect(options[0]).toEqual({});
	});

	it("does not bind a component to another component", () => {
		const binds: Array<Record<string, unknown>> = [];
		targetFromBindleDefinition({
			name: "shop",
			resources: {
				web: { kind: "web", annotations: [] },
				api: { kind: "api", annotations: [] },
			},
			edges: [{ from: "web", to: "api" }],
		} as never).define({
			data: () => ({}) as never,
			service: (_name: string, opts: { bind?: Record<string, unknown> }) => {
				binds.push(opts.bind ?? {});
				return {} as never;
			},
		} as never);
		expect(binds.every((bind) => Object.keys(bind).length === 0)).toBe(true);
	});

	it("ignores an edge pointing at a resource that does not exist", () => {
		const binds: Array<Record<string, unknown>> = [];
		targetFromBindleDefinition({
			name: "shop",
			resources: { api: { kind: "api", annotations: [] } },
			edges: [{ from: "api", to: "ghost" }],
		} as never).define({
			data: () => ({}) as never,
			service: (_name: string, opts: { bind?: Record<string, unknown> }) => {
				binds.push(opts.bind ?? {});
				return {} as never;
			},
		} as never);
		expect(binds[0]).toEqual({});
	});

	it("ignores an edge belonging to a different component", () => {
		const binds: Record<string, string[]> = {};
		targetFromBindleDefinition({
			name: "shop",
			resources: {
				api: { kind: "api", annotations: [] },
				web: { kind: "web", annotations: [] },
				db: { kind: "data", annotations: [] },
			},
			edges: [{ from: "api", to: "db" }],
		} as never).define({
			data: (name: string) => ({ handle: name }) as never,
			service: (name: string, opts: { bind?: Record<string, unknown> }) => {
				binds[name] = Object.keys(opts.bind ?? {});
				return {} as never;
			},
		} as never);
		expect(binds.api).toEqual(["db"]);
		expect(binds.web).toEqual([]);
	});

	it("declares every component in the definition", () => {
		const services: string[] = [];
		targetFromBindleDefinition({
			name: "shop",
			resources: {
				api: { kind: "api", annotations: [] },
				web: { kind: "web", annotations: [] },
				worker: { kind: "service", annotations: [] },
				db: { kind: "data", annotations: [] },
			},
			edges: [],
		} as never).define({
			data: () => ({}) as never,
			service: (name: string) => {
				services.push(name);
				return {} as never;
			},
		} as never);
		expect(services.sort()).toEqual(["api", "web", "worker"]);
	});
});

describe("loadProjectCollectionTarget", () => {
	it("returns null when there is no loadable bindle", async () => {
		expect(await loadProjectCollectionTarget(project())).toBeNull();
	});

	it("adapts a loaded definition into a target", async () => {
		const dir = withModule("dist/bindle.js", definitionSource());
		expect((await loadProjectCollectionTarget(dir))?.bindleId).toBe("shop");
	});
});

describe("compileProjectManifest", () => {
	it("returns null when there is no bindle source", async () => {
		expect(await compileProjectManifest(project())).toBeNull();
	});

	it("compiles a loadable bindle to a manifest", async () => {
		const dir = withModule(
			"dist/bindle.js",
			definitionSource(
				`{ name: "shop", resources: { api: { kind: "api", annotations: [] } }, edges: [] }`,
			),
		);
		const manifest = await compileProjectManifest(dir);
		expect(manifest).not.toBeNull();
	});

	it("returns null rather than throwing when collection fails", async () => {
		const dir = withModule(
			"dist/bindle.js",
			definitionSource(`{ name: "", resources: {}, edges: [] }`),
		);
		expect(await compileProjectManifest(dir)).toBeNull();
	});
});
