// createFreightSources (WP2, D3, I15): pull discovery as an event-sourced
// service.
//
// - Command `define` appends `source.Defined` to `cd-source-<name>` (CAS on
//   the stream head, idempotency key = definition digest).
// - Command `poll` folds the stream (definition, per-subscription cursor,
//   discovery history), runs each subscription's driver forward from its
//   cursor, gates provenance through ProvenanceVerifier, assembles Freight per
//   the source's assembly rule, records it through the FreightLedger (which is
//   content-addressed, so a retried poll records nothing twice), and appends
//   one `source.ArtifactDiscovered` per new artifact carrying the new cursor
//   and the outcome. Freight is recorded before the cursor moves, so a crash
//   in between repeats the (idempotent) record instead of losing Freight.
// - `nudge` authenticates a webhook and schedules polls. It has no path to the
//   ledger: a payload never becomes Freight.
// - `tick` polls due sources (interval, or scheduled by `schedule`/`nudge`)
//   with deterministic jittered backoff.
// - `list` reads a projection over `source.Defined` that catches up from its
//   last journal position.
import { create, fromJson, type JsonValue as ProtoJson, toJson } from "@bufbuild/protobuf";
import type { EventEnvelope, EventPosition, JsonObject, JsonValue } from "@hobo/core";
import {
	type DiscoveredArtifactRecord,
	DiscoveredArtifactRecordSchema,
	FreightOrigin,
	type FreightRecord,
	type FreightSourceRecord,
	FreightSourceRecordSchema,
	type ReasonRecord,
	ReasonRecordSchema,
	SelectionStrategy,
	SubscriptionKind,
	type SubscriptionRecord,
} from "../_generated/cd_pb.js";
import { CD_EVENTS, CD_STREAMS } from "../events.js";
import type {
	CdAuthorizer,
	CdBase,
	CdContext,
	CredentialResolver,
	FeedRequest,
	FeedResponse,
	FreightLedger,
	FreightSources,
	OtelMetricPoint,
	Outcome,
	ProvenanceVerifier,
	SubscriptionDriver,
	TelemetrySink,
} from "../ports.js";
import { assemble } from "./assembly.js";
import { backoffDelayMs } from "./backoff.js";
import { canonical, isDigest, isList, isRecord, isText, sha256Hex, text } from "./json.js";
import { parseFreightSource } from "./parse.js";
import { reason, refuse, retryAfterMs, SOURCE_REASON } from "./reasons.js";
import { compareVersions } from "./selection.js";
import { isAttestingDriver } from "./types.js";
import { subscriptionKeys } from "./webhooks/keys.js";
import { receiveWebhook } from "./webhooks/receivers.js";

// public-contract: metric names the source service emits through TelemetrySink.
export const SOURCE_METRIC = Object.freeze({
	polls: "hobo.cd.source.polls",
	pollDuration: "hobo.cd.source.poll.duration",
	discovered: "hobo.cd.source.discovered",
	skipped: "hobo.cd.source.skipped",
	freightRecorded: "hobo.cd.source.freight.recorded",
	freightRefused: "hobo.cd.source.freight.refused",
	nudges: "hobo.cd.source.nudges",
	backoff: "hobo.cd.source.backoff",
	defined: "hobo.cd.source.defined",
} as const);

// public-contract: outcome recorded in `source.ArtifactDiscovered` meta.
export type DiscoveryOutcome = "recorded" | "skipped" | "deferred" | "refused";

export type FreightSourcesDeps = CdBase & {
	readonly ledger: FreightLedger;
	readonly drivers: readonly SubscriptionDriver[];
	readonly provenance: ProvenanceVerifier;
	readonly authorizer: CdAuthorizer;
	readonly webhookSecrets: CredentialResolver;
	/** Optional: metrics (WP19 composes the OTLP sink). */
	readonly telemetry?: TelemetrySink;
};

type SourceState = Readonly<{
	seq: number;
	definition?: FreightSourceRecord;
	cursors: ReadonlyMap<string, string>;
	/** Discovered artifacts eligible for assembly (recorded/deferred), oldest first. */
	history: readonly DiscoveredArtifactRecord[];
	seen: ReadonlySet<string>;
}>;

