/**
 * The fleet verdict at its boundaries (`data-models/fleet_verdict.proto`):
 * what a relay tells runner routing about one repository before a run's jobs
 * are queued. It names the fleet labels new work should stay off right now,
 * and nothing else: no capacity figure leaves the relay. A label it does not
 * name is not vouched for, so routing decides it from GitHub's queue.
 *
 * The box relay decides; the hosted relay keeps, agrees and serves
 * (ADR-0180). It keeps each enrolled reporter's last signed report until it
 * expires, serves a label blocked only while every reporter enrolled for it
 * blocks it in `report` mode, and stops serving a block once the label has
 * been blocked for its daily allowance.
 *
 * Parse, don't validate: a report or a stored record crosses one parser
 * here and comes out as a parsed type the rest of the relay uses without
 * checking again, or as nothing.
 */
import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import {
	FleetReporterEnrollmentsSchema,
	type FleetReporterLabelState,
	FleetReporterLabelStateSchema,
	type FleetReporterState,
	FleetReporterStateSchema,
	type FleetReporterStatusList,
	FleetReporterStatusListSchema,
	FleetReporterStatusSchema,
	type FleetVerdict,
	type FleetVerdictAllowance,
	FleetVerdictAllowanceSchema,
	type FleetVerdictLabelAllowance,
	FleetVerdictLabelAllowanceSchema,
	FleetVerdictReportSchema,
	FleetVerdictSchema,
} from "./_generated/fleet_verdict_pb.js";
import {
	FLEET_REPORTER_ID,
	FLEET_REPORTER_PUBLIC_KEY,
} from "./fleet-verdict-auth.js";

// public-contract: the relay route runner routing asks for a repository's fleet verdict.
export const FLEET_VERDICTS_PATH = "/v1/fleet/verdicts/";
// public-contract: the relay route a repository's workflows read its reporters' status from.
export const FLEET_REPORTERS_PATH = "/v1/fleet/reporters/";

/** Why a label is blocked; see `FleetVerdictBlock` in the proto. */
export const FLEET_VERDICT_REASONS = ["no-node", "no-capacity"] as const;
export type FleetVerdictReason = (typeof FLEET_VERDICT_REASONS)[number];

/** `shadow` reports are kept and shown, never served; `report` reports count. */
export const FLEET_VERDICT_MODES = ["shadow", "report"] as const;
export type FleetVerdictMode = (typeof FLEET_VERDICT_MODES)[number];

/**
 * The longest a report stands without being repeated. A reporter repeats it
 * every minute while it holds, so one that has stopped is forgotten within
 * this long, and it is the most blocked time one report can account for.
 */
export const FLEET_VERDICT_MAX_TTL_SECONDS = 180;
/** Verdict-blocked minutes per label per 24-hour window, unless configured. */
export const FLEET_VERDICT_DAILY_BLOCK_MINUTES = 240;
/** What the relay keeps of a reporter, and an allowance window, lasts a day. */
const DAY_MS = 24 * 60 * 60 * 1000;
/** Far more labels than a fleet serves; a report naming more is not one. */
const MAX_BLOCKED_LABELS = 16;
/** At most this many reporters may be enrolled for one account. */
export const FLEET_REPORTERS_PER_ACCOUNT = 8;
/** A lost race on the cache is tried again this many times, then refused. */
const ATTEMPTS = 8;

// GitHub's own limits: an owner of at most 39 characters (a managed user's
// login may carry an underscore) and a name of at most 100. Kept in step
// with the route job's pattern in `scripts/ci/route-runner.mts`, and short
// enough for a cache key.
const OWNER_AND_NAME =
	"([A-Za-z0-9][A-Za-z0-9_-]{0,38})\\/([A-Za-z0-9_.-]{1,100})";
const VERDICT_PATH = new RegExp(
	`^\\/v1\\/fleet\\/verdicts\\/${OWNER_AND_NAME}$`,
);
const REPORTERS_PATH = new RegExp(
	`^\\/v1\\/fleet\\/reporters\\/${OWNER_AND_NAME}$`,
);
const REPOSITORY = /^[a-z0-9][a-z0-9_-]{0,38}\/[a-z0-9_.-]{1,100}$/;
const LABEL = /^[a-z0-9][a-z0-9_.-]{0,79}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** `owner/name` in lower case: the one spelling a verdict is kept under. */
export type FleetVerdictRepository = string & {
	readonly __brand: "FleetVerdictRepository";
};

