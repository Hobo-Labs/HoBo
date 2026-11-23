#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "../../packages/hobo/src/json.ts";

export const DEFAULT_PRODUCTION_ORIGIN = "https://hobo-ci.vercel.app";

export const RELAY_VERIFY_TIMEOUT_MS = 15_000;
export const RELAY_VERIFY_ATTEMPTS = 3;
export const RELAY_VERIFY_RETRY_MS = 5_000;

const HTTPS_ORIGIN = /^https:\/\/[^/?#\s@]+\/?$/u;
const COMMIT = /^[0-9a-f]{40}$/u;

export type ProcessEnvLike = Record<string, string | undefined>;

export type RelayVerifyArgs = Readonly<{
	origin: string;
	sha: string;
}>;

export type RelayProbe = Readonly<{
	ok: boolean;
	status: number;
	bodyText: string;
}>;

export type RelayVerifyVerdict = Readonly<{
	ok: boolean;
	code: string;
	message: string;
	awaitingOwner?: boolean;
}>;

export type RelayOwnerHandoffProbes = Readonly<{
	page: RelayProbe;
	mailbox: RelayProbe;
}>;

export const OWNER_HANDOFF_PAGE_PATH = "/owner-handoff";
export const OWNER_HANDOFF_PROBE_PATH = `/v1/owner-handoff/mailboxes/${"A".repeat(43)}`;

const ENTRY_NAME = /^[A-Z][A-Z0-9_]{0,63}$/u;

export class RelayVerifyArgsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RelayVerifyArgsError";
	}
}

const START_STATES: Readonly<
	Record<string, Readonly<{ code: string; message: string }>>
> = Object.freeze({
	"not-configured": {
		code: "HOBO_RELAY_NOT_CONFIGURED",
		message:
			"/readyz reports not-configured: the config service holds no valid relay configuration yet; fill the store's /hobo-ci-relay folder (packages/ci-vercel/CONFIG-SERVICE.md) and re-run the workflow",
	},
	"config-service-denied": {
		code: "HOBO_RELAY_CONFIG_SERVICE_DENIED",
		message:
			"/readyz reports config-service-denied: the store refused the relay's identity; the relay identity in deploy/secret-store.binding.json must trust this project's Vercel production OIDC tokens",
	},
	"config-service-unavailable": {
		code: "HOBO_RELAY_CONFIG_SERVICE_UNAVAILABLE",
		message:
			"/readyz reports config-service-unavailable: the config service did not answer; check the store's status and re-run the workflow once it does",
	},
	"start-failed": {
		code: "HOBO_RELAY_START_FAILED",
		message:
			"/readyz reports start-failed: the relay did not start; read the deployment's runtime log (hobo_ci_relay_init_failed names the stage)",
	},
});

const READINESS_PARTS: Readonly<Record<string, string>> = Object.freeze({
	configService: "the config service stopped answering",
	cache: "the cache binding (Upstash/Turso, deploy/yard.ts) is not reachable",
	executionHost: "the Sandbox execution host is not configured",
	workers: "the workers report failing",
});

const BODY_MENTIONS: readonly (readonly [RegExp, string])[] = Object.freeze([
	[/neon/iu, "Neon (the relay is stateless on main; no Neon store is read)"],
	[/quota/iu, "a quota (a vendor limit the relay's cache or store reported)"],
	[/cache/iu, "the cache backend"],
]);

type ParsedRelayVerifyArg = Readonly<{ value: string; index: number }>;

export function parseRelayVerifyArgs(
	argv: readonly string[],
	env: ProcessEnvLike,
): RelayVerifyArgs {
	let origin = env.HOBO_CI_RELAY_URL?.trim() || DEFAULT_PRODUCTION_ORIGIN;
	let sha = env.GITHUB_SHA?.trim() || "";
	const value = (index: number, name: string): ParsedRelayVerifyArg => {
		const arg = argv[index] ?? "";
		const prefix = `${name}=`;
		if (arg.startsWith(prefix)) {
			const inline = arg.slice(prefix.length).trim();
			if (inline === "")
				throw new RelayVerifyArgsError(`Missing value for ${name}`);
			return { value: inline, index };
		}
		const next = argv[index + 1];
		if (next === undefined || next.startsWith("-"))
			throw new RelayVerifyArgsError(`Missing value for ${name}`);
		return { value: next, index: index + 1 };
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] ?? "";
		if (arg === "--") break;
		if (arg === "--origin" || arg.startsWith("--origin=")) {
			const parsed = value(index, "--origin");
			origin = parsed.value;
			index = parsed.index;
			continue;
		}
		if (arg === "--sha" || arg.startsWith("--sha=")) {
			const parsed = value(index, "--sha");
			sha = parsed.value;
			index = parsed.index;
			continue;
		}
		throw new RelayVerifyArgsError(`Unknown argument: ${arg}`);
	}
	if (!HTTPS_ORIGIN.test(origin))
		throw new RelayVerifyArgsError(
			"Invalid --origin URL: expected an HTTPS origin with no credentials, path, query, or fragment",
		);
	const normalized = new URL(origin).origin;
	if (sha === "")
		throw new RelayVerifyArgsError(
			"Missing --sha commit: pass --sha or set GITHUB_SHA",
		);
	if (!COMMIT.test(sha))
		throw new RelayVerifyArgsError(`Invalid --sha commit: ${sha}`);
	return { origin: normalized, sha };
}

