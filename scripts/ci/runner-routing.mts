#!/usr/bin/env node
/**
 * Committed routing policy and the routing slip, read without dependencies
 * (plan 0026, 3.4 and 3.5; ADR-0181).
 *
 * The route job runs from a sparse checkout with nothing installed, so this
 * file uses Node's built-ins only, in the style of
 * `packages/ci/src/fleet-overflow.ts` and `route-runner.mts`. It holds the
 * same rules as the package's parsers
 * (`packages/ci-gh-actions/src/runner-routing.ts`, zod;
 * `packages/ci-gh-actions/src/routing-slip.ts`, protobuf) and
 * `#RunnerRouting` / `#RoutingSlip` in `data-models/onboarding.cue`; a test
 * holds the three to the same answer on every fixture.
 *
 * - `readRunnerRouting` reads `runnerRouting` from `.hobo/ci.json`.
 * - `judgeRoutingSlip` decides whether a slip may be used: not expired by the
 *   reader's clock, naming the reader's repository, every runner one of the
 *   committed `runnerRouting.labels`. Anything else is no slip, and the queue
 *   rule decides as it does today (R3).
 * - `readRoutingSlip` fetches the slip with the route job's token and
 *   `contents: read`: `GET /git/ref/hobo/routing-slip`, then
 *   `GET /git/commits/<sha>`, within three seconds together.
 *
 * Run directly, it prints the committed policy as JSON (or one field of it
 * with `--get <field>`), or exits 1 when the file has none.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// public-contract: the git ref the box relay writes the routing slip to.
export const ROUTING_SLIP_REF = "refs/hobo/routing-slip";
export const ROUTING_SLIP_VERSION = 1;
export const ROUTING_SLIP_LIFETIME_MS = 10 * 60_000;
/** Both GET calls together; past this the queue decides. */
export const ROUTING_SLIP_READ_TIMEOUT_MS = 3_000;
export const RUNNER_ROUTING_PATH = ".hobo/ci.json";

export const ROUTING_SLIP_CLASSES = ["pr", "fork", "trunk"] as const;
export type RoutingSlipClassName = (typeof ROUTING_SLIP_CLASSES)[number];
export const ROUTING_SLIP_TIERS = ["fleet", "local", "github"] as const;
export type RoutingSlipTier = (typeof ROUTING_SLIP_TIERS)[number];
const OPEN_REASONS = ["fleet-open", "fleet-busy", "pinned"] as const;
const REFUSED_REASONS = [
	"no-node",
	"no-capacity",
	"stalled",
	"pinned",
] as const;
export type RoutingSlipReason =
	| (typeof OPEN_REASONS)[number]
	| (typeof REFUSED_REASONS)[number];
export type RoutingSlipRefusal =
	| "malformed"
	| "wrong-repository"
	| "label-not-allowed"
	| "expired";

/** GitHub's generic self-hosted labels: any self-hosted runner has them. */
export const GENERIC_RUNNER_LABELS: ReadonlySet<string> = new Set([
	"self-hosted",
	"linux",
	"x64",
	"arm64",
	"windows",
	"macos",
]);

const LABEL = /^[a-z0-9][a-z0-9_.-]{0,79}$/u;
const REPOSITORY = /^[a-z0-9][a-z0-9_-]{0,38}\/[a-z0-9_.-]{1,100}$/u;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const NODE_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const COMMIT = /^[0-9a-f]{7,40}$/u;
const RETIRED_NAME = /^HOBO_CI_[A-Z0-9_]{1,60}$/u;
const SHA = /^[0-9a-f]{40}$/u;

/** What `JSON.parse` returns. */
export type JsonValue =
	| null
	| boolean
	| number
	| string
	| readonly JsonValue[]
	| JsonObject;
export interface JsonObject {
	readonly [key: string]: JsonValue;
}

const tagOf = Object.prototype.toString;

