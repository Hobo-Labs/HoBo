/**
 * The routing slip at its boundaries (`data-models/routing_slip.proto`,
 * ADR-0181): the box relay's current routing answer for one repository. The
 * relay writes it as the message of a parentless commit at
 * `refs/hobo/routing-slip`; the route job reads it with its own token.
 *
 * Parse, don't validate: a slip crosses `judgeRoutingSlip` once and comes out
 * as a `ParsedRoutingSlip` the caller uses without checking again, or as the
 * reason it is no slip. A slip is used only while it has not expired, names
 * the reader's repository, and every runner it names is a committed
 * `runnerRouting.labels` value. Anything else changes nothing: the queue rule
 * decides, as it does with no slip (ADR-0181, R3).
 *
 * `scripts/ci/runner-routing.mts` holds the same rules without dependencies,
 * for the route job's sparse checkout; the two agree on every fixture.
 */
import { create, fromJson, toJsonString } from "@bufbuild/protobuf";
import { z } from "zod";
import {
	type RoutingSlip,
	RoutingSlipSchema,
} from "./_generated/routing_slip_pb.js";
import { GENERIC_RUNNER_LABELS } from "./runner-routing.js";

// public-contract: the git ref the box relay writes the routing slip to.
export const ROUTING_SLIP_REF = "refs/hobo/routing-slip";
export const ROUTING_SLIP_VERSION = 1;
/** A slip stands this long after it is issued, and no longer. */
export const ROUTING_SLIP_LIFETIME_MS = 10 * 60_000;
/** The relay rewrites an unchanged slip this often while it is up. */
export const ROUTING_SLIP_HEARTBEAT_MS = 3 * 60_000;

/** The classes of `#FleetRoutes`; shards use `trunk` or `pr`. */
export const ROUTING_SLIP_CLASSES = ["pr", "fork", "trunk"] as const;
export type RoutingSlipClassName = (typeof ROUTING_SLIP_CLASSES)[number];
export const ROUTING_SLIP_TIERS = ["fleet", "local", "github"] as const;
export type RoutingSlipTier = (typeof ROUTING_SLIP_TIERS)[number];
/** Open reasons send a class to the fleet; refused ones elsewhere; `pinned` either. */
export const ROUTING_SLIP_OPEN_REASONS = ["fleet-open", "fleet-busy"] as const;
export const ROUTING_SLIP_REFUSED_REASONS = [
	"no-node",
	"no-capacity",
	"stalled",
] as const;
export type RoutingSlipReason =
	| (typeof ROUTING_SLIP_OPEN_REASONS)[number]
	| (typeof ROUTING_SLIP_REFUSED_REASONS)[number]
	| "pinned";

/** Why a slip is no slip, in the words the route job's warning uses. */
export type RoutingSlipRefusal =
	| "malformed"
	| "wrong-repository"
	| "label-not-allowed"
	| "expired";

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

/** What the reader brings: its repository, its clock and the committed labels. */
export type RoutingSlipContext = Readonly<{
	repository: string;
	nowMs: number;
	labels: ReadonlySet<string>;
}>;

const REPOSITORY = /^[a-z0-9][a-z0-9_-]{0,38}\/[a-z0-9_.-]{1,100}$/u;
const LABEL = /^[a-z0-9][a-z0-9_.-]{0,79}$/u;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const NODE_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const COMMIT = /^[0-9a-f]{7,40}$/u;

function timeOf(value: string): number | undefined {
	if (!TIME.test(value)) return undefined;
	const ms = Date.parse(value);
	return Number.isFinite(ms) && new Date(ms).toISOString() === value
		? ms
		: undefined;
}

function tierOf(value: string): RoutingSlipTier | undefined {
	return ROUTING_SLIP_TIERS.find((tier) => tier === value);
}

function reasonFor(
	tier: RoutingSlipTier,
	value: string,
): RoutingSlipReason | undefined {
	if (value === "pinned") return value;
	return tier === "fleet"
		? ROUTING_SLIP_OPEN_REASONS.find((reason) => reason === value)
		: ROUTING_SLIP_REFUSED_REASONS.find((reason) => reason === value);
}

/**
 * The slip's wire shape, exactly: camelCase names, every field present with
 * its JSON type, nothing else. Protobuf's JSON reader alone would also take a
 * string `version`, snake_case names or a `null`; the route job's reader
 * does not, and the two must agree.
 */
const RoutingSlipWire = z
	.object({
		version: z.number(),
		repository: z.string(),
		issuedAt: z.string(),
		expiresAt: z.string(),
		classes: z.record(
			z.string(),
			z
				.object({ runner: z.string(), tier: z.string(), reason: z.string() })
				.strict(),
		),
		relay: z.object({ nodeId: z.string(), commit: z.string() }).strict(),
	})
	.strict();

/**
 * The slip, or why it is none. The text must be the slip's canonical JSON:
 * camelCase names, every field present, nothing else (protobuf's lenient
 * spellings, a string `version` or a `null`, are refused).
 */