function jsonObject(text: string): JsonObject | undefined {
	if (text.trim() === "") return undefined;
	try {
		const parsed: unknown = JSON.parse(text);
		return isJsonObject(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function entryNames(value: JsonValue | undefined): string[] {
	return isJsonArray(value)
		? value.filter(
				(name): name is string => isJsonString(name) && ENTRY_NAME.test(name),
			)
		: [];
}

function ownerHandoffServes(handoff: RelayOwnerHandoffProbes): boolean {
	const mailbox = jsonObject(handoff.mailbox.bodyText);
	return (
		handoff.page.status === 200 &&
		handoff.mailbox.status === 404 &&
		mailbox?.error === "not-found"
	);
}

function mentions(bodyText: string): string[] {
	const lowered = bodyText.toLowerCase();
	const found: string[] = [];
	for (const [pattern, what] of BODY_MENTIONS)
		if (pattern.test(lowered)) found.push(what);
	return found;
}

export function classifyRelayProbes(input: {
	readonly health: RelayProbe;
	readonly ready: RelayProbe;
	readonly sha: string;
	readonly handoff?: RelayOwnerHandoffProbes;
}): RelayVerifyVerdict {
	const { health, ready } = input;
	if (!health.ok)
		return {
			ok: false,
			code: "HOBO_RELAY_HEALTH_UNREACHABLE",
			message: `/healthz answered HTTP ${health.status}${health.status === 401 || health.status === 403 ? " (Deployment Protection: the production domain is public under Standard Protection, so the origin is not this project's production domain)" : ""}`,
		};
	const sha = input.sha;
	const healthBody = jsonObject(health.bodyText);
	const served = isJsonString(healthBody?.commit)
		? healthBody.commit.toLowerCase()
		: null;
	if (served !== sha)
		return {
			ok: false,
			code: "HOBO_RELAY_COMMIT_MISMATCH",
			message: `/healthz names ${served ?? "no commit"}, not ${sha}: the production origin serves another deployment than the one this run deployed`,
		};
	if (ready.ok)
		return {
			ok: true,
			code: "HOBO_RELAY_READY",
			message: `/healthz and /readyz answered 200 for ${sha}`,
		};
	const body = jsonObject(ready.bodyText);
	const state = isJsonString(body?.state) ? body.state : undefined;
	const missing = entryNames(body?.missing);
	const invalid = entryNames(body?.invalid);
	if (
		state === "not-configured" &&
		missing.length + invalid.length > 0 &&
		input.handoff !== undefined
	) {
		const gaps = [
			...(missing.length > 0 ? [`missing ${missing.join(", ")}`] : []),
			...(invalid.length > 0 ? [`refused ${invalid.join(", ")}`] : []),
		].join("; ");
		if (ownerHandoffServes(input.handoff))
			return {
				ok: true,
				awaitingOwner: true,
				code: "HOBO_RELAY_AWAITING_OWNER",
				message: `/healthz names ${sha} and ${OWNER_HANDOFF_PAGE_PATH} serves with its mailbox store; /readyz waits for the owner's entries (${gaps}) in the store deploy/secret-store.binding.json names (packages/ci-vercel/CONFIG-SERVICE.md)`,
			};
		return {
			ok: false,
			code: "HOBO_RELAY_OWNER_HANDOFF_DOWN",
			message: `/readyz waits for the owner's entries (${gaps}), and the owner hand-off does not serve: ${OWNER_HANDOFF_PAGE_PATH} answered HTTP ${input.handoff.page.status}, its mailbox HTTP ${input.handoff.mailbox.status}`,
		};
	}
	if (state !== undefined && START_STATES[state] !== undefined) {
		const named = START_STATES[state] ?? {
			code: "HOBO_RELAY_NOT_READY",
			message: `/readyz reports ${state}`,
		};
		return { ok: false, ...named };
	}
	const parts = Object.entries(READINESS_PARTS)
		.filter(([part]) => body?.[part] === false || body?.[part] === "failing")
		.map(([, what]) => what);
	const named = mentions(ready.bodyText);
	if (parts.length > 0 || named.length > 0 || body !== undefined) {
		const said = [
			...(parts.length > 0
				? [`a started relay whose parts are not ready: ${parts.join("; ")}`]
				: []),
			...(named.length > 0 ? [`the body mentions ${named.join(", ")}`] : []),
			...(parts.length === 0 && named.length === 0
				? [`ready is ${String(body?.ready)}`]
				: []),
		].join("; ");
		return {
			ok: false,
			code: "HOBO_RELAY_NOT_READY",
			message: `/readyz answered HTTP ${ready.status}: ${said}`,
		};
	}
	return {
		ok: false,
		code: "HOBO_RELAY_READYZ_UNREACHABLE",
		message: `/readyz answered HTTP ${ready.status} with an empty body`,
	};
}

async function probe(
	url: string,
	fetcher: typeof fetch,
	sleep: (ms: number) => Promise<void>,
): Promise<RelayProbe> {
	let last: RelayProbe = { ok: false, status: 0, bodyText: "" };
	for (let attempt = 0; attempt < RELAY_VERIFY_ATTEMPTS; attempt += 1) {
		if (attempt > 0) await sleep(RELAY_VERIFY_RETRY_MS);
		try {
			const response = await fetcher(url, {
				method: "GET",
				headers: { accept: "application/json" },
				signal: AbortSignal.timeout(RELAY_VERIFY_TIMEOUT_MS),
			});
			last = {
				ok: response.ok,
				status: response.status,
				bodyText: await response.text(),
			};
		} catch {
			last = { ok: false, status: 0, bodyText: "" };
		}
		if (last.ok) return last;
	}
	return last;
}

export async function main(
	argv: readonly string[] = process.argv.slice(2),
	env: ProcessEnvLike = process.env,
	fetcher: typeof fetch = fetch,
	sleep: (ms: number) => Promise<void> = (ms) =>
		new Promise((done) => setTimeout(done, ms)),
): Promise<number> {
	let args: RelayVerifyArgs;
	try {
		args = parseRelayVerifyArgs(argv, env);
	} catch (error) {
		if (error instanceof RelayVerifyArgsError) {
			console.error(error.message);
			return 2;
		}
		throw error;
	}
	const health = await probe(`${args.origin}/healthz`, fetcher, sleep);
	const ready = await probe(`${args.origin}/readyz`, fetcher, sleep);
	const handoff = ready.ok
		? undefined
		: {
				page: await probe(
					`${args.origin}${OWNER_HANDOFF_PAGE_PATH}`,
					fetcher,
					sleep,
				),
				mailbox: await probe(
					`${args.origin}${OWNER_HANDOFF_PROBE_PATH}`,
					fetcher,
					async () => undefined,
				),
			};
	const verdict = classifyRelayProbes({
		health,
		ready,
		...args,
		...(handoff !== undefined ? { handoff } : undefined),
	});
	const lines = [
		"### Relay deploy verification",
		"",
		`- origin: ${args.origin}`,
		`- /healthz: HTTP ${health.status}`,
		`- /readyz: HTTP ${ready.status}`,
		...(handoff !== undefined
			? [
					`- ${OWNER_HANDOFF_PAGE_PATH}: HTTP ${handoff.page.status}`,
					`- owner hand-off mailbox: HTTP ${handoff.mailbox.status}`,
				]
			: []),
		`- verdict: ${verdict.code}`,
	];
	if (env.GITHUB_OUTPUT)
		appendFileSync(
			env.GITHUB_OUTPUT,
			`awaiting-owner=${verdict.awaitingOwner === true}\n`,
			"utf8",
		);
	if (env.GITHUB_STEP_SUMMARY)
		appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n\n`, "utf8");
	console.log(lines.join("\n"));
	if (!verdict.ok)
		console.log(
			`::error title=Relay deploy verification::${verdict.code}: ${verdict.message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", " ")}`,
		);
	else console.log(verdict.message);
	return verdict.ok ? 0 : 1;
}

function isDirectExecution(): boolean {
	const entry = process.argv[1];
	if (!entry) return false;
	return resolve(entry) === resolve(fileURLToPath(import.meta.url));
}

if (isDirectExecution()) {
	void main().then(
		(code) => {
			process.exitCode = code;
		},
		(rejected) => {
			console.error(
				rejected instanceof Error ? rejected.message : String(rejected),
			);
			process.exitCode = 1;
		},
	);
}
