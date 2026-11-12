/**
 * The fleet verdict at its boundaries (`data-models/fleet_verdict.proto`):
 * what a relay tells runner routing about one repository before a run's jobs
 * are queued. It names the fleet labels new work should stay off right now,
 * and nothing else: no capacity figure leaves the relay. A label it does not
 * name is not vouched for, so routing decides it from GitHub's queue.
 *
 * Parse, don't validate: a report or a stored verdict crosses one parser
 * here and comes out as a parsed type the rest of the relay uses without
 * checking again, or as nothing.
 */
import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import {
	FleetReporterEnrollmentsSchema,
	type FleetVerdict,
	FleetVerdictReportSchema,
	FleetVerdictSchema,
} from "./_generated/fleet_verdict_pb.js";
import {
	FLEET_REPORTER_ID,
	FLEET_REPORTER_PUBLIC_KEY,
} from "./fleet-verdict-auth.js";

// public-contract: the relay route runner routing asks for a repository's fleet verdict.
export const FLEET_VERDICTS_PATH = "/v1/fleet/verdicts/";

/** Why a label is blocked; see `FleetVerdictBlock` in the proto. */
export const FLEET_VERDICT_REASONS = ["no-node", "no-capacity"] as const;
export type FleetVerdictReason = (typeof FLEET_VERDICT_REASONS)[number];

/**
 * The longest a verdict stands without being repeated. A reporter repeats it
 * while it holds, so one that has stopped is forgotten within this long, and
 * a single report cannot keep runs off a fleet for an afternoon.
 */
export const FLEET_VERDICT_MAX_TTL_SECONDS = 180;
/** Far more labels than a fleet serves; a report naming more is not one. */
const MAX_BLOCKED_LABELS = 16;

// GitHub's own limits: an owner of at most 39 characters (a managed user's
// login may carry an underscore) and a name of at most 100. Kept in step
// with the route job's pattern in `scripts/ci/route-runner.mts`, and short
// enough for a cache key.
const REPOSITORY_PATH =
	/^\/v1\/fleet\/verdicts\/([A-Za-z0-9][A-Za-z0-9_-]{0,38})\/([A-Za-z0-9_.-]{1,100})$/;
const REPOSITORY = /^[a-z0-9][a-z0-9_-]{0,38}\/[a-z0-9_.-]{1,100}$/;
const LABEL = /^[a-z0-9][a-z0-9_.-]{0,79}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** `owner/name` in lower case: the one spelling a verdict is kept under. */
export type FleetVerdictRepository = string & {
	readonly __brand: "FleetVerdictRepository";
};

/** The repository a verdict route names, or nothing when the path is not one. */
export function parseFleetVerdictPath(
	path: string,
): FleetVerdictRepository | undefined {
	const match = REPOSITORY_PATH.exec(path);
	if (!match?.[1] || !match[2]) return undefined;
	// SAFETY: the pattern admits only an owner and a name, lower-cased here.
	return `${match[1]}/${match[2]}`.toLowerCase() as FleetVerdictRepository;
}

/** A report after parsing: the labels it blocks and how long it stands. */
export type ParsedFleetVerdictReport = Readonly<{
	blocked: ReadonlyMap<string, FleetVerdictReason>;
	ttlMs: number;
}>;

function reasonOf(value: string): FleetVerdictReason | undefined {
	return FLEET_VERDICT_REASONS.find((reason) => reason === value);
}

/**
 * How many labels the text itself names under `blocked`. The decoded record
 * can hold fewer: a key such as `__proto__` is not kept as an entry, and a
 * label that silently went missing must refuse the record, not shrink it.
 */
function namedLabels(text: string): number | undefined {
	try {
		const blocked: unknown = JSON.parse(text)?.blocked;
		if (blocked === undefined) return 0;
		if (Object.prototype.toString.call(blocked) !== "[object Object]")
			return undefined;
		// SAFETY: the tag check proves a plain object, as JSON.parse builds one.
		return Object.keys(blocked as object).length;
	} catch {
		return undefined;
	}
}