type PollMemory = { lastPollAtMs?: number; failures: number; nextAttemptAtMs: number };

const NEVER = new AbortController().signal;

function discoveryKey(subscription: string, digest: string, version: string): string {
	return `${subscription}\u0000${digest}\u0000${version}`;
}

function reasonJson(item: ReasonRecord): JsonObject {
	return { code: item.code, message: item.message, remediation: item.remediation, subject: item.subject };
}

function reasonFrom(value: JsonValue): ReasonRecord {
	return create(ReasonRecordSchema, {
		code: text(value, "code") ?? "",
		message: text(value, "message") ?? "",
		remediation: text(value, "remediation") ?? "",
		subject: text(value, "subject") ?? "",
	});
}

function definitionKey(source: FreightSourceRecord): string {
	const json = toJson(FreightSourceRecordSchema, source);
	const { definedBy: _definedBy, ...rest } = isRecord(json) ? json : {};
	return `defined:${sha256Hex(canonical(rest))}`;
}

function decodeSource(event: EventEnvelope): FreightSourceRecord | undefined {
	try {
		// SAFETY: event data is the protobuf JSON this module appended.
		return fromJson(FreightSourceRecordSchema, event.data as ProtoJson);
	} catch {
		return undefined;
	}
}

function decodeDiscovered(event: EventEnvelope): DiscoveredArtifactRecord | undefined {
	try {
		// SAFETY: event data is the protobuf JSON this module appended.
		return fromJson(DiscoveredArtifactRecordSchema, event.data as ProtoJson, { ignoreUnknownFields: true });
	} catch {
		return undefined;
	}
}