export function asObject(value: JsonValue | undefined): JsonObject | undefined {
	// SAFETY: the tag check proves a plain object, which JSON.parse only produces as a JsonObject.
	return tagOf.call(value) === "[object Object]"
		? (value as JsonObject)
		: undefined;
}
export function asText(value: JsonValue | undefined): string | undefined {
	// SAFETY: the tag check proves a string primitive.
	return tagOf.call(value) === "[object String]"
		? (value as string)
		: undefined;
}
function asNumber(value: JsonValue | undefined): number | undefined {
	// SAFETY: the tag check proves a number primitive.
	return tagOf.call(value) === "[object Number]"
		? (value as number)
		: undefined;
}
function asBoolean(value: JsonValue | undefined): boolean | undefined {
	return value === true || value === false ? value : undefined;
}

/** A plain object with exactly these keys, or nothing. */
function exactly(
	value: JsonValue | undefined,
	keys: readonly string[],
): JsonObject | undefined {
	const object = asObject(value);
	if (!object) return undefined;
	const own = Object.keys(object);
	return own.length === keys.length && keys.every((key) => own.includes(key))
		? object
		: undefined;
}

function whole(
	value: JsonValue | undefined,
	min: number,
	max: number,
): number | undefined {
	const number = asNumber(value);
	return number !== undefined &&
		Number.isInteger(number) &&
		number >= min &&
		number <= max
		? number
		: undefined;
}

function oneOf<T extends string>(
	value: JsonValue | undefined,
	options: readonly T[],
): T | undefined {
	return options.find((option) => option === value);
}

function routingLabel(value: JsonValue | undefined): string | undefined {
	const label = asText(value);
	return label !== undefined &&
		LABEL.test(label) &&
		!GENERIC_RUNNER_LABELS.has(label)
		? label
		: undefined;
}

function listOf<T>(
	value: JsonValue | undefined,
	max: number,
	each: (entry: JsonValue) => T | undefined,
): T[] | undefined {
	if (!Array.isArray(value) || value.length > max) return undefined;
	const parsed: T[] = [];
	for (const entry of value) {
		const item = each(entry);
		if (item === undefined) return undefined;
		parsed.push(item);
	}
	return parsed;
}

export type RunnerRoutingPool = Readonly<{
	labels: readonly string[];
	runnerNamePrefix: string;
	maxRunners: number;
}>;

export type RunnerRouting = Readonly<{
	pin: "auto" | "fleet" | "local" | "github";
	queue: Readonly<{ maxWaitSeconds: number; maxQueued: number }>;
	labels: Readonly<{
		fleet: string;
		trunk: string;
		local: string;
		github: string;
	}>;
	localRunner: boolean;
	mainWorkspaceParallelCap: number;
	verdict: Readonly<{
		minFreeRunners: number;
		enterMs: number;
		exitMs: number;
		stallMs: number;
	}>;
	box: Readonly<{
		slots: number;
		trunkSlots: number;
		trunkLend: 0 | 1;
		prCapWithTrunk: number;
		mergeGroupLeases: number;
		capacityVolatilityMb: number;
		trunkHeadroomFleetDeferMs: number;
		jobAdmission: "pull" | "push";
	}>;
	externalPools: readonly RunnerRoutingPool[];
	retiredVariables: readonly string[];
}>;

function parseQueue(
	value: JsonValue | undefined,
): RunnerRouting["queue"] | undefined {
	const fields = exactly(value, ["maxWaitSeconds", "maxQueued"]);
	const maxWaitSeconds = whole(fields?.maxWaitSeconds, 1, 3600);
	const maxQueued = whole(fields?.maxQueued, 1, 100);
	return maxWaitSeconds !== undefined && maxQueued !== undefined
		? { maxWaitSeconds, maxQueued }
		: undefined;
}

