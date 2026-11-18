import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createControlFuzzServer } from "./control-http.js";
import type { FuzzValue } from "./manifest.js";

export interface SchemathesisRun {
	readonly ran: boolean;
	readonly reason: string;
	readonly status?: number | null;
	readonly requests?: number;
	readonly operations?: readonly string[];
	readonly passed?: boolean;
}

export interface SchemathesisOptions {
	readonly binary?: string;
	readonly seconds?: number;
	readonly seed?: number;
}

function isJsonString(value: FuzzValue): value is string {
	return (
		Object.prototype.toString.call(value) === "[object String]" &&
		Object(value) !== value
	);
}

export function assertLocalSchema(document: FuzzValue): void {
	const pending: FuzzValue[] = [document];
	const seen = new WeakSet<object>();
	while (pending.length > 0) {
		const current = pending.pop();
		if (isJsonString(current) && /\b(?:https?|ftp|file):/iu.test(current))
			throw new Error("external schema references are forbidden");
		if (!current || Object(current) !== current) continue;
		const item: object = Object(current);
		if (seen.has(item)) continue;
		seen.add(item);
		for (const [key, entry] of Object.entries(item)) {
			if (
				[
					"servers",
					"server",
					"externalValue",
					"externalDocs",
					"operationRef",
				].includes(key)
			)
				throw new Error("external schema references are forbidden");
			if (key === "$ref" && (!isJsonString(entry) || !entry.startsWith("#/")))
				throw new Error("external schema references are forbidden");
			pending.push(entry);
		}
	}
}

async function execute(
	binary: string,
	args: string[],
	seconds: number,
	cwd: string,
): Promise<{ status: number | null; output: string; unavailable: boolean }> {
	return await new Promise((resolve) => {
		let output = "";
		let unavailable = false;
		const child = spawn(binary, args, {
			cwd,
			env: { PATH: process.env.PATH ?? "", LANG: "C.UTF-8" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		const capture = (chunk: Buffer) => {
			output = (output + chunk.toString("utf8")).slice(-32_768);
		};
		child.stdout.on("data", capture);
		child.stderr.on("data", capture);
		const timer = setTimeout(
			() => child.kill("SIGKILL"),
			(seconds + 30) * 1000,
		);
		child.once("error", () => {
			unavailable = true;
		});
		child.once("close", (status) => {
			clearTimeout(timer);
			resolve({ status, output, unavailable });
		});
	});
}

export async function runSchemathesis(
	options: SchemathesisOptions = {},
): Promise<SchemathesisRun> {
	const seconds = options.seconds ?? 20;
	const seed = options.seed ?? 1742;
	if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60)
		throw new RangeError("seconds must be between 1 and 60");
	if (!Number.isSafeInteger(seed) || seed < 0)
		throw new RangeError("seed must be a non-negative safe integer");
	const source = fileURLToPath(
		new URL("../contracts/openapi/control-sim.v1.json", import.meta.url),
	);
	const raw = await readFile(source, "utf8");
	if (Buffer.byteLength(raw) > 1_000_000)
		throw new Error("schema exceeds the size limit");
	const document: FuzzValue = JSON.parse(raw);
	assertLocalSchema(document);
	const directory = await mkdtemp(join(tmpdir(), "hobo-api-fuzz-"));
	try {
		const spec = join(directory, "control.json");
		await writeFile(spec, JSON.stringify(document), { mode: 0o600 });
		const target = await createControlFuzzServer();
		try {
			const args = [
				"run",
				spec,
				"--url",
				target.url,
				"--workers",
				"1",
				"--max-time",
				String(seconds),
				"--seed",
				String(seed),
				"--generation-database",
				"none",
				"--checks",
				"all",
				"--phases",
				"examples,coverage,fuzzing,stateful",
			];
			const result = await execute(
				options.binary ?? "schemathesis",
				args,
				seconds,
				directory,
			);
			if (result.unavailable)
				return { ran: false, reason: "schemathesis executable unavailable" };
			const requests = target.requests();
			const operations = target.operations();
			const passed =
				result.status === 0 &&
				requests >= 20 &&
				["createBindle", "applyBindle", "destroyBindle", "listResources"].every(
					(name) => operations.includes(name),
				);
			return {
				ran: true,
				passed,
				reason: passed
					? "conformance ok"
					: result.output || "conformance failed",
				status: result.status,
				requests,
				operations,
			};
		} finally {
			await target.close();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
