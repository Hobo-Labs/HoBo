/**
 * Run `child-fetch.mts` as the proxied command of a real run, and read back what
 * it left. Shared by the scenario runner (the pact) and the detailed tests.
 */

import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import type { ProxiedRunOutcome } from "../../src/_generated/adapter_opensesame_pb.js";
import type { ParsedCredentialBinding } from "../../src/binding.js";
import { isJsonObject, isJsonString, parseJsonValue } from "../../src/json.js";
import { runProxied } from "../../src/launch.js";
import { SANDBOX_PASS_ENV, type Sandbox } from "./sandbox.js";

export const CHILD_FETCH = join(
	dirname(fileURLToPath(import.meta.url)),
	"child-fetch.mts",
);

export type PlannedRequest = Readonly<{
	label: string;
	url: string;
	method: string;
	authorization: "surrogate" | null;
}>;

export type ChildPlan = Readonly<{
	wait?: boolean;
	lingerMs?: number;
	requests: readonly PlannedRequest[];
}>;

export type RealRun = Readonly<{
	outcome: ProxiedRunOutcome;
	/** OpenSesame's stderr and the child's, as the person would have seen them. */
	stderr: string;
	out: string;
	childEnv: Readonly<Record<string, string>> | undefined;
	argv: readonly string[];
	results: readonly {
		label: string;
		status: number;
		body: string;
		error?: string;
	}[];
	seconds: number;
}>;

let runs = 0;

export function get(
	url: string,
	label = url,
	authorization: "surrogate" | null = "surrogate",
): PlannedRequest {
	return { label, url, method: "GET", authorization };
}

/** Parse `KEY=value` lines. */
function envOf(text: string) {
	const entries: [string, string][] = [];
	for (const line of text.split("\n")) {
		const at = line.indexOf("=");
		if (at > 0) entries.push([line.slice(0, at), line.slice(at + 1)]);
	}
	return Object.fromEntries(entries);
}

function readIf(path: string): string | undefined {
	return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function resultsOf(text: string | undefined) {
	const out: { label: string; status: number; body: string; error?: string }[] =
		[];
	for (const line of (text ?? "").split("\n")) {
		const parsed = parseJsonValue(line);
		if (isJsonObject(parsed) && isJsonString(parsed.label)) {
			out.push({
				label: parsed.label,
				status: Number(parsed.status),
				body: isJsonString(parsed.body) ? parsed.body : "",
			});
		}
	}
	return out;
}

function argvOf(text: string | undefined): string[] {
	const parsed = parseJsonValue(text ?? "[]");
	return Array.isArray(parsed) ? parsed.filter(isJsonString) : [];
}

export function childDir(sandbox: Sandbox): string {
	runs += 1;
	const out = join(sandbox.path("out"), `run-${runs}`);
	mkdirSync(out, { recursive: true });
	return out;
}

export function planChild(out: string, plan: ChildPlan): void {
	writeFileSync(
		join(out, "plan.json"),
		JSON.stringify({
			wait: plan.wait ?? false,
			lingerMs: plan.lingerMs ?? 0,
			requests: plan.requests,
		}),
	);
}

export async function until(
	condition: () => boolean,
	ms = 60_000,
): Promise<void> {
	const deadline = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for the run");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

export type RunOptions = Readonly<{
	bindings: readonly ParsedCredentialBinding[];
	env: NodeJS.ProcessEnv;
	/** The executable: a path, or a bare name found on `env`'s PATH. Defaults to the kit's. */
	bin?: string | undefined;
	/** Names handed to OpenSesame beyond the allowlist. Defaults to what a sandboxed shell has. */
	passEnv?: readonly string[] | undefined;
	/** Runs while the child holds (`wait: true`), e.g. to signal OpenSesame. */
	whileHeld?: ((host: EventEmitter, out: string) => Promise<void>) | undefined;
}>;

/** Run the planned child under the real OpenSesame through the adapter. */
export async function runChild(
	sandbox: Sandbox,
	plan: ChildPlan,
	options: RunOptions,
): Promise<RealRun> {
	const out = childDir(sandbox);
	planChild(out, plan);
	const sink = new PassThrough();
	const seen: string[] = [];
	sink.on("data", (chunk) => seen.push(String(chunk)));
	const host = new EventEmitter();
	const started = Date.now();
	const running = runProxied({
		bin: options.bin ?? sandbox.kit.opensesame,
		bindings: options.bindings,
		argv: [process.execPath, "--no-warnings", CHILD_FETCH, out],
		env: options.env,
		passEnv: options.passEnv ?? SANDBOX_PASS_ENV,
		stderr: sink,
		signals: host,
		tmpRoot: sandbox.path("work"),
	});
	if (options.whileHeld !== undefined) {
		await until(() => existsSync(join(out, "ready")));
		await options.whileHeld(host, out);
	}
	const outcome = await running;
	const env = readIf(join(out, "env.txt"));
	return {
		outcome,
		stderr: seen.join(""),
		out,
		childEnv: env === undefined ? undefined : envOf(env),
		argv: argvOf(readIf(join(out, "argv.json"))),
		results: resultsOf(readIf(join(out, "results.jsonl"))),
		seconds: (Date.now() - started) / 1000,
	};
}