function parseLabels(
	value: JsonValue | undefined,
): RunnerRouting["labels"] | undefined {
	const fields = exactly(value, ["fleet", "trunk", "local", "github"]);
	const fleet = routingLabel(fields?.fleet);
	const trunk = routingLabel(fields?.trunk);
	const local = routingLabel(fields?.local);
	const github = routingLabel(fields?.github);
	return fleet && trunk && local && github
		? { fleet, trunk, local, github }
		: undefined;
}

function parseVerdict(
	value: JsonValue | undefined,
): RunnerRouting["verdict"] | undefined {
	const fields = exactly(value, [
		"minFreeRunners",
		"enterMs",
		"exitMs",
		"stallMs",
	]);
	const minFreeRunners = whole(fields?.minFreeRunners, 1, 9999);
	const enterMs = whole(fields?.enterMs, 10_000, 3_600_000);
	const exitMs = whole(fields?.exitMs, 10_000, 3_600_000);
	const stallMs = whole(fields?.stallMs, 60_000, 3_600_000);
	return minFreeRunners !== undefined &&
		enterMs !== undefined &&
		exitMs !== undefined &&
		stallMs !== undefined
		? { minFreeRunners, enterMs, exitMs, stallMs }
		: undefined;
}

function parseBox(
	value: JsonValue | undefined,
): RunnerRouting["box"] | undefined {
	const fields = exactly(value, [
		"slots",
		"trunkSlots",
		"trunkLend",
		"prCapWithTrunk",
		"mergeGroupLeases",
		"capacityVolatilityMb",
		"trunkHeadroomFleetDeferMs",
		"jobAdmission",
	]);
	const slots = whole(fields?.slots, 1, 8);
	const trunkSlots = whole(fields?.trunkSlots, 0, 7);
	const lend = whole(fields?.trunkLend, 0, 1);
	const trunkLend = lend === 0 || lend === 1 ? lend : undefined;
	const prCapWithTrunk = whole(fields?.prCapWithTrunk, 0, 8);
	const mergeGroupLeases = whole(fields?.mergeGroupLeases, 1, 8);
	const capacityVolatilityMb = whole(
		fields?.capacityVolatilityMb,
		0,
		1_048_576,
	);
	const trunkHeadroomFleetDeferMs = whole(
		fields?.trunkHeadroomFleetDeferMs,
		1000,
		3_600_000,
	);
	const jobAdmission = oneOf(fields?.jobAdmission, ["pull", "push"] as const);
	return slots !== undefined &&
		trunkSlots !== undefined &&
		trunkSlots < slots &&
		trunkLend !== undefined &&
		prCapWithTrunk !== undefined &&
		mergeGroupLeases !== undefined &&
		capacityVolatilityMb !== undefined &&
		trunkHeadroomFleetDeferMs !== undefined &&
		jobAdmission
		? {
				slots,
				trunkSlots,
				trunkLend,
				prCapWithTrunk,
				mergeGroupLeases,
				capacityVolatilityMb,
				trunkHeadroomFleetDeferMs,
				jobAdmission,
			}
		: undefined;
}

function parsePool(entry: JsonValue): RunnerRoutingPool | undefined {
	const pool = exactly(entry, ["labels", "runnerNamePrefix", "maxRunners"]);
	const labels = listOf(pool?.labels, 16, routingLabel);
	const prefix = asText(pool?.runnerNamePrefix);
	const maxRunners = whole(pool?.maxRunners, 0, 10_000);
	return labels &&
		labels.length > 0 &&
		prefix !== undefined &&
		prefix.length >= 1 &&
		prefix.length <= 128 &&
		maxRunners !== undefined
		? { labels, runnerNamePrefix: prefix, maxRunners }
		: undefined;
}

function retiredName(entry: JsonValue): string | undefined {
	const name = asText(entry);
	return name !== undefined && RETIRED_NAME.test(name) ? name : undefined;
}

