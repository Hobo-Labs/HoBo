/**
 * The single parse boundary for untrusted registry documents (parse, don't
 * validate). Raw JSON crosses this boundary exactly once and comes out as
 * the derived domain type {@link ParsedRegistry}: generated protobuf
 * records plus structural invariants mirrored from
 * `data-models/runner_balancing.cue` (ids resolve, every routed provider
 * has a budget envelope, caps are ordered). Invalid *structure* throws;
 * invalid *cost facts* deliberately do not — they degrade to declared
 * min-cost ranking downstream in the ledger projection, because declared
 * facts are untrusted ranking input, never billing input.
 */

import { create, fromJson } from "@bufbuild/protobuf";

import {
	type BudgetEnvelope,
	BudgetEnvelopeSchema,
	type RunnerProviderProfile,
	RunnerProviderProfileSchema,
	type RunnerTrack,
	RunnerTrackSchema,
	type UsageSnapshot,
	UsageSnapshotSchema,
} from "./_generated/runner_balancing_pb.js";

export class RegistryParseError extends Error {
	readonly problems: readonly string[];

	constructor(problems: readonly string[]) {
		super(`registry document rejected: ${problems.join("; ")}`);
		this.name = "RegistryParseError";
		this.problems = problems;
	}
}

// domain-view: parse-don't-validate derived type — the registry document's
// parsed form with resolved lookups; its wire form is the generated records.
export interface ParsedRegistry {
	readonly providers: readonly RunnerProviderProfile[];
	readonly providerById: ReadonlyMap<string, RunnerProviderProfile>;
	readonly tracks: readonly RunnerTrack[];
	readonly envelopes: ReadonlyMap<string, BudgetEnvelope>;
}

const PROVIDER_ID = /^[a-z][a-z0-9_]*$/;
const VARIABLE_NAME = /^[A-Z][A-Z0-9_]*$/;

/** JSON that has not yet crossed a protobuf/CUE parse boundary. */
export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| JsonObject;

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return (
		value !== undefined &&
		value !== null &&
		!Array.isArray(value) &&
		Object.prototype.toString.call(value) === "[object Object]"
	);
}

export function isJsonString<T>(value: T): value is T & string {
	return Object.prototype.toString.call(value) === "[object String]";
}

export function isJsonNumber<T>(value: T): value is T & number {
	return (
		Object.prototype.toString.call(value) === "[object Number]" &&
		Number.isFinite(Number(value))
	);
}

export function isJsonBoolean<T>(value: T): value is T & boolean {
	return value === true || value === false;
}

export function isJsonValue(value: JsonValue): boolean {
	if (
		value === null ||
		isJsonString(value) ||
		isJsonNumber(value) ||
		isJsonBoolean(value)
	) {
		return true;
	}
	if (Array.isArray(value)) return value.every(isJsonValue);
	return isJsonObject(value) && Object.values(value).every(isJsonValue);
}

export function parseJsonValue(value: JsonValue): JsonValue {
	if (!isJsonValue(value)) throw new TypeError("expected a JSON value");
	return value;
}

export interface FixtureFailure {
	providerId: string;
	reason: string;
}

export interface FixtureDocument {
	registryDocument?: JsonValue;
	current?: { readonly [name: string]: string };
	usage?: JsonValue;
	failures?: FixtureFailure[];
	seq?: string;
}

function parseFixtureCurrent(value: JsonValue) {
	if (!isJsonObject(value)) return {};
	const current: Record<string, string> = {};
	for (const [name, entry] of Object.entries(value)) {
		if (isJsonString(entry)) current[name] = entry;
	}
	return current;
}

function parseFixtureFailures(value: JsonValue): FixtureFailure[] {
	if (!Array.isArray(value)) return [];
	const failures: FixtureFailure[] = [];
	for (const entry of value) {
		if (!isJsonObject(entry) || !isJsonString(entry.providerId)) continue;
		failures.push({
			providerId: entry.providerId,
			reason: isJsonString(entry.reason)
				? entry.reason
				: "fixture-declared failure",
		});
	}
	return failures;
}

export function parseFixtureDocument(value: JsonValue): FixtureDocument {
	if (!isJsonObject(value)) throw new TypeError("fixture document must be an object");
	const fixture: FixtureDocument = {};
	if (value.registryDocument !== undefined) {
		fixture.registryDocument = value.registryDocument;
	}
	if (value.current !== undefined) {
		fixture.current = parseFixtureCurrent(value.current);
	}
	if (value.usage !== undefined) fixture.usage = value.usage;
	if (value.failures !== undefined) {
		fixture.failures = parseFixtureFailures(value.failures);
	}
	if (isJsonString(value.seq)) fixture.seq = value.seq;
	return fixture;
}

function asArray(value: JsonValue | undefined, field: string, problems: string[]): JsonValue[] {
	if (Array.isArray(value)) return value;
	problems.push(`${field} must be an array`);
	return [];
}

