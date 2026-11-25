// Pure change-window evaluation (D10, I17). FREEZE dominates ALLOW; an
// unexpired override lifts one window for the Camps it names; rollback is
// blocked only by a FREEZE that forbids it. Anything that cannot be decided
// (an unknown window name, a rule that cannot be expanded) closes the window
// for changes: fail closed.
import {
	type ChangeWindowRecord,
	type ReasonRecord,
	type SelectorRecord,
	WindowKind,
} from "../_generated/cd_pb.js";
import type { DeltaIntent, Outcome, WindowEvaluation } from "../ports.js";
import { reason, WINDOW_REASON } from "./reasons.js";
import {
	occurrenceStarts,
	parseRrule,
	RecurrenceLimitError,
	type Series,
} from "./rrule.js";
import { isTimeZone } from "./zoned.js";

// public-contract: Camp label keys a window selector's jurisdiction and Bindle
// dimensions are read from (WindowEvaluation input carries labels only).
export const WINDOW_LABELS = Object.freeze({
	jurisdiction: "hobo.cd/jurisdiction",
	bindle: "hobo.cd/bindle",
} as const);

// public-contract: evaluation bounds.
export const WINDOW_LIMITS = Object.freeze({
	/** Longest single occurrence. */
	maxDurationMs: 366 * 86_400_000,
	/** How far ahead `nextOpenAtMs` searches. */
	nextOpenHorizonMs: 366 * 86_400_000,
	/** Occurrences per window considered when searching for the next opening. */
	maxBoundaryOccurrences: 2_000,
} as const);

const SLUG = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const TIMESTAMP =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

// domain-view: parse-don't-validate derived type of ChangeWindowRecord (cd.proto) with its rule expanded and durations as numbers.
export type CompiledWindow = Readonly<{
	record: ChangeWindowRecord;
	name: string;
	kind: "ALLOW" | "FREEZE";
	series: Series;
	durationMs: number;
	rollbackAllowed: boolean;
	selector?: SelectorRecord | undefined;
}>;

/** An override in force: lifts `window` for `campIds` until `expiresAtMs`. */
export type ActiveOverride = Readonly<{
	window: string;
	campIds: readonly string[];
	expiresAtMs: number;
}>;

export type EvaluationInput = Readonly<{
	campId: string;
	labels: Readonly<Record<string, string>>;
	envType: string;
	windowNames: readonly string[];
	atMs: number;
	intent: DeltaIntent;
}>;