/** The `runnerRouting` block, or nothing when it is not one. */
export function parseRunnerRouting(
	value: JsonValue | undefined,
): RunnerRouting | undefined {
	const top = exactly(value, [
		"pin",
		"queue",
		"labels",
		"localRunner",
		"mainWorkspaceParallelCap",
		"verdict",
		"box",
		"externalPools",
		"retiredVariables",
	]);
	const pin = oneOf(top?.pin, ["auto", "fleet", "local", "github"] as const);
	const queue = parseQueue(top?.queue);
	const labels = parseLabels(top?.labels);
	const localRunner = asBoolean(top?.localRunner);
	const mainWorkspaceParallelCap = whole(top?.mainWorkspaceParallelCap, 1, 8);
	const verdict = parseVerdict(top?.verdict);
	const box = parseBox(top?.box);
	const externalPools = listOf(top?.externalPools, 32, parsePool);
	const retiredVariables = listOf(top?.retiredVariables, 32, retiredName);
	return pin &&
		queue &&
		labels &&
		localRunner !== undefined &&
		mainWorkspaceParallelCap !== undefined &&
		verdict &&
		box &&
		externalPools &&
		retiredVariables
		? {
				pin,
				queue,
				labels,
				localRunner,
				mainWorkspaceParallelCap,
				verdict,
				box,
				externalPools,
				retiredVariables,
			}
		: undefined;
}