export function createFreightSources(d: FreightSourcesDeps): FreightSources {
	const drivers = new Map<SubscriptionKind, SubscriptionDriver>();
	for (const driver of d.drivers) if (!drivers.has(driver.kind)) drivers.set(driver.kind, driver);
	const memory = new Map<string, PollMemory>();
	const scheduled = new Set<string>();
	const projection = new Map<string, FreightSourceRecord>();
	let projectedTo: EventPosition | undefined;

	async function emit(points: readonly Omit<OtelMetricPoint, "atMs" | "unit">[]): Promise<void> {
		if (!d.telemetry || points.length === 0) return;
		try {
			await d.telemetry.metrics(points.map((point) => ({ ...point, unit: point.kind === "histogram" ? "ms" : "1", atMs: d.now() })));
		} catch {
			// Telemetry never fails a discovery.
		}
	}

	async function load(name: string): Promise<SourceState> {
		let seq = 0;
		let definition: FreightSourceRecord | undefined;
		const cursors = new Map<string, string>();
		const history: DiscoveredArtifactRecord[] = [];
		const seen = new Set<string>();
		for await (const event of d.store.read(CD_STREAMS.source(name))) {
			seq = event.seq;
			if (event.type === CD_EVENTS.SourceDefined) {
				definition = decodeSource(event) ?? definition;
			} else if (event.type === CD_EVENTS.SourceArtifactDiscovered) {
				const record = decodeDiscovered(event);
				if (!record) continue;
				const cursor = event.meta?.cursor;
				if (isText(cursor)) cursors.set(record.subscription, cursor);
				seen.add(discoveryKey(record.subscription, record.artifact?.digest ?? "", record.version));
				const outcome = event.meta?.outcome;
				if (outcome === "recorded" || outcome === "deferred") history.push(record);
			}
		}
		return definition ? { seq, definition, cursors, history, seen } : { seq, cursors, history, seen };
	}

	async function refreshProjection(): Promise<void> {
		const options = projectedTo === undefined
			? { filter: { type: CD_EVENTS.SourceDefined }, tenant: d.tenant }
			: { filter: { type: CD_EVENTS.SourceDefined }, tenant: d.tenant, after: projectedTo };
		for await (const entry of d.store.readAll(options)) {
			projectedTo = entry.position;
			const record = decodeSource(entry.event);
			if (record) projection.set(record.name, record);
		}
	}

	async function authorize(action: "source.define" | "freight.record", subject: JsonObject, ctx: CdContext): Promise<Outcome<string>> {
		const decision = await d.authorizer.authorize(action, subject, ctx);
		if (!decision.ok) {
			return {
				ok: false,
				reasons: [
					reason(SOURCE_REASON.unauthorized, `${action} was not authorized`, "ask a delivery owner to grant the action in the policy pack", String(subject.source ?? "")),
					...decision.reasons,
				],
			};
		}
		return { ok: true, value: decision.value.decisionId };
	}

	async function define(input: FreightSourceRecord, ctx: CdContext): Promise<Outcome<FreightSourceRecord>> {
		const parsed = parseFreightSource(input, ctx.principal.id);
		if (!parsed.ok) return parsed;
		const source = parsed.value;
		for (const [index, subscription] of source.subscriptions.entries()) {
			const driver = drivers.get(subscription.kind);
			if (!driver) {
				return refuse(
					SOURCE_REASON.driverUnavailable,
					`no driver for ${SubscriptionKind[subscription.kind]}`,
					"compose createFreightSources with createSubscriptionDrivers (or a driver for this kind)",
					`subscriptions[${index}].kind`,
				);
			}
			if (subscription.requireProvenance && !isAttestingDriver(driver)) {
				return refuse(
					SOURCE_REASON.provenanceUnsupported,
					`the ${SubscriptionKind[subscription.kind]} driver cannot fetch attestations`,
					"use a driver that implements attestations, or drop requireProvenance",
					`subscriptions[${index}].requireProvenance`,
				);
			}
		}
		const decision = await authorize(
			"source.define",
			{ source: source.name, bindle: source.bindle, kinds: source.subscriptions.map((item) => SubscriptionKind[item.kind] ?? "") },
			ctx,
		);
		if (!decision.ok) return decision;
		const state = await load(source.name);
		if (state.definition && definitionKey(state.definition) === definitionKey(source)) {
			return { ok: true, value: state.definition };
		}
		try {
			await d.store.append(
				CD_STREAMS.source(source.name),
				[
					{
						type: CD_EVENTS.SourceDefined,
						// SAFETY: protobuf JSON is a JSON value.
						data: toJson(FreightSourceRecordSchema, source) as JsonValue,
						meta: { idempotencyKey: definitionKey(source), decisionId: decision.value },
					},
				],
				{ expectedSeq: state.seq, actor: ctx.principal, tenant: d.tenant },
			);
		} catch (error) {
			return refuse(
				SOURCE_REASON.unreachable,
				`source ${source.name} could not be recorded: ${error instanceof Error ? error.message : "store failure"}`,
				"retry; a concurrent definition wins and is returned on retry",
				source.name,
			);
		}
		projection.set(source.name, source);
		await emit([{ name: SOURCE_METRIC.defined, kind: "counter", value: 1, attributes: { source: source.name } }]);
		return { ok: true, value: source };
	}

	async function list(): Promise<readonly FreightSourceRecord[]> {
		await refreshProjection();
		return [...projection.values()].sort((left, right) => left.name.localeCompare(right.name));
	}

	type Gate = Readonly<{ record: DiscoveredArtifactRecord; skip?: readonly ReasonRecord[] }>;

	async function gateProvenance(
		subscription: SubscriptionRecord,
		driver: SubscriptionDriver,
		record: DiscoveredArtifactRecord,
		ctx: CdContext,
	): Promise<Outcome<Gate>> {
		if (!subscription.requireProvenance) return { ok: true, value: { record } };
		const artifact = record.artifact;
		if (!artifact || !isAttestingDriver(driver)) {
			return { ok: true, value: { record, skip: refuse(SOURCE_REASON.provenanceMissing, "no attestation source for this artifact", "publish attestations as OCI referrers", record.version).reasons } };
		}
		const materials = await driver.attestations({ subscription, artifact: record, signal: ctx.signal ?? NEVER }, ctx);
		if (!materials.ok) return materials;
		if (materials.value.length === 0) {
			return {
				ok: true,
				value: {
					record,
					skip: refuse(
						SOURCE_REASON.provenanceMissing,
						`${artifact.coordinate} has no attestation; requireProvenance skips unsigned artifacts`,
						"sign the artifact (Sigstore bundle or in-toto attestation) and push it as an OCI referrer; the next version is discovered once signed",
						record.version,
					).reasons,
				},
			};
		}
		const rejected: ReasonRecord[] = [];
		for (const material of materials.value) {
			const base = {
				statement: material.statement,
				subjects: [artifact],
				trustedBuilderIds: subscription.trustedBuilderIds,
				trustedSignerIdentities: subscription.trustedSignerIdentities,
			};
			const verified = await d.provenance.verify(material.bundle ? { ...base, bundle: material.bundle } : base, ctx);
			if (verified.ok) {
				const withProvenance = create(DiscoveredArtifactRecordSchema, { ...record, provenance: [...verified.value] });
				return { ok: true, value: { record: withProvenance } };
			}
			rejected.push(...verified.reasons);
		}
		return {
			ok: true,
			value: {
				record,
				skip: [
					reason(
						SOURCE_REASON.provenanceRejected,
						`${artifact.coordinate} has attestations, but none verified for the pinned builders/signers`,
						"check trustedBuilderIds/trustedSignerIdentities against the attestation, or re-sign",
						record.version,
					),
					...rejected,
				],
			},
		};
	}

	function olderThanHistory(subscription: SubscriptionRecord, record: DiscoveredArtifactRecord, history: readonly DiscoveredArtifactRecord[]): boolean {
		if (subscription.selection !== SelectionStrategy.SEMVER && subscription.selection !== SelectionStrategy.LEXICAL) return false;
		return history.some(
			(item) => item.subscription === subscription.name && compareVersions(subscription.selection, record.version, item.version) <= 0,
		);
	}

	async function poll(name: string, ctx: CdContext): Promise<Outcome<readonly FreightRecord[]>> {
		const started = d.now();
		const result = await pollOnce(name, ctx);
		await emit([
			{ name: SOURCE_METRIC.polls, kind: "counter", value: 1, attributes: { source: name, outcome: result.ok ? "ok" : (result.reasons[0]?.code ?? "refused") } },
			{ name: SOURCE_METRIC.pollDuration, kind: "histogram", value: Math.max(0, d.now() - started), attributes: { source: name } },
		]);
		return result;
	}

	async function pollOnce(name: string, ctx: CdContext): Promise<Outcome<readonly FreightRecord[]>> {
		const state = await load(name);
		const source = state.definition;
		if (!source) return refuse(SOURCE_REASON.unknown, `no Freight source named ${name}`, "define the source first", name);
		const decision = await authorize("freight.record", { source: name, bindle: source.bindle }, ctx);
		if (!decision.ok) return decision;
		const events: { record: DiscoveredArtifactRecord; outcome: DiscoveryOutcome; reasons: ReasonRecord[]; freightIds: string[] }[] = [];
		const cursors = new Map<string, string>();
		const metrics: Omit<OtelMetricPoint, "atMs" | "unit">[] = [];
		for (const subscription of source.subscriptions) {
			const driver = drivers.get(subscription.kind);
			if (!driver) return refuse(SOURCE_REASON.driverUnavailable, `no driver for ${SubscriptionKind[subscription.kind]}`, "compose a driver for this kind", subscription.name);
			const previous = state.cursors.get(subscription.name);
			const discovery = await driver.discover(
				previous === undefined
					? { source: name, subscription, signal: ctx.signal ?? NEVER }
					: { source: name, subscription, cursor: previous, signal: ctx.signal ?? NEVER },
				ctx,
			);
			if (!discovery.ok) return discovery;
			cursors.set(subscription.name, discovery.value.cursor);
			for (const found of discovery.value.artifacts) {
				const record = create(DiscoveredArtifactRecordSchema, { ...found, source: name, subscription: subscription.name });
				const digest = record.artifact?.digest ?? "";
				const key = discoveryKey(subscription.name, digest, record.version);
				if (state.seen.has(key) || events.some((item) => discoveryKey(item.record.subscription, item.record.artifact?.digest ?? "", item.record.version) === key)) continue;
				metrics.push({ name: SOURCE_METRIC.discovered, kind: "counter", value: 1, attributes: { source: name, subscription: subscription.name } });
				if (!isDigest(digest)) {
					events.push({ record, outcome: "skipped", reasons: [...refuse(SOURCE_REASON.upstreamInvalid, "driver returned an artifact without a sha256 digest", "fix the driver", record.version).reasons], freightIds: [] });
					continue;
				}
				if (olderThanHistory(subscription, record, [...state.history, ...events.filter((item) => item.outcome !== "skipped").map((item) => item.record)])) {
					events.push({ record, outcome: "skipped", reasons: [...refuse(SOURCE_REASON.olderThanHighWater, `${record.version} is not newer than a version already discovered`, "discovery is forward-only; publish a newer version", record.version).reasons], freightIds: [] });
					continue;
				}
				const gated = await gateProvenance(subscription, driver, record, ctx);
				if (!gated.ok) return gated;
				events.push(
					gated.value.skip
						? { record: gated.value.record, outcome: "skipped", reasons: [...gated.value.skip], freightIds: [] }
						: { record: gated.value.record, outcome: "deferred", reasons: [], freightIds: [] },
				);
			}
		}
		const eligible = events.filter((item) => item.outcome === "deferred");
		const assembled = assemble({ source, history: state.history, fresh: eligible.map((item) => item.record) });
		const recorded: FreightRecord[] = [];
		const origin = source.subscriptions.some((item) => item.kind === SubscriptionKind.HOBO_CI) ? FreightOrigin.HOBO_CI : FreightOrigin.SOURCE_DISCOVERY;
		for (const freight of assembled.freight) {
			const outcome = await d.ledger.record({ manifest: freight.manifest, origin, sourceName: name }, ctx);
			for (const member of freight.members) {
				const event = eligible.find((item) => item.record === member);
				if (!event) continue;
				if (outcome.ok) {
					event.outcome = "recorded";
					event.freightIds.push(outcome.value.freightId);
				} else if (event.outcome !== "recorded") {
					event.outcome = "refused";
					event.reasons.push(
						reason(SOURCE_REASON.freightRefused, "the Freight ledger refused the assembled manifest", "see the ledger reasons; fix the artifact or source and publish a newer version", member.version),
						...outcome.reasons,
					);
				}
			}
			if (outcome.ok) {
				if (!recorded.some((item) => item.freightId === outcome.value.freightId)) recorded.push(outcome.value);
				metrics.push({ name: SOURCE_METRIC.freightRecorded, kind: "counter", value: 1, attributes: { source: name } });
			} else {
				metrics.push({ name: SOURCE_METRIC.freightRefused, kind: "counter", value: 1, attributes: { source: name, code: outcome.reasons[0]?.code ?? "" } });
			}
		}
		for (const deferred of assembled.deferred) {
			const event = eligible.find((item) => item.record === deferred.artifact);
			if (event && event.outcome === "deferred" && event.reasons.length === 0) {
				event.reasons.push(
					reason(SOURCE_REASON.filtered, `waiting for ${deferred.waitingFor.join(", ")} to assemble`, "the Freight is assembled once every subscription has a matching artifact", deferred.artifact.version),
				);
			}
		}
		for (const event of events) {
			if (event.outcome === "skipped") {
				metrics.push({ name: SOURCE_METRIC.skipped, kind: "counter", value: 1, attributes: { source: name, code: event.reasons[0]?.code ?? "" } });
			}
		}
		if (events.length > 0) {
			try {
				await d.store.append(
					CD_STREAMS.source(name),
					events.map((event) => ({
						type: CD_EVENTS.SourceArtifactDiscovered,
						// SAFETY: protobuf JSON is a JSON value.
						data: toJson(DiscoveredArtifactRecordSchema, event.record) as JsonValue,
						meta: {
							idempotencyKey: `discovered:${sha256Hex(discoveryKey(event.record.subscription, event.record.artifact?.digest ?? "", event.record.version))}`,
							cursor: cursors.get(event.record.subscription) ?? "",
							outcome: event.outcome,
							reasons: event.reasons.map(reasonJson),
							freightIds: event.freightIds,
							decisionId: decision.value,
						},
					})),
					{ expectedSeq: state.seq, actor: ctx.principal, tenant: d.tenant },
				);
			} catch (error) {
				// A concurrent poll of the same source won the CAS. The Freight it and we
				// recorded is content-addressed, so nothing is lost; the next poll resumes
				// from the winner's cursor.
				return refuse(
					SOURCE_REASON.unreachable,
					`discoveries for ${name} could not be appended: ${error instanceof Error ? error.message : "store failure"}`,
					"retry; recorded Freight is idempotent and a concurrent poll's cursor is kept",
					name,
				);
			}
		}
		await emit(metrics);
		return { ok: true, value: recorded };
	}

	async function nudge(request: FeedRequest, ctx: CdContext): Promise<FeedResponse> {
		const received = await receiveWebhook(request, d.webhookSecrets);
		const respond = (status: number, body: JsonObject): FeedResponse => ({
			status,
			headers: { "content-type": "application/json" },
			body: new TextEncoder().encode(JSON.stringify(body)),
		});
		if (!received.ok) {
			await emit([{ name: SOURCE_METRIC.nudges, kind: "counter", value: 1, attributes: { outcome: String(received.status) } }]);
			return respond(received.status, { error: received.reasons[0]?.code ?? "refused", reasons: received.reasons.map(reasonJson) });
		}
		const keys = new Set(received.value.keys);
		const sources = await list();
		const names = sources
			.filter((source) => source.subscriptions.some((subscription) => subscriptionKeys(subscription).some((key) => keys.has(key))))
			.map((source) => source.name);
		await schedule(names, ctx);
		await emit([{ name: SOURCE_METRIC.nudges, kind: "counter", value: 1, attributes: { outcome: "202", receiver: received.value.receiver } }]);
		return respond(202, { receiver: received.value.receiver, scheduled: names });
	}

	async function schedule(names: readonly string[], _ctx: CdContext): Promise<void> {
		for (const name of names) scheduled.add(name);
	}

	async function tick(ctx: CdContext): Promise<void> {
		const now = ctx.now();
		for (const source of await list()) {
			const state = memory.get(source.name) ?? { failures: 0, nextAttemptAtMs: 0 };
			memory.set(source.name, state);
			const intervalDue =
				source.automatic && (state.lastPollAtMs === undefined || now >= state.lastPollAtMs + Number(source.pollIntervalMs));
			if (!intervalDue && !scheduled.has(source.name)) continue;
			if (now < state.nextAttemptAtMs) continue;
			const outcome = await poll(source.name, ctx);
			if (outcome.ok) {
				state.failures = 0;
				state.lastPollAtMs = now;
				state.nextAttemptAtMs = 0;
				scheduled.delete(source.name);
			} else {
				state.failures += 1;
				const delay = backoffDelayMs(source.name, state.failures, retryAfterMs(outcome.reasons) ?? 0);
				state.nextAttemptAtMs = now + delay;
				await emit([{ name: SOURCE_METRIC.backoff, kind: "gauge", value: delay, attributes: { source: source.name, code: outcome.reasons[0]?.code ?? "" } }]);
			}
		}
	}

	return { define, list, poll, nudge, schedule, tick };
}

/** Read the outcome and reasons recorded with one `source.ArtifactDiscovered`. */
/** The outcome, reasons and Freight ids recorded with one discovery. */
export type DiscoveryOutcomeView = Readonly<{ outcome: string; reasons: readonly ReasonRecord[]; freightIds: readonly string[] }>;

export function discoveryOutcome(event: EventEnvelope): DiscoveryOutcomeView {
	const reasons = event.meta?.reasons;
	const ids = event.meta?.freightIds;
	return {
		outcome: text(event.meta, "outcome") ?? "",
		reasons: isList(reasons) ? reasons.map(reasonFrom) : [],
		freightIds: isList(ids) ? ids.filter(isText) : [],
	};
}
