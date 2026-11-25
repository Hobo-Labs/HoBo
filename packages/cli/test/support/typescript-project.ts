import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import { expect } from "vitest";
import {
	overlayCompilerHost,
	packageTypeScriptAppArtifacts,
} from "../../src/codegen/typescript-project-engine.js";

export async function write(
	root: string,
	path: string,
	content: string,
): Promise<void> {
	await mkdir(join(root, path, ".."), { recursive: true });
	await writeFile(join(root, path), content);
}

export async function fixture(root: string): Promise<void> {
	await write(root, "package.json", JSON.stringify({ type: "module" }));
	await write(
		root,
		"tsconfig.json",
		JSON.stringify({
			compilerOptions: {
				target: "ES2022",
				module: "NodeNext",
				moduleResolution: "NodeNext",
				strict: true,
				types: [],
				rootDir: ".",
				outDir: "out",
			},
			include: ["source/**/*.ts"],
		}),
	);
	await write(
		root,
		"source/contracts.ts",
		`
export interface Order { id: string; items: Array<{ sku: string; price: { amount: number; currency: "USD" | "EUR" } }>; delivery?: { address: { city: string }; tags: readonly string[] }; }
export interface Page<T> { entries: T[]; next: string | null; }
`,
	);
	await write(
		root,
		"source/lib.ts",
		`
import type { Order, Page } from "./contracts.js";
export class OrderService {
  private count = 0;
  async submit(order: Order): Promise<Page<Order>> { this.count++; return { entries: [order], next: String(this.count) }; }
}
export function identity<T>(value: T): T { return value; }
`,
	);
	await write(
		root,
		"source/entrypoint.ts",
		`
import { OrderService } from "./lib.js";
export { OrderService, identity as echo } from "./lib.js";
export const service = new OrderService();
export default { async fetch(request: Request): Promise<Response> { return new Response(new URL(request.url).pathname); } };
`,
	);
}

export async function compile(root: string): Promise<void> {
	const roots = ts.sys.readDirectory(
		root,
		[".ts"],
		["**/out/**"],
		["source/**/*.ts", "src/_generated/**/*.ts", "consumer.ts"],
	);
	const config = ts.readConfigFile(
		join(root, "tsconfig.json"),
		ts.sys.readFile,
	);
	const parsed = config.error
		? undefined
		: ts.parseJsonConfigFileContent(config.config, ts.sys, root);
	const options: ts.CompilerOptions = {
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.NodeNext,
		moduleResolution: ts.ModuleResolutionKind.NodeNext,
		strict: true,
		types: [],
		...parsed?.options,
		noEmit: false,
		rootDir: root,
		outDir: join(root, "out"),
	};
	// Codegen's host: lib and package declarations are parsed once per worker, not per program.
	const program = ts.createProgram(
		roots,
		options,
		overlayCompilerHost(options, new Map()),
	);
	expect(
		ts
			.getPreEmitDiagnostics(program)
			.map((diagnostic) =>
				ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
			),
	).toEqual([]);
	expect(program.emit().emitSkipped).toBe(false);
	await packageTypeScriptAppArtifacts(root, join(root, "out"));
}

export async function compilePackagedConsumer(
	root: string,
	source: string,
): Promise<void> {
	const file = join(root, "out/isolated-consumer.mts");
	await write(root, "out/isolated-consumer.mts", source);
	const options: ts.CompilerOptions = {
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.NodeNext,
		moduleResolution: ts.ModuleResolutionKind.NodeNext,
		strict: true,
		types: [],
		noEmit: true,
	};
	const program = ts.createProgram(
		[file],
		options,
		overlayCompilerHost(options, new Map()),
	);
	expect(
		ts
			.getPreEmitDiagnostics(program)
			.map((diagnostic) =>
				ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
			),
	).toEqual([]);
}