export function parseJson(text: string): JsonValue | undefined {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** `runnerRouting` from `.hobo/ci.json`'s text, or nothing. Never throws. */
export function readRunnerRouting(
	text: string | undefined,
): RunnerRouting | undefined {
	if (text === undefined) return undefined;
	return parseRunnerRouting(asObject(parseJson(text))?.runnerRouting);
}

/** Every label a slip may name. */
export function routingLabels(policy: RunnerRouting): ReadonlySet<string> {
	return new Set(Object.values(policy.labels));
}

export type RoutingSlipRoute = Readonly<{
	runner: string;
	tier: RoutingSlipTier;
	reason: RoutingSlipReason;
}>;

export type ParsedRoutingSlip = Readonly<{
	repository: string;
	issuedAtMs: number;
	expiresAtMs: number;
	classes: Readonly<Record<RoutingSlipClassName, RoutingSlipRoute>>;
	relay: Readonly<{ nodeId: string; commit: string }>;
}>;

export type RoutingSlipJudgement =
	| Readonly<{ ok: true; slip: ParsedRoutingSlip }>
	| Readonly<{ ok: false; why: RoutingSlipRefusal }>;

function timeOf(value: string): number | undefined {
	if (!TIME.test(value)) return undefined;
	const ms = Date.parse(value);
	return Number.isFinite(ms) && new Date(ms).toISOString() === value
		? ms
		: undefined;
}

type WireRoute = Readonly<{ runner: string; tier: string; reason: string }>;
type WireSlip = Readonly<{
	version: number;
	repository: string;
	issuedAt: string;
	expiresAt: string;
	classes: ReadonlyMap<string, WireRoute>;
	relay: Readonly<{ nodeId: string; commit: string }>;
}>;

function wireRoute(value: JsonValue | undefined): WireRoute | undefined {
	const fields = exactly(value, ["runner", "tier", "reason"]);
	const runner = asText(fields?.runner);
	const tier = asText(fields?.tier);
	const reason = asText(fields?.reason);
	return runner !== undefined && tier !== undefined && reason !== undefined
		? { runner, tier, reason }
		: undefined;
}

/** The slip's wire shape exactly: camelCase names, JSON types, nothing else. */
function wireSlip(value: JsonValue | undefined): WireSlip | undefined {
	const top = exactly(value, [
		"version",
		"repository",
		"issuedAt",
		"expiresAt",
		"classes",
		"relay",
	]);
	const version = asNumber(top?.version);
	const repository = asText(top?.repository);
	const issuedAt = asText(top?.issuedAt);
	const expiresAt = asText(top?.expiresAt);
	const classObject = asObject(top?.classes);
	const relayFields = exactly(top?.relay, ["nodeId", "commit"]);
	const nodeId = asText(relayFields?.nodeId);
	const commit = asText(relayFields?.commit);
	if (
		version === undefined ||
		repository === undefined ||
		issuedAt === undefined ||
		expiresAt === undefined ||
		!classObject ||
		nodeId === undefined ||
		commit === undefined
	)
		return undefined;
	const classes = new Map<string, WireRoute>();
	for (const [name, entry] of Object.entries(classObject)) {
		const route = wireRoute(entry);
		if (!route) return undefined;
		classes.set(name, route);
	}
	return {
		version,
		repository,
		issuedAt,
		expiresAt,
		classes,
		relay: { nodeId, commit },
	};
}

function routeOf(entry: WireRoute): RoutingSlipRoute | undefined {
	const tier = oneOf(entry.tier, ROUTING_SLIP_TIERS);
	const reason = tier
		? oneOf(entry.reason, tier === "fleet" ? OPEN_REASONS : REFUSED_REASONS)
		: undefined;
	return tier && reason && routingLabel(entry.runner) !== undefined
		? { runner: entry.runner, tier, reason }
		: undefined;
}

/** The slip, or why it is none. The same rules, in the same order, as the package's. */
export function judgeRoutingSlip(
	text: string,
	context: Readonly<{
		repository: string;
		nowMs: number;
		labels: ReadonlySet<string>;
	}>,
): RoutingSlipJudgement {
	const refused = (why: RoutingSlipRefusal): RoutingSlipJudgement => ({
		ok: false,
		why,
	});
	const wire = wireSlip(parseJson(text));
	if (!wire || wire.version !== ROUTING_SLIP_VERSION)
		return refused("malformed");
	if (wire.repository !== context.repository.toLowerCase())
		return refused("wrong-repository");
	if (!REPOSITORY.test(wire.repository)) return refused("malformed");
	const pr = wire.classes.get("pr");
	const fork = wire.classes.get("fork");
	const trunk = wire.classes.get("trunk");
	if (
		wire.classes.size !== ROUTING_SLIP_CLASSES.length ||
		!pr ||
		!fork ||
		!trunk
	)
		return refused("malformed");
	if ([pr, fork, trunk].some((entry) => !context.labels.has(entry.runner)))
		return refused("label-not-allowed");
	const issuedAtMs = timeOf(wire.issuedAt);
	const expiresAtMs = timeOf(wire.expiresAt);
	if (issuedAtMs === undefined || expiresAtMs === undefined)
		return refused("malformed");
	if (expiresAtMs - issuedAtMs > ROUTING_SLIP_LIFETIME_MS)
		return refused("malformed");
	const prRoute = routeOf(pr);
	const forkRoute = routeOf(fork);
	const trunkRoute = routeOf(trunk);
	if (!prRoute || !forkRoute || !trunkRoute) return refused("malformed");
	if (!NODE_ID.test(wire.relay.nodeId) || !COMMIT.test(wire.relay.commit))
		return refused("malformed");
	if (expiresAtMs <= issuedAtMs || expiresAtMs <= context.nowMs)
		return refused("expired");
	return {
		ok: true,
		slip: {
			repository: wire.repository,
			issuedAtMs,
			expiresAtMs,
			classes: { pr: prRoute, fork: forkRoute, trunk: trunkRoute },
			relay: wire.relay,
		},
	};
}

/** What reading the ref found: a commit message to judge, or why there is none. */
export type RoutingSlipRead =
	| Readonly<{ kind: "found"; sha: string; text: string }>
	| Readonly<{ kind: "none"; why: string }>;

/** The GitHub REST headers a token-bearing read or write sends. */
export function githubHeaders(token: string): Headers {
	const headers = new Headers({
		accept: "application/vnd.github+json",
		"x-github-api-version": "2022-11-28",
		"user-agent": "hobo-ci-routing",
	});
	if (token) headers.set("authorization", `Bearer ${token}`);
	return headers;
}

/** The commit a `GET /git/ref/...` answer points at, or nothing. */
function refCommit(body: JsonValue | undefined): string | undefined {
	const object = asObject(asObject(body)?.object);
	const sha = asText(object?.sha);
	return asText(object?.type) === "commit" && sha !== undefined && SHA.test(sha)
		? sha
		: undefined;
}

async function readJson(response: Response): Promise<JsonValue | undefined> {
	return parseJson(await response.text());
}

/**
 * Reads the slip's commit: `GET /git/ref/hobo/routing-slip`, then
 * `GET /git/commits/<sha>`. Never throws; a missing ref is "no routing slip".
 */
export async function readRoutingSlip(input: {
	apiUrl: string;
	repository: string;
	token: string;
	fetch?: typeof fetch | undefined;
	timeoutMs?: number;
	ref?: string;
}): Promise<RoutingSlipRead> {
	const get = input.fetch ?? fetch;
	const signal = AbortSignal.timeout(
		input.timeoutMs ?? ROUTING_SLIP_READ_TIMEOUT_MS,
	);
	const base = `${input.apiUrl.replace(/\/$/u, "")}/repos/${input.repository}/git`;
	const ref = (input.ref ?? ROUTING_SLIP_REF).replace(/^refs\//u, "");
	const read = async (path: string): Promise<Response> =>
		get(`${base}${path}`, { headers: githubHeaders(input.token), signal });
	const unreadable = (status: number): RoutingSlipRead => ({
		kind: "none",
		why: `the routing slip could not be read (HTTP ${status})`,
	});
	try {
		const refResponse = await read(`/ref/${ref}`);
		if (refResponse.status === 404)
			return { kind: "none", why: "no routing slip" };
		if (refResponse.status !== 200) return unreadable(refResponse.status);
		const sha = refCommit(await readJson(refResponse));
		if (!sha)
			return { kind: "none", why: "the routing slip ref is not a commit" };
		const commitResponse = await read(`/commits/${sha}`);
		if (commitResponse.status !== 200) return unreadable(commitResponse.status);
		const message = asText(asObject(await readJson(commitResponse))?.message);
		return message === undefined
			? { kind: "none", why: "the routing slip commit has no message" }
			: { kind: "found", sha, text: message };
	} catch (error) {
		return {
			kind: "none",
			why:
				error instanceof Error && error.name === "TimeoutError"
					? "the routing slip was not read in time"
					: "the routing slip could not be read",
		};
	}
}

/**
 * `[path] [--get <field>]`: the committed policy as JSON, or one top-level
 * field of it (`--get localRunner` prints `true` or `false`, which the fleet
 * probe's gate job reads). Exits 1 when the file has no valid policy or the
 * field is not one of its own.
 */
function main(argv: readonly string[]): number {
	const getAt = argv.indexOf("--get");
	const field = getAt === -1 ? undefined : argv[getAt + 1];
	const rest =
		getAt === -1
			? argv
			: argv.filter((_, index) => index < getAt || index > getAt + 1);
	const path = rest[0] ?? RUNNER_ROUTING_PATH;
	let text: string | undefined;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		text = undefined;
	}
	const policy = readRunnerRouting(text);
	if (!policy) {
		process.stderr.write(`${path} has no valid runnerRouting\n`);
		return 1;
	}
	if (getAt !== -1) {
		const entry = Object.entries(policy).find(([key]) => key === field);
		if (!entry) {
			process.stderr.write(`runnerRouting has no field ${field ?? "(none)"}\n`);
			return 1;
		}
		process.stdout.write(`${JSON.stringify(entry[1])}\n`);
		return 0;
	}
	process.stdout.write(`${JSON.stringify(policy)}\n`);
	return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
	process.exitCode = main(process.argv.slice(2));