export function judgeRoutingSlip(
	text: string,
	context: RoutingSlipContext,
): RoutingSlipJudgement {
	const refused = (why: RoutingSlipRefusal): RoutingSlipJudgement => ({
		ok: false,
		why,
	});
	let message: RoutingSlip;
	try {
		const wire = RoutingSlipWire.safeParse(JSON.parse(text));
		if (!wire.success) return refused("malformed");
		message = fromJson(RoutingSlipSchema, wire.data);
	} catch {
		return refused("malformed");
	}
	if (message.version !== ROUTING_SLIP_VERSION) return refused("malformed");
	if (message.repository !== context.repository.toLowerCase())
		return refused("wrong-repository");
	if (!REPOSITORY.test(message.repository)) return refused("malformed");
	const names = Object.keys(message.classes);
	if (
		names.length !== ROUTING_SLIP_CLASSES.length ||
		!ROUTING_SLIP_CLASSES.every((name) => names.includes(name))
	)
		return refused("malformed");
	const entries = ROUTING_SLIP_CLASSES.map(
		(name) => [name, message.classes[name]] as const,
	);
	if (entries.some(([, entry]) => !context.labels.has(entry?.runner ?? "")))
		return refused("label-not-allowed");
	const issuedAtMs = timeOf(message.issuedAt);
	const expiresAtMs = timeOf(message.expiresAt);
	if (issuedAtMs === undefined || expiresAtMs === undefined)
		return refused("malformed");
	if (expiresAtMs - issuedAtMs > ROUTING_SLIP_LIFETIME_MS)
		return refused("malformed");
	const classes = new Map<RoutingSlipClassName, RoutingSlipRoute>();
	for (const [name, entry] of entries) {
		const tier = tierOf(entry?.tier ?? "");
		const reason = tier && reasonFor(tier, entry?.reason ?? "");
		const runner = entry?.runner ?? "";
		if (
			!tier ||
			!reason ||
			!LABEL.test(runner) ||
			GENERIC_RUNNER_LABELS.has(runner)
		)
			return refused("malformed");
		classes.set(name, Object.freeze({ runner, tier, reason }));
	}
	const relay = message.relay;
	if (!relay || !NODE_ID.test(relay.nodeId) || !COMMIT.test(relay.commit))
		return refused("malformed");
	if (expiresAtMs <= issuedAtMs || expiresAtMs <= context.nowMs)
		return refused("expired");
	const route = (name: RoutingSlipClassName): RoutingSlipRoute => {
		const entry = classes.get(name);
		if (!entry) throw new Error("unreachable: every class was parsed");
		return entry;
	};
	return {
		ok: true,
		slip: Object.freeze({
			repository: message.repository,
			issuedAtMs,
			expiresAtMs,
			classes: Object.freeze({
				pr: route("pr"),
				fork: route("fork"),
				trunk: route("trunk"),
			}),
			relay: Object.freeze({ nodeId: relay.nodeId, commit: relay.commit }),
		}),
	};
}

/** The slip, or nothing. */
export function parseRoutingSlip(
	text: string,
	context: RoutingSlipContext,
): ParsedRoutingSlip | undefined {
	const judgement = judgeRoutingSlip(text, context);
	return judgement.ok ? judgement.slip : undefined;
}

/** What the relay decided, to be written as a slip. */
export type RoutingSlipInput = Readonly<{
	repository: string;
	issuedAtMs: number;
	classes: Readonly<Record<RoutingSlipClassName, RoutingSlipRoute>>;
	relay: Readonly<{ nodeId: string; commit: string }>;
}>;

/**
 * The slip's JSON: the message of the commit at `ROUTING_SLIP_REF`. It
 * expires `ROUTING_SLIP_LIFETIME_MS` after it is issued. Throws when the
 * input could not be read back as a slip by a reader holding `labels`.
 */
export function routingSlipJson(
	input: RoutingSlipInput,
	labels: ReadonlySet<string>,
): string {
	const repository = input.repository.toLowerCase();
	const issuedAt = new Date(input.issuedAtMs).toISOString();
	const expiresAtMs = input.issuedAtMs + ROUTING_SLIP_LIFETIME_MS;
	const json = toJsonString(
		RoutingSlipSchema,
		create(RoutingSlipSchema, {
			version: ROUTING_SLIP_VERSION,
			repository,
			issuedAt,
			expiresAt: new Date(expiresAtMs).toISOString(),
			classes: Object.fromEntries(
				ROUTING_SLIP_CLASSES.map((name) => [name, { ...input.classes[name] }]),
			),
			relay: { ...input.relay },
		}),
		{ alwaysEmitImplicit: true },
	);
	const check = judgeRoutingSlip(json, {
		repository,
		nowMs: input.issuedAtMs,
		labels,
	});
	if (!check.ok) throw new Error(`not a routing slip: ${check.why}`);
	return json;
}