function repositoryOf(
	pattern: RegExp,
	path: string,
): FleetVerdictRepository | undefined {
	const match = pattern.exec(path);
	if (!match?.[1] || !match[2]) return undefined;
	// SAFETY: the pattern admits only an owner and a name, lower-cased here.
	return `${match[1]}/${match[2]}`.toLowerCase() as FleetVerdictRepository;
}

/** The repository a verdict route names, or nothing when the path is not one. */
export function parseFleetVerdictPath(
	path: string,
): FleetVerdictRepository | undefined {
	return repositoryOf(VERDICT_PATH, path);
}

/** The repository a reporter status route names, or nothing. */
export function parseFleetReportersPath(
	path: string,
): FleetVerdictRepository | undefined {
	return repositoryOf(REPORTERS_PATH, path);
}

/** A report after parsing: the labels it blocks, how long it stands, its mode. */
export type ParsedFleetVerdictReport = Readonly<{
	blocked: ReadonlyMap<string, FleetVerdictReason>;
	ttlMs: number;
	mode: FleetVerdictMode;
}>;

function reasonOf(value: string): FleetVerdictReason | undefined {
	return FLEET_VERDICT_REASONS.find((reason) => reason === value);
}

function modeOf(value: string): FleetVerdictMode | undefined {
	return FLEET_VERDICT_MODES.find((mode) => mode === value);
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
 * or mode it does not know, or a lifetime out of range refuses the whole
 * report: a verdict moves runs between runners, so a half-understood one is
 * not acted on.
 */
export function parseFleetVerdictReport(
	text: string,
): ParsedFleetVerdictReport | undefined {
	try {
		const report = fromJsonString(FleetVerdictReportSchema, text);
		const blocked = parseBlocked(report.blocked, namedLabels(text));
		const mode = modeOf(report.mode);
		if (
			!blocked ||
			!mode ||
			!Number.isInteger(report.ttlSeconds) ||
			report.ttlSeconds < 1 ||
			report.ttlSeconds > FLEET_VERDICT_MAX_TTL_SECONDS
		)
			return undefined;
		return { blocked, ttlMs: report.ttlSeconds * 1000, mode };
	} catch {
		return undefined;
	}
}

/** The body a reporter sends: labels in order, so equal reports are equal text. */
export function fleetVerdictReportJson(
	blocked: ReadonlyMap<string, FleetVerdictReason>,
	ttlSeconds: number,
	mode: FleetVerdictMode,
): string {
	return toJsonString(
		FleetVerdictReportSchema,
		create(FleetVerdictReportSchema, {
			blocked: orderedBlocks(blocked),
			ttlSeconds,
			mode,
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

/**
 * The entry a relay keeps for one reporter's report received at `nowMs`, by
 * its own clock. It is dated even when it blocks nothing: while it stands,
 * the reporter is live and its "open" counts. A `shadow` report is kept as
 * blocking nothing, since it must never be served; what it said is in the
 * reporter's state.
 */
export function reportedFleetVerdict(
	repository: FleetVerdictRepository,
	report: ParsedFleetVerdictReport,
	nowMs: number,
): FleetVerdict {
	return create(FleetVerdictSchema, {
		repository,
		blocked: report.mode === "report" ? orderedBlocks(report.blocked) : {},
		observedAt: new Date(nowMs).toISOString(),
		expiresAt: new Date(nowMs + report.ttlMs).toISOString(),
	});
}

/** What a relay answers when nothing is blocked: the repository, nothing more. */
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

/** When a dated verdict stops standing; nothing for one that is not dated. */
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

/** One enrolled reporter after parsing: who it is, its key, and what it may block. */
export type FleetReporter = Readonly<{
	id: string;
	/** The raw Ed25519 public key, base64url without padding. */
	publicKey: string;
	accountId: string;
	/** Lower case, each once, in order. */
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

/** Who must agree for one repository: the reporters enrolled for its account. */
export type FleetEnrollment = Readonly<{
	reporters: readonly FleetReporter[];
	dailyBlockMinutes: number;
}>;

/** The enrollment that governs a repository connected under `accountId`. */
export function fleetEnrollmentFor(
	settings: FleetVerdictSettings,
	accountId: string,
): FleetEnrollment {
	return {
		reporters: settings.reporters.filter(
			(reporter) => reporter.accountId === accountId,
		),
		dailyBlockMinutes: settings.dailyBlockMinutes,
	};
}

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

function datedOrAbsent(value: string | undefined): boolean {
	return value === undefined || INSTANT.test(value);
}

/** A reporter's state as the relay keeps it, or nothing when it is not one. */
export function parseFleetReporterState(
	text: string,
): FleetReporterState | undefined {
	try {
		const state = fromJsonString(FleetReporterStateSchema, text);
		if (
			state.lastSequence < 1n ||
			!modeOf(state.mode) ||
			!INSTANT.test(state.lastReportAt) ||
			Object.entries(state.labels).some(
				([label, entry]) =>
					!LABEL.test(label) ||
					!datedOrAbsent(entry.lastBlockedAt) ||
					!datedOrAbsent(entry.lastClearedAt),
			)
		)
			return undefined;
		return state;
	} catch {
		return undefined;
	}
}

export function fleetReporterStateJson(state: FleetReporterState): string {
	return toJsonString(FleetReporterStateSchema, state);
}

function blockedIn(entry: FleetReporterLabelState | undefined): boolean {
	if (entry?.lastBlockedAt === undefined) return false;
	return (
		entry.lastClearedAt === undefined ||
		Date.parse(entry.lastClearedAt) < Date.parse(entry.lastBlockedAt)
	);
}

/**
 * The reporter's state after one more accepted report. Per label the
 * reporter serves, `lastBlockedAt` moves only when the report blocks a
 * label that was clear, and `lastClearedAt` only when it clears one that was
 * blocked: they mark changes, not repeats. Shadow reports count here too.
 */
export function nextFleetReporterState(
	previous: FleetReporterState | undefined,
	reporter: FleetReporter,
	sequence: bigint,
	report: ParsedFleetVerdictReport,
	nowMs: number,
): FleetReporterState {
	const at = new Date(nowMs).toISOString();
	const labels: Record<string, FleetReporterLabelState> = {};
	for (const label of reporter.labels) {
		const before = previous?.labels[label];
		const blocks = report.blocked.has(label);
		const was = blockedIn(before);
		const next = create(FleetReporterLabelStateSchema);
		const blockedAt = blocks && !was ? at : before?.lastBlockedAt;
		const clearedAt = !blocks && was ? at : before?.lastClearedAt;
		if (blockedAt !== undefined) next.lastBlockedAt = blockedAt;
		if (clearedAt !== undefined) next.lastClearedAt = clearedAt;
		if (blockedAt !== undefined || clearedAt !== undefined)
			labels[label] = next;
	}
	return create(FleetReporterStateSchema, {
		lastSequence: sequence,
		mode: report.mode,
		lastReportAt: at,
		labels,
	});
}

/** The allowance the relay keeps for a repository, or nothing when it is not one. */
export function parseFleetVerdictAllowance(
	text: string,
): FleetVerdictAllowance | undefined {
	try {
		const allowance = fromJsonString(FleetVerdictAllowanceSchema, text);
		if (
			Object.entries(allowance.labels).some(
				([label, entry]) =>
					!LABEL.test(label) ||
					!INSTANT.test(entry.windowStart) ||
					!datedOrAbsent(entry.lastCountedAt),
			)
		)
			return undefined;
		return allowance;
	} catch {
		return undefined;
	}
}

export function fleetVerdictAllowanceJson(
	allowance: FleetVerdictAllowance,
): string {
	return toJsonString(FleetVerdictAllowanceSchema, allowance);
}

/**
 * The allowance after one accepted report. `before` and `after` are the
 * labels the agreed verdict blocked just before and just after it. For each
 * label blocked before, the time since it was last counted is added, capped
 * at a report's lifetime, so two reporters blocking together are counted
 * once and a silent spell counts no more than one report could have stood.
 * A label blocked after is marked counted now, starting a window at its
 * first counted second; one open after stops being counted. A window lasts
 * a day; a label whose window has passed starts again.
 */
export function countFleetVerdictAllowance(
	previous: FleetVerdictAllowance | undefined,
	before: ReadonlySet<string>,
	after: ReadonlySet<string>,
	nowMs: number,
): FleetVerdictAllowance {
	const at = new Date(nowMs).toISOString();
	const labels: Record<string, FleetVerdictLabelAllowance> = {};
	const names = new Set([
		...Object.keys(previous?.labels ?? {}),
		...before,
		...after,
	]);
	for (const label of [...names].sort()) {
		const kept = previous?.labels[label];
		const current =
			kept && nowMs - Date.parse(kept.windowStart) < DAY_MS ? kept : undefined;
		let windowStart = current?.windowStart;
		let blockedSeconds = current?.blockedSeconds ?? 0;
		if (before.has(label) && kept?.lastCountedAt !== undefined) {
			const since = Math.max(0, nowMs - Date.parse(kept.lastCountedAt));
			const counted = Math.round(
				Math.min(since, FLEET_VERDICT_MAX_TTL_SECONDS * 1000) / 1000,
			);
			windowStart ??= kept.lastCountedAt;
			blockedSeconds += counted;
		}
		if (after.has(label)) windowStart ??= at;
		if (windowStart === undefined) continue;
		const entry = create(FleetVerdictLabelAllowanceSchema, {
			windowStart,
			blockedSeconds,
		});
		if (after.has(label)) entry.lastCountedAt = at;
		labels[label] = entry;
	}
	return create(FleetVerdictAllowanceSchema, { labels });
}

/** Whether a label's allowance is spent at `nowMs`: it is then served open. */
export function fleetAllowanceSpent(
	allowance: FleetVerdictAllowance | undefined,
	label: string,
	dailyBlockMinutes: number,
	nowMs: number,
): boolean {
	const entry = allowance?.labels[label];
	return (
		entry !== undefined &&
		nowMs - Date.parse(entry.windowStart) < DAY_MS &&
		entry.blockedSeconds >= dailyBlockMinutes * 60
	);
}

/** A label the agreed verdict blocks, with when the block was seen and lapses. */
type AgreedBlock = Readonly<{
	reason: FleetVerdictReason;
	observedAtMs: number;
	expiresAtMs: number;
}>;

/**
 * The labels every reporter enrolled for them blocks, live and in `report`
 * mode. One that is silent, in shadow or says the label is open leaves it
 * open; one that does not serve the label has no say. `entries` holds each
 * reporter's kept entry by reporter id. The block is observed when the last
 * of them reported it, and lapses when the first of them does.
 */
export function agreedFleetBlocks(
	reporters: readonly FleetReporter[],
	entries: ReadonlyMap<string, FleetVerdict>,
	nowMs: number,
): ReadonlyMap<string, AgreedBlock> {
	const labels = new Set(reporters.flatMap((reporter) => reporter.labels));
	const agreed = new Map<string, AgreedBlock>();
	for (const label of [...labels].sort()) {
		let block: AgreedBlock | undefined;
		for (const reporter of reporters) {
			if (!reporter.labels.includes(label)) continue;
			const entry = entries.get(reporter.id);
			const expiresAtMs = entry && fleetVerdictExpiresAtMs(entry);
			const reason = entry?.blocked[label]?.reason;
			const observedAtMs =
				entry?.observedAt === undefined
					? Number.NaN
					: Date.parse(entry.observedAt);
			const known = reason === undefined ? undefined : reasonOf(reason);
			if (
				!known ||
				expiresAtMs === undefined ||
				!(expiresAtMs > nowMs) ||
				!Number.isFinite(observedAtMs)
			) {
				block = undefined;
				break;
			}
			block = {
				reason: block?.reason ?? known,
				observedAtMs: Math.max(block?.observedAtMs ?? 0, observedAtMs),
				expiresAtMs: Math.min(block?.expiresAtMs ?? expiresAtMs, expiresAtMs),
			};
		}
		if (block) agreed.set(label, block);
	}
	return agreed;
}

/** The verdict a relay serves for agreed blocks, less any label whose allowance is spent. */
function servedFleetVerdict(
	repository: FleetVerdictRepository,
	agreed: ReadonlyMap<string, AgreedBlock>,
	allowance: FleetVerdictAllowance | undefined,
	dailyBlockMinutes: number,
	nowMs: number,
): FleetVerdict {
	const served = [...agreed].filter(
		([label]) =>
			!fleetAllowanceSpent(allowance, label, dailyBlockMinutes, nowMs),
	);
	if (served.length === 0) return noFleetVerdict(repository);
	return create(FleetVerdictSchema, {
		repository,
		blocked: Object.fromEntries(
			served.map(([label, block]) => [label, { reason: block.reason }]),
		),
		observedAt: new Date(
			Math.max(...served.map(([, block]) => block.observedAtMs)),
		).toISOString(),
		expiresAt: new Date(
			Math.min(...served.map(([, block]) => block.expiresAtMs)),
		).toISOString(),
	});
}

/** One kept value and the version a conditional write must name. */
export type FleetVerdictKvEntry<Version extends string = string> = Readonly<{
	value: string;
	version: Version;
}>;

/**
 * The key/value store the verdicts live on: the relay's cache, or this
 * process's memory. `write` replaces a value only while the key is still at
 * `expected` (absent when `expected` is undefined), and answers false on a
 * lost race.
 */
export type FleetVerdictKv<
	Key extends string = string,
	Version extends string = string,
> = Readonly<{
	getMany(
		keys: readonly Key[],
	): Promise<readonly (FleetVerdictKvEntry<Version> | undefined)[]>;
	write(
		key: Key,
		value: string,
		ttlMs: number,
		expected: Version | undefined,
	): Promise<boolean>;
}>;

/** The three keys of ADR-0180, per repository and reporter. */
export type FleetVerdictKeys<Key extends string = string> = Readonly<{
	/** The reporter's last report, until it expires. */
	verdict(repository: FleetVerdictRepository, reporterId: string): Key;
	/** The reporter's state, for a day after its last accepted report. */
	reporter(repository: FleetVerdictRepository, reporterId: string): Key;
	/** The repository's allowance, a day from its window's start. */
	allowance(repository: FleetVerdictRepository): Key;
}>;

/** A report that has passed every check the route makes. */
export type FleetVerdictSubmission = Readonly<{
	repository: FleetVerdictRepository;
	reporter: FleetReporter;
	sequence: bigint;
	report: ParsedFleetVerdictReport;
}>;

export type FleetVerdictAcceptance =
	| Readonly<{ accepted: true; entry: FleetVerdict }>
	| Readonly<{ accepted: false; reason: "replayed" }>;

/**
 * Where the hosted relay keeps verdicts (ADR-0180). `read` answers the
 * agreed verdict for a repository's enrollment; `accept` keeps one report,
 * refusing a sequence it has already seen from that reporter, and counts the
 * allowance; `status` shows every enrolled reporter and the allowance.
 */
export type FleetVerdictStore = Readonly<{
	read(
		repository: FleetVerdictRepository,
		enrolled: FleetEnrollment,
	): Promise<FleetVerdict>;
	/** The highest sequence accepted from the reporter for the repository. */
	lastSequence(
		repository: FleetVerdictRepository,
		reporterId: string,
	): Promise<bigint | undefined>;
	accept(
		submission: FleetVerdictSubmission,
		enrolled: FleetEnrollment,
	): Promise<FleetVerdictAcceptance>;
	status(
		repository: FleetVerdictRepository,
		enrolled: FleetEnrollment,
	): Promise<FleetReporterStatusList>;
}>;

function kept<T>(
	entry: Readonly<{ value: string }> | undefined,
	parse: (text: string) => T | undefined,
): T | undefined {
	return entry === undefined ? undefined : parse(entry.value);
}

/** The verdict store over any key/value binding; one implementation, two homes. */
export function createFleetVerdictStore<
	Key extends string,
	Version extends string,
>(options: {
	kv: FleetVerdictKv<Key, Version>;
	keys: FleetVerdictKeys<Key>;
	now?: () => number;
}): FleetVerdictStore {
	const { kv, keys } = options;
	const now = options.now ?? Date.now;

	/** Each enrolled reporter's entry, by id, and the allowance: one round trip. */
	async function readAgreement(
		repository: FleetVerdictRepository,
		reporters: readonly FleetReporter[],
		extra: readonly Key[] = [],
	) {
		const read = await kv.getMany([
			...reporters.map((reporter) => keys.verdict(repository, reporter.id)),
			keys.allowance(repository),
			...extra,
		]);
		const entries = new Map<string, FleetVerdict>();
		reporters.forEach((reporter, index) => {
			const entry = kept(read[index], parseFleetVerdict);
			if (entry) entries.set(reporter.id, entry);
		});
		const allowanceEntry = read[reporters.length];
		return {
			entries,
			allowanceEntry,
			allowance: kept(allowanceEntry, parseFleetVerdictAllowance),
			extra: read.slice(reporters.length + 1),
		};
	}

	/** Write `value` whatever is there, trying again on a lost race. */
	async function put(key: Key, value: string, ttlMs: number) {
		for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
			const [current] = await kv.getMany([key]);
			if (await kv.write(key, value, ttlMs, current?.version)) return;
		}
		throw new Error("fleet verdict contended");
	}

	async function countAllowance(
		repository: FleetVerdictRepository,
		first: FleetVerdictKvEntry<Version> | undefined,
		before: ReadonlySet<string>,
		after: ReadonlySet<string>,
	) {
		const key = keys.allowance(repository);
		let current = first;
		for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
			const nowMs = now();
			const next = countFleetVerdictAllowance(
				kept(current, parseFleetVerdictAllowance),
				before,
				after,
				nowMs,
			);
			const starts = Object.values(next.labels).map((entry) =>
				Date.parse(entry.windowStart),
			);
			if (starts.length === 0 && current === undefined) return;
			const ttlMs = Math.max(1000, Math.max(nowMs, ...starts) + DAY_MS - nowMs);
			if (
				await kv.write(
					key,
					fleetVerdictAllowanceJson(next),
					ttlMs,
					current?.version,
				)
			)
				return;
			[current] = await kv.getMany([key]);
		}
		throw new Error("fleet verdict allowance contended");
	}

	return {
		async read(repository, enrolled) {
			// Nobody enrolled for this account: nothing can be blocked, nothing read.
			if (enrolled.reporters.length === 0) return noFleetVerdict(repository);
			const { entries, allowance } = await readAgreement(
				repository,
				enrolled.reporters,
			);
			const nowMs = now();
			return servedFleetVerdict(
				repository,
				agreedFleetBlocks(enrolled.reporters, entries, nowMs),
				allowance,
				enrolled.dailyBlockMinutes,
				nowMs,
			);
		},
		async lastSequence(repository, reporterId) {
			const [entry] = await kv.getMany([keys.reporter(repository, reporterId)]);
			return kept(entry, parseFleetReporterState)?.lastSequence;
		},
		async accept(submission, enrolled) {
			const { repository, reporter, sequence, report } = submission;
			const stateKey = keys.reporter(repository, reporter.id);
			for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
				const { entries, allowanceEntry, extra } = await readAgreement(
					repository,
					enrolled.reporters,
					[stateKey],
				);
				const stateEntry = extra[0];
				const previous = kept(stateEntry, parseFleetReporterState);
				if (previous && previous.lastSequence >= sequence)
					return { accepted: false, reason: "replayed" };
				const nowMs = now();
				const before = new Set(
					agreedFleetBlocks(enrolled.reporters, entries, nowMs).keys(),
				);
				// The sequence is claimed first: of two equal reports, one wins.
				if (
					!(await kv.write(
						stateKey,
						fleetReporterStateJson(
							nextFleetReporterState(
								previous,
								reporter,
								sequence,
								report,
								nowMs,
							),
						),
						DAY_MS,
						stateEntry?.version,
					))
				)
					continue;
				const entry = reportedFleetVerdict(repository, report, nowMs);
				await put(
					keys.verdict(repository, reporter.id),
					fleetVerdictJson(entry),
					report.ttlMs,
				);
				const after = new Set(
					agreedFleetBlocks(
						enrolled.reporters,
						new Map([...entries, [reporter.id, entry]]),
						nowMs,
					).keys(),
				);
				await countAllowance(repository, allowanceEntry, before, after);
				return { accepted: true, entry };
			}
			throw new Error("fleet reporter state contended");
		},
		async status(repository, enrolled) {
			const reporters = enrolled.reporters;
			const { entries, allowance, extra } = await readAgreement(
				repository,
				reporters,
				reporters.map((reporter) => keys.reporter(repository, reporter.id)),
			);
			const nowMs = now();
			const allowanceUse = Object.fromEntries(
				Object.entries(allowance?.labels ?? {})
					.filter(([, entry]) => nowMs - Date.parse(entry.windowStart) < DAY_MS)
					.map(([label, entry]) => [
						label,
						{
							usedSeconds: entry.blockedSeconds,
							spent: fleetAllowanceSpent(
								allowance,
								label,
								enrolled.dailyBlockMinutes,
								nowMs,
							),
							windowStart: entry.windowStart,
						},
					]),
			);
			return create(FleetReporterStatusListSchema, {
				repository,
				reporters: reporters.map((reporter, index) => {
					const entry = entries.get(reporter.id);
					const expiresAtMs = entry && fleetVerdictExpiresAtMs(entry);
					const state = kept(extra[index], parseFleetReporterState);
					const status = create(FleetReporterStatusSchema, {
						id: reporter.id,
						labels: [...reporter.labels],
						live: expiresAtMs !== undefined && expiresAtMs > nowMs,
					});
					if (state) status.state = state;
					return status;
				}),
				allowance: allowanceUse,
				dailyBlockMinutes: enrolled.dailyBlockMinutes,
			});
		},
	};
}

export function fleetReporterStatusListJson(
	list: FleetReporterStatusList,
): string {
	return toJsonString(FleetReporterStatusListSchema, list, {
		alwaysEmitImplicit: true,
	});
}

/**
 * A key/value store in this process, with each key's time to live read from
 * `now`: what a relay host without a cache keeps verdicts on. A restart
 * forgets everything, which is the same as every report lapsing at once.
 */
export function createMemoryFleetVerdictKv(
	now: () => number = Date.now,
): FleetVerdictKv {
	const values = new Map<
		string,
		{ value: string; version: string; expiresAtMs: number }
	>();
	let versions = 0;
	const live = (key: string) => {
		const entry = values.get(key);
		if (entry && entry.expiresAtMs > now()) return entry;
		values.delete(key);
		return undefined;
	};
	return {
		getMany: async (keys) =>
			keys.map((key) => {
				const entry = live(key);
				return entry && { value: entry.value, version: entry.version };
			}),
		write: async (key, value, ttlMs, expected) => {
			if (live(key)?.version !== expected) return false;
			versions += 1;
			values.set(key, {
				value,
				version: String(versions),
				expiresAtMs: now() + ttlMs,
			});
			return true;
		},
	};
}

/** The plain keys a store in memory uses. */
export const MEMORY_FLEET_VERDICT_KEYS: FleetVerdictKeys = Object.freeze({
	verdict: (repository: string, reporterId: string) =>
		`fleet-verdict:${repository}:${reporterId}`,
	reporter: (repository: string, reporterId: string) =>
		`fleet-reporter:${repository}:${reporterId}`,
	allowance: (repository: string) => `fleet-allowance:${repository}`,
});

/** Verdicts kept in this process: enough for one relay host, gone at a restart. */
export function createMemoryFleetVerdicts(
	now: () => number = Date.now,
	kv: FleetVerdictKv = createMemoryFleetVerdictKv(now),
): FleetVerdictStore {
	return createFleetVerdictStore({ kv, keys: MEMORY_FLEET_VERDICT_KEYS, now });
}