/** Epoch ms of an RFC 3339 timestamp, or undefined. */
export function parseTimestamp(value: string): number | undefined {
	if (!TIMESTAMP.test(value)) return undefined;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Parse a ChangeWindowRecord into its compiled form, reporting every problem
 * at once. Single-occurrence windows use [starts_at, ends_at) (or
 * starts_at + duration_ms); recurring windows use duration_ms, else the
 * length of the first occurrence (ends_at − starts_at).
 */
export function compileWindow(
	record: ChangeWindowRecord,
): Outcome<CompiledWindow> {
	const problems: ReasonRecord[] = [];
	const problem = (field: string, message: string, remediation: string) =>
		problems.push(reason(WINDOW_REASON.invalid, message, remediation, field));
	if (!SLUG.test(record.name))
		problem(
			"name",
			`window name "${record.name}" is not a slug`,
			"Use 1–63 lowercase letters, digits and hyphens.",
		);
	const kind =
		record.kind === WindowKind.ALLOW
			? "ALLOW"
			: record.kind === WindowKind.FREEZE
				? "FREEZE"
				: undefined;
	if (!kind)
		problem(
			"kind",
			"window kind is unspecified",
			"Set kind to ALLOW or FREEZE.",
		);
	if (!isTimeZone(record.timezone))
		problems.push(
			reason(
				WINDOW_REASON.timezoneInvalid,
				`time zone "${record.timezone}" is not an IANA zone this runtime knows`,
				"Use an IANA zone name such as America/Chicago, Europe/London or UTC.",
				"timezone",
			),
		);
	const startMs = parseTimestamp(record.startsAt);
	if (startMs === undefined)
		problem(
			"startsAt",
			"starts_at is not an RFC 3339 timestamp",
			"Set starts_at, e.g. 2026-11-12T09:00:00Z.",
		);
	const endMs =
		record.endsAt === "" ? undefined : parseTimestamp(record.endsAt);
	if (record.endsAt !== "" && endMs === undefined)
		problem(
			"endsAt",
			"ends_at is not an RFC 3339 timestamp",
			"Set ends_at, e.g. 2026-11-12T17:00:00Z, or leave it empty.",
		);
	const declared = Number(record.durationMs);
	let durationMs = 0;
	if (startMs !== undefined) {
		if (declared > 0) durationMs = declared;
		else if (endMs !== undefined) durationMs = endMs - startMs;
	}
	if (startMs !== undefined) {
		if (
			declared > 0 &&
			endMs !== undefined &&
			record.rrule === "" &&
			endMs - startMs !== declared
		)
			problem(
				"durationMs",
				"duration_ms disagrees with ends_at − starts_at",
				"Set one of duration_ms or ends_at for a single-occurrence window.",
			);
		if (durationMs <= 0)
			problem(
				"durationMs",
				"the window has no length",
				"Set duration_ms > 0, or ends_at after starts_at.",
			);
		if (durationMs > WINDOW_LIMITS.maxDurationMs)
			problem(
				"durationMs",
				"an occurrence may last at most 366 days",
				"Split the window, or use a recurring rule.",
			);
	}
	let rule: Series["rule"];
	if (record.rrule !== "") {
		const parsed = parseRrule(record.rrule);
		if (parsed.ok) rule = parsed.value;
		else problems.push(...parsed.reasons);
	}
	if (problems.length > 0 || !kind || startMs === undefined)
		return { ok: false, reasons: problems };
	const compiled: CompiledWindow = {
		record,
		name: record.name,
		kind,
		series: { startMs, timeZone: record.timezone, rule },
		durationMs,
		rollbackAllowed: record.rollbackAllowed,
		selector: record.selector,
	};
	return { ok: true, value: compiled };
}

/** End of an occurrence containing `atMs`, or undefined when none does. */
export function activeUntil(
	window: CompiledWindow,
	atMs: number,
): number | undefined {
	let end: number | undefined;
	for (const start of occurrenceStarts(
		window.series,
		atMs - window.durationMs + 1,
	)) {
		if (start > atMs) break;
		end = start + window.durationMs;
	}
	return end;
}

/**
 * Does a selector cover the Camp? Every non-empty dimension must match. A
 * dimension the input cannot answer (no jurisdiction or Bindle label) is
 * resolved against the window: it matches for a FREEZE and not for an ALLOW,
 * so uncertainty always narrows what is permitted.
 */
export function selectorCovers(
	selector: SelectorRecord | undefined,
	kind: CompiledWindow["kind"],
	input: Pick<EvaluationInput, "campId" | "labels" | "envType">,
): boolean {
	if (!selector) return true;
	const unknown = kind === "FREEZE";
	for (const [key, value] of Object.entries(selector.labels)) {
		if (input.labels[key] !== value) return false;
	}
	if (selector.campIds.length > 0 && !selector.campIds.includes(input.campId))
		return false;
	if (
		selector.envTypes.length > 0 &&
		!selector.envTypes.includes(input.envType)
	)
		return false;
	const labelled = (values: readonly string[], key: string): boolean => {
		if (values.length === 0) return true;
		const label = input.labels[key];
		return label === undefined ? unknown : values.includes(label);
	};
	return (
		labelled(selector.jurisdictions, WINDOW_LABELS.jurisdiction) &&
		labelled(selector.bindles, WINDOW_LABELS.bindle)
	);
}

function isEmptySelector(selector: SelectorRecord | undefined): boolean {
	return (
		!selector ||
		(Object.keys(selector.labels).length === 0 &&
			selector.campIds.length === 0 &&
			selector.envTypes.length === 0 &&
			selector.jurisdictions.length === 0 &&
			selector.bindles.length === 0)
	);
}

/**
 * Windows that apply to the Camp: those the node names (narrowed by their
 * selector), plus any window with a non-empty selector that covers the Camp.
 * A window with an empty selector applies only where it is named.
 */
export type ApplicableWindows = Readonly<{
	applicable: readonly CompiledWindow[];
	/** Named windows with no definition: treated as closed. */
	unknown: readonly string[];
}>;

export function applicableWindows(
	windows: ReadonlyMap<string, CompiledWindow>,
	input: EvaluationInput,
): ApplicableWindows {
	const applicable: CompiledWindow[] = [];
	const unknown: string[] = [];
	for (const name of [...new Set(input.windowNames)].sort()) {
		if (!windows.has(name)) unknown.push(name);
	}
	for (const window of [...windows.values()].sort((a, b) =>
		a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
	)) {
		const named = input.windowNames.includes(window.name);
		if (!named && isEmptySelector(window.selector)) continue;
		if (selectorCovers(window.selector, window.kind, input))
			applicable.push(window);
	}
	return { applicable, unknown };
}

type State = Readonly<{
	open: boolean;
	rollbackAllowed: boolean;
	activeFreezes: readonly string[];
	overrides: readonly string[];
}>;

function stateAt(
	applicable: readonly CompiledWindow[],
	unknown: readonly string[],
	overrides: readonly ActiveOverride[],
	input: EvaluationInput,
	atMs: number,
): State {
	const overridden = (name: string): boolean =>
		overrides.some(
			(override) =>
				override.window === name &&
				override.expiresAtMs > atMs &&
				override.campIds.includes(input.campId),
		);
	const activeFreezes: string[] = [...unknown];
	const used: string[] = [];
	let rollbackAllowed = true;
	let allows = 0;
	let allowOpen = false;
	for (const window of applicable) {
		let end: number | undefined;
		let undecidable = false;
		try {
			end = activeUntil(window, atMs);
		} catch (error) {
			if (!(error instanceof RecurrenceLimitError)) throw error;
			undecidable = true;
		}
		const lifted = overridden(window.name);
		if (lifted) used.push(window.name);
		if (window.kind === "FREEZE") {
			const active = undecidable || end !== undefined;
			if (active && !lifted) {
				activeFreezes.push(window.name);
				if (!window.rollbackAllowed) rollbackAllowed = false;
			}
		} else {
			allows += 1;
			if ((end !== undefined && !undecidable) || lifted) allowOpen = true;
		}
	}
	const open = activeFreezes.length === 0 && (allows === 0 || allowOpen);
	return { open, rollbackAllowed, activeFreezes, overrides: used };
}

function boundaries(
	applicable: readonly CompiledWindow[],
	atMs: number,
): readonly number[] {
	const horizon = atMs + WINDOW_LIMITS.nextOpenHorizonMs;
	const out = new Set<number>();
	for (const window of applicable) {
		let seen = 0;
		try {
			for (const start of occurrenceStarts(
				window.series,
				atMs - window.durationMs + 1,
			)) {
				if (start > horizon || seen >= WINDOW_LIMITS.maxBoundaryOccurrences)
					break;
				seen += 1;
				if (start > atMs) out.add(start);
				if (start + window.durationMs > atMs)
					out.add(start + window.durationMs);
			}
		} catch (error) {
			if (!(error instanceof RecurrenceLimitError)) throw error;
		}
	}
	return [...out].sort((a, b) => a - b);
}

/** Evaluate the windows that apply to one Camp at one instant for one intent. */
export function evaluateWindows(
	windows: ReadonlyMap<string, CompiledWindow>,
	overrides: readonly ActiveOverride[],
	input: EvaluationInput,
	/** Windows the journal holds but cannot decode: closed for every Camp. */
	unreadable: readonly string[] = [],
): WindowEvaluation {
	const applicableSet = applicableWindows(windows, input);
	const applicable = applicableSet.applicable;
	const unknown = [
		...new Set([...applicableSet.unknown, ...unreadable]),
	].sort();
	const now = stateAt(applicable, unknown, overrides, input, input.atMs);
	const open = input.intent === "rollback" ? now.rollbackAllowed : now.open;
	const evaluation: WindowEvaluation = {
		open,
		rollbackAllowed: now.rollbackAllowed,
		activeFreezes: now.activeFreezes,
		overrides: now.overrides,
	};
	if (open || unknown.length > 0) return evaluation;
	for (const candidate of boundaries(applicable, input.atMs)) {
		const later = stateAt(applicable, unknown, overrides, input, candidate);
		if (input.intent === "rollback" ? later.rollbackAllowed : later.open)
			return { ...evaluation, nextOpenAtMs: candidate };
	}
	return evaluation;
}