/** Labels to reasons, or nothing when any entry is not a label or a reason. */
function parseBlocked(
	blocked: Readonly<Record<string, { readonly reason: string }>>,
	named: number | undefined,
): Map<string, FleetVerdictReason> | undefined {
	const entries = Object.entries(blocked);
	if (entries.length !== named || entries.length > MAX_BLOCKED_LABELS)
		return undefined;
	const parsed = new Map<string, FleetVerdictReason>();
	for (const [name, block] of entries) {
		const label = name.toLowerCase();
		const reason = reasonOf(block.reason);
		if (!LABEL.test(label) || !reason || parsed.has(label)) return undefined;
		parsed.set(label, reason);
	}
	return parsed;
}

/**
 * A report as a reporter sent it. A field the record does not have, a reason
 * it does not know or a lifetime out of range refuses the whole report: a
 * verdict moves runs between runners, so a half-understood one is not acted on.
 */
export function parseFleetVerdictReport(
	text: string,
): ParsedFleetVerdictReport | undefined {
	try {
		const report = fromJsonString(FleetVerdictReportSchema, text);
		const blocked = parseBlocked(report.blocked, namedLabels(text));
		if (
			!blocked ||
			!Number.isInteger(report.ttlSeconds) ||
			report.ttlSeconds < 1 ||
			report.ttlSeconds > FLEET_VERDICT_MAX_TTL_SECONDS
		)
			return undefined;
		return { blocked, ttlMs: report.ttlSeconds * 1000 };
	} catch {
		return undefined;
	}
}

/** The body a reporter sends: labels in order, so equal reports are equal text. */
export function fleetVerdictReportJson(
	blocked: ReadonlyMap<string, FleetVerdictReason>,
	ttlSeconds: number,
): string {
	return toJsonString(
		FleetVerdictReportSchema,
		create(FleetVerdictReportSchema, {
			blocked: orderedBlocks(blocked),
			ttlSeconds,
		}),
	);
}

function orderedBlocks(blocked: ReadonlyMap<string, FleetVerdictReason>) {
	return Object.fromEntries(
		[...blocked]
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([label, reason]) => [label, { reason }]),
	);
}

/** The verdict a relay keeps for a report it received at `nowMs`, by its own clock. */
export function standingFleetVerdict(
	repository: FleetVerdictRepository,
	report: ParsedFleetVerdictReport,
	nowMs: number,
): FleetVerdict {
	if (report.blocked.size === 0) return noFleetVerdict(repository);
	return create(FleetVerdictSchema, {
		repository,
		blocked: orderedBlocks(report.blocked),
		observedAt: new Date(nowMs).toISOString(),
		expiresAt: new Date(nowMs + report.ttlMs).toISOString(),
	});
}

/** What a relay answers when it keeps no verdict: the repository, nothing blocked. */
export function noFleetVerdict(
	repository: FleetVerdictRepository,
): FleetVerdict {
	return create(FleetVerdictSchema, { repository });
}

export function fleetVerdictJson(verdict: FleetVerdict): string {
	return toJsonString(FleetVerdictSchema, verdict, {
		alwaysEmitImplicit: true,
	});
}

/** When a verdict that blocks something stops standing; nothing for one that blocks nothing. */
export function fleetVerdictExpiresAtMs(
	verdict: FleetVerdict,
): number | undefined {
	return verdict.expiresAt === undefined
		? undefined
		: Date.parse(verdict.expiresAt);
}

/**
 * A verdict read back from where it is kept or from a relay's answer. One
 * that blocks a label must say when it was observed and when it lapses.
 */
export function parseFleetVerdict(text: string): FleetVerdict | undefined {
	try {
		const verdict = fromJsonString(FleetVerdictSchema, text);
		const blocked = parseBlocked(verdict.blocked, namedLabels(text));
		if (!blocked || !REPOSITORY.test(verdict.repository)) return undefined;
		if (Object.keys(verdict.blocked).some((label) => !blocked.has(label)))
			return undefined;
		const dated =
			verdict.observedAt !== undefined &&
			verdict.expiresAt !== undefined &&
			INSTANT.test(verdict.observedAt) &&
			INSTANT.test(verdict.expiresAt);
		if (blocked.size > 0 && !dated) return undefined;
		return verdict;
	} catch {
		return undefined;
	}
}