/** Parse one untrusted registry document into the derived domain type. */
export function parseRegistryDocument(raw: JsonValue): ParsedRegistry {
	const problems: string[] = [];
	if (!isJsonObject(raw)) {
		throw new RegistryParseError(["registry document must be an object"]);
	}
	const document = raw;

	const providers: RunnerProviderProfile[] = [];
	for (const [index, entry] of asArray(
		document.providers,
		"providers",
		problems,
	).entries()) {
		try {
			// SAFETY: assertion to `y as never)); ` is required at this boundary.
			providers.push(fromJson(RunnerProviderProfileSchema, entry as never));
		} catch (error) {
			problems.push(`providers[${index}]: ${String(error)}`);
		}
	}

	const tracks: RunnerTrack[] = [];
	for (const [index, entry] of asArray(
		document.tracks,
		"tracks",
		problems,
	).entries()) {
		try {
			// SAFETY: assertion to `y as never)); ` is required at this boundary.
			tracks.push(fromJson(RunnerTrackSchema, entry as never));
		} catch (error) {
			problems.push(`tracks[${index}]: ${String(error)}`);
		}
	}

	const envelopes = new Map<string, BudgetEnvelope>();
	for (const [index, entry] of asArray(
		document.envelopes,
		"envelopes",
		problems,
	).entries()) {
		try {
			// SAFETY: assertion to `y as never); ` is required at this boundary.
			const envelope = fromJson(BudgetEnvelopeSchema, entry as never);
			envelopes.set(envelope.providerId, envelope);
		} catch (error) {
			problems.push(`envelopes[${index}]: ${String(error)}`);
		}
	}

	const providerById = new Map<string, RunnerProviderProfile>();
	for (const provider of providers) {
		if (!PROVIDER_ID.test(provider.id)) {
			problems.push(`provider id ${JSON.stringify(provider.id)} is not snake_case`);
			continue;
		}
		if (providerById.has(provider.id)) {
			problems.push(`duplicate provider id ${provider.id}`);
			continue;
		}
		if (provider.runsOnLabels.length === 0) {
			problems.push(`provider ${provider.id} declares no runs-on labels`);
		}
		providerById.set(provider.id, provider);
	}

	if (tracks.length === 0) {
		problems.push("registry declares no tracks");
	}
	for (const track of tracks) {
		if (!VARIABLE_NAME.test(track.variable)) {
			problems.push(
				`track ${track.resource || "(unnamed)"} variable ${JSON.stringify(track.variable)} is not an Actions variable name`,
			);
		}
		if (track.rungs.length === 0) {
			problems.push(`track ${track.resource} declares no rungs`);
		}
		for (const rung of track.rungs) {
			if (!providerById.has(rung.providerId)) {
				problems.push(
					`track ${track.resource} rung ${rung.value} references unknown provider ${rung.providerId}`,
				);
				continue;
			}
			if (!envelopes.has(rung.providerId)) {
				problems.push(
					`provider ${rung.providerId} is routed by track ${track.resource} but has no budget envelope`,
				);
			}
		}
	}

	for (const envelope of envelopes.values()) {
		if (envelope.hardCapUsd < envelope.softCapUsd) {
			problems.push(
				`envelope ${envelope.providerId} hard cap ${envelope.hardCapUsd} sits below soft cap ${envelope.softCapUsd}`,
			);
		}
	}

	if (problems.length > 0) {
		throw new RegistryParseError(problems);
	}
	return { providers, providerById, tracks, envelopes };
}

/**
 * Parse one untrusted usage document (operator override or adapter payload)
 * into generated UsageSnapshot records; unusable entries are dropped, not
 * guessed at.
 */
export function parseUsageSnapshots(raw: JsonValue): UsageSnapshot[] {
	if (!Array.isArray(raw)) return [];
	const snapshots: UsageSnapshot[] = [];
	for (const entry of raw) {
		try {
			// SAFETY: assertion to `y as never); ` is required at this boundary.
			const snapshot = fromJson(UsageSnapshotSchema, entry as never);
			if (
				snapshot.providerId !== "" &&
				Number.isFinite(snapshot.spendUsd) &&
				snapshot.spendUsd >= 0 &&
				Number.isFinite(snapshot.unitsUsed) &&
				snapshot.unitsUsed >= 0
			) {
				snapshots.push(snapshot);
			}
		} catch {
			// Unusable rows are evidence of a bad source, not a reason to guess.
		}
	}
	return snapshots;
}

/** Build an unknown-usage snapshot (honest degradation for silent sources). */
export function unknownUsage(providerId: string, source: string): UsageSnapshot {
	return create(UsageSnapshotSchema, {
		providerId,
		spendUsd: 0,
		unitsUsed: 0,
		known: false,
		source,
	});
}