/**
 * Where a relay keeps verdicts. `read` answers only a verdict that still
 * stands; `write` replaces what is kept, and a verdict that blocks nothing
 * removes it.
 */
export type FleetVerdictStore = Readonly<{
	read(repository: FleetVerdictRepository): Promise<FleetVerdict | undefined>;
	write(verdict: FleetVerdict): Promise<void>;
}>;

/** Verdicts kept in this process: enough for one relay host, gone at a restart. */
export function createMemoryFleetVerdicts(
	now: () => number = Date.now,
): FleetVerdictStore {
	const kept = new Map<string, FleetVerdict>();
	return {
		read: async (repository) => {
			const verdict = kept.get(repository);
			const expiresAtMs = verdict && fleetVerdictExpiresAtMs(verdict);
			if (!verdict || expiresAtMs === undefined) return undefined;
			if (expiresAtMs > now()) return verdict;
			kept.delete(repository);
			return undefined;
		},
		write: async (verdict) => {
			if (fleetVerdictExpiresAtMs(verdict) === undefined)
				kept.delete(verdict.repository);
			else kept.set(verdict.repository, verdict);
		},
	};
}

/** At most this many reporters may be enrolled for one account. */
export const FLEET_REPORTERS_PER_ACCOUNT = 8;
/** Verdict-blocked minutes per label per 24-hour window, unless configured. */
export const FLEET_VERDICT_DAILY_BLOCK_MINUTES = 240;
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** One enrolled reporter after parsing: who it is, its key, and what it may block. */
export type FleetReporter = Readonly<{
	id: string;
	/** The raw Ed25519 public key, base64url without padding. */
	publicKey: string;
	accountId: string;
	/** Lower case, each once. */
	labels: readonly string[];
}>;

/** How the hosted relay serves verdicts, from its runtime configuration. */
export type FleetVerdictSettings = Readonly<{
	/** Every enrolled reporter, whatever its account. */
	reporters: readonly FleetReporter[];
	/** False is the kill switch: reads block nothing, reports answer 503. */
	serving: boolean;
	dailyBlockMinutes: number;
}>;

function canonicalPublicKey(value: string): boolean {
	if (!FLEET_REPORTER_PUBLIC_KEY.test(value)) return false;
	const bytes = Buffer.from(value, "base64url");
	return bytes.length === 32 && bytes.toString("base64url") === value;
}

/**
 * The enrolled reporters `HOBO_CI_FLEET_REPORTERS_JSON` names, or nothing
 * when it is not a whole enrollment: an unknown field (a private key, say),
 * a malformed id, key, account or label, a reporter listed twice, or more
 * than eight reporters for one account refuses all of it.
 */
export function parseFleetReporters(
	text: string,
): readonly FleetReporter[] | undefined {
	try {
		const enrollment = fromJsonString(FleetReporterEnrollmentsSchema, text);
		const ids = new Set<string>();
		const perAccount = new Map<string, number>();
		const reporters: FleetReporter[] = [];
		for (const entry of enrollment.reporters) {
			const labels = entry.labels.map((label) => label.toLowerCase());
			if (
				!FLEET_REPORTER_ID.test(entry.id) ||
				ids.has(entry.id) ||
				!canonicalPublicKey(entry.publicKey) ||
				!ACCOUNT_ID.test(entry.accountId) ||
				labels.length === 0 ||
				labels.length > MAX_BLOCKED_LABELS ||
				new Set(labels).size !== labels.length ||
				labels.some((label) => !LABEL.test(label))
			)
				return undefined;
			const count = (perAccount.get(entry.accountId) ?? 0) + 1;
			if (count > FLEET_REPORTERS_PER_ACCOUNT) return undefined;
			perAccount.set(entry.accountId, count);
			ids.add(entry.id);
			reporters.push(
				Object.freeze({
					id: entry.id,
					publicKey: entry.publicKey,
					accountId: entry.accountId,
					labels: Object.freeze([...labels].sort()),
				}),
			);
		}
		return Object.freeze(reporters);
	} catch {
		return undefined;
	}
}
