// Journal → CDEvents projection (WP16, plan 0024 D17).
//
// A pure fold over @hobo/cd journal events. Each fact that has a CDEvents
// meaning becomes one or more CDEvents of the pinned spec; HoBo-specific
// facts become `dev.cdeventsx.hobo-*` custom events. Bodies are parsed with
// the generated protobuf schemas (parse, don't validate); a body that does
// not parse is counted and skipped, never trusted. Deterministic: ids are
// hashes of the source event id, timestamps are recorded event times (I8).

import {
	type DescMessage,
	fromJson,
	type MessageShape,
	toJson,
} from "@bufbuild/protobuf";
import type { EventEnvelope, JsonObject, JsonValue } from "@hobo/core";
import {
	type ArtifactRef,
	ComplianceRecordSchema,
	FailoverRecordSchema,
	FanoutStatusRecordSchema,
	FreightApprovedRecordSchema,
	FreightQualifiedRecordSchema,
	FreightRecordSchema,
	FreightRetiredRecordSchema,
	FreightSubject,
	FreightYankedRecordSchema,
	PolicyBindingRecordSchema,
	PreviewEnvironmentRecordSchema,
	PromotionRecordSchema,
	ReconcileObservationRecordSchema,
	SetOrigin,
	SetRecordSchema,
	VerificationResultRecordSchema,
} from "../_generated/cd_pb.js";
import { CD_EVENTS } from "../events.js";
import {
	artifactPurl,
	assertCdEvent,
	CDEVENT_TYPES,
	CDEVENTS_SPEC,
	type CdEvent,
	cdEventId,
	freightPurl,
	hoboEventType,
} from "./cdevents.js";

export type CdEventsProjectorOptions = Readonly<{
	/** CDEvents `context.source` (URI-reference), e.g. `/hobo/cd/acme`. */
	source: string;
}>;

export interface CdEventsProjector {
	/** Fold one journal event; returns the CDEvents it produces, in order. */
	apply(event: EventEnvelope): readonly CdEvent[];
	/** Bodies that did not parse and were skipped. */
	readonly skipped: number;
}

type FreightView = Readonly<{
	bindle: string;
	alias: string;
	subject: FreightSubject;
	artifacts: readonly ArtifactRef[];
}>;

type SetView = Readonly<{
	campId: string;
	origin: SetOrigin;
	freightId: string;
}>;

// One HoBo fact without a CDEvents vocabulary entry → one custom event.
type CustomRule = Readonly<{
	schema: DescMessage;
	subject: string;
	predicate: string;
	subjectId: (record: JsonObject) => string;
}>;

const text = (record: JsonObject, key: string): string => {
	const value = record[key];
	return typeof value === "string" ? value : "";
};

const CUSTOM_RULES: Readonly<Record<string, CustomRule>> = {
	[CD_EVENTS.FreightYanked]: {
		schema: FreightYankedRecordSchema,
		subject: "freight",
		predicate: "yanked",
		subjectId: (r) => text(r, "freightId"),
	},
	[CD_EVENTS.FreightQualified]: {
		schema: FreightQualifiedRecordSchema,
		subject: "freight",
		predicate: "qualified",
		subjectId: (r) => text(r, "freightId"),
	},
	[CD_EVENTS.FreightApproved]: {
		schema: FreightApprovedRecordSchema,
		subject: "freight",
		predicate: "approved",
		subjectId: (r) => text(r, "freightId"),
	},
	[CD_EVENTS.FreightRetired]: {
		schema: FreightRetiredRecordSchema,
		subject: "freight",
		predicate: "retired",
		subjectId: (r) => text(r, "freightId"),
	},
	[CD_EVENTS.EnvPromoteRejected]: {
		schema: PromotionRecordSchema,
		subject: "promotion",
		predicate: "rejected",
		subjectId: (r) => text(r, "promotionId"),
	},
	[CD_EVENTS.EnvPromoteSuperseded]: {
		schema: PromotionRecordSchema,
		subject: "promotion",
		predicate: "superseded",
		subjectId: (r) => text(r, "promotionId"),
	},
	[CD_EVENTS.VerificationCompleted]: {
		schema: VerificationResultRecordSchema,
		subject: "verification",
		predicate: "completed",
		subjectId: (r) => text(r, "verificationId"),
	},
	[CD_EVENTS.ReconcileBlocked]: {
		schema: ReconcileObservationRecordSchema,
		subject: "camp",
		predicate: "blocked",
		subjectId: (r) => text(r, "campId"),
	},
	[CD_EVENTS.FanoutHalted]: {
		schema: FanoutStatusRecordSchema,
		subject: "fanout",
		predicate: "halted",
		subjectId: (r) => text(r, "fanoutId"),
	},
	[CD_EVENTS.FanoutCompleted]: {
		schema: FanoutStatusRecordSchema,
		subject: "fanout",
		predicate: "completed",
		subjectId: (r) => text(r, "fanoutId"),
	},
	[CD_EVENTS.FanoutRolledBack]: {
		schema: FanoutStatusRecordSchema,
		subject: "fanout",
		predicate: "rolledback",
		subjectId: (r) => text(r, "fanoutId"),
	},
	[CD_EVENTS.FailoverCompleted]: {
		schema: FailoverRecordSchema,
		subject: "failover",
		predicate: "completed",
		subjectId: (r) => text(r, "failoverId"),
	},
	[CD_EVENTS.FailoverRefused]: {
		schema: FailoverRecordSchema,
		subject: "failover",
		predicate: "refused",
		subjectId: (r) => text(r, "failoverId"),
	},
	[CD_EVENTS.ComplianceChanged]: {
		schema: ComplianceRecordSchema,
		subject: "compliance",
		predicate: "changed",
		subjectId: (r) => text(r, "campId"),
	},
	[CD_EVENTS.PolicyBindingChanged]: {
		schema: PolicyBindingRecordSchema,
		subject: "policy",
		predicate: "bound",
		subjectId: (r) => text(r, "campId"),
	},
};

// Origins whose convergence removes every service from the Camp.
const REMOVAL_ORIGINS = new Set<SetOrigin>([
	SetOrigin.TEARDOWN,
	SetOrigin.DEPARTURE,
]);
// Origins that change the environment's definition, not a service version.
const MODIFY_ORIGINS = new Set<SetOrigin>([
	SetOrigin.CONFIG,
	SetOrigin.TOPOLOGY,
]);

function parse<D extends DescMessage>(
	schema: D,
	event: EventEnvelope,
): MessageShape<D> | undefined {
	try {
		// SAFETY: event-store bodies are JSON; fromJson parses or throws.
		return fromJson(schema, event.data as JsonValue, {
			ignoreUnknownFields: true,
		});
	} catch {
		return undefined;
	}
}

function campIdOf(data: unknown): string | undefined {
	if (data === null || typeof data !== "object") return undefined;
	// SAFETY: lenient read of a single id field from a JSON body.
	const record = data as Readonly<Record<string, unknown>>;
	const value = record.campId ?? record.camp_id;
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function createCdEventsProjector(
	options: CdEventsProjectorOptions,
): CdEventsProjector {
	const { source } = options;
	const freights = new Map<string, FreightView>();
	const sets = new Map<string, SetView>();
	const environments = new Set<string>();
	// campId → bindle → deployed freight ids, oldest first.
	const deployed = new Map<string, Map<string, string[]>>();
	let skipped = 0;

	const context = (
		event: EventEnvelope,
		type: string,
		discriminator: string,
	) => ({
		specversion: CDEVENTS_SPEC.specversion,
		id: cdEventId(event.id, type, discriminator),
		source,
		type,
		timestamp: event.ts,
		...(event.correlationId !== undefined && event.correlationId !== ""
			? { chainId: event.correlationId }
			: undefined),
	});

	const emit = (cdevent: CdEvent): CdEvent => assertCdEvent(cdevent);

	const primaryArtifact = (
		freightId: string,
		view: FreightView | undefined,
	): string => {
		const first = view?.artifacts[0];
		if (first !== undefined) {
			return artifactPurl({
				name: first.name,
				digest: first.digest,
				ecosystem: first.ecosystem,
				coordinate: first.coordinate,
			});
		}
		return freightPurl(view?.bindle ?? "", freightId);
	};

	const history = (campId: string, bindle: string): string[] => {
		let byBindle = deployed.get(campId);
		if (byBindle === undefined) {
			byBindle = new Map();
			deployed.set(campId, byBindle);
		}
		let list = byBindle.get(bindle);
		if (list === undefined) {
			list = [];
			byBindle.set(bindle, list);
		}
		return list;
	};

	const serviceEvent = (
		event: EventEnvelope,
		type: string,
		campId: string,
		bindle: string,
		freightId: string,
		customData: JsonObject,
	): CdEvent =>
		emit({
			context: context(event, type, campId),
			subject: {
				id: bindle,
				source,
				content: {
					environment: { id: campId, source },
					artifactId: primaryArtifact(freightId, freights.get(freightId)),
				},
			},
			customData: { freightId, ...customData },
			customDataContentType: "application/json",
		});

	const environmentEvent = (
		event: EventEnvelope,
		type: string,
		campId: string,
		name: string,
	): CdEvent =>
		emit({
			context: context(event, type, campId),
			subject: { id: campId, source, content: { name } },
		});

	const onFreightRecorded = (event: EventEnvelope): CdEvent[] => {
		const record = parse(FreightRecordSchema, event);
		const manifest = record?.manifest;
		if (
			record === undefined ||
			manifest === undefined ||
			record.freightId === ""
		) {
			skipped += 1;
			return [];
		}
		const view: FreightView = {
			bindle: manifest.bindle,
			alias: record.alias,
			subject: manifest.subject,
			artifacts: manifest.artifacts,
		};
		freights.set(record.freightId, view);
		if (manifest.subject === FreightSubject.RAIL) {
			const type = hoboEventType("rail", "recorded");
			return [
				emit({
					context: context(event, type, record.freightId),
					subject: {
						id: manifest.bindle,
						source,
						content: {
							freightId: record.freightId,
							railDigest: manifest.declarationHash,
						},
					},
				}),
			];
		}
		return manifest.artifacts.map((artifact) =>
			emit({
				context: context(
					event,
					CDEVENT_TYPES.artifactPublished,
					artifact.digest,
				),
				subject: {
					id: artifactPurl({
						name: artifact.name,
						digest: artifact.digest,
						ecosystem: artifact.ecosystem,
						coordinate: artifact.coordinate,
					}),
					source,
					content: {},
				},
				customData: {
					freightId: record.freightId,
					alias: record.alias,
					bindle: manifest.bindle,
					digest: artifact.digest,
				},
				customDataContentType: "application/json",
			}),
		);
	};

	const onSetCreated = (event: EventEnvelope): CdEvent[] => {
		const record = parse(SetRecordSchema, event);
		if (record === undefined || record.setId === "" || record.campId === "") {
			skipped += 1;
			return [];
		}
		sets.set(record.setId, {
			campId: record.campId,
			origin: record.origin,
			freightId: record.freightId,
		});
		const name = record.environment || record.campId;
		if (!environments.has(record.campId)) {
			environments.add(record.campId);
			return [
				environmentEvent(
					event,
					CDEVENT_TYPES.environmentCreated,
					record.campId,
					name,
				),
			];
		}
		if (MODIFY_ORIGINS.has(record.origin)) {
			return [
				environmentEvent(
					event,
					CDEVENT_TYPES.environmentModified,
					record.campId,
					name,
				),
			];
		}
		return [];
	};

	const onPromoted = (event: EventEnvelope): CdEvent[] => {
		const record = parse(PromotionRecordSchema, event);
		if (record === undefined || record.freightId === "") {
			skipped += 1;
			return [];
		}
		const view = freights.get(record.freightId);
		const extra: JsonObject = {
			promotionId: record.promotionId,
			pipeline: record.pipeline,
			node: record.node,
		};
		if (
			record.subject === FreightSubject.RAIL ||
			view?.subject === FreightSubject.RAIL
		) {
			const type = hoboEventType("rail", "promoted");
			return record.targetCampIds.map((campId) =>
				emit({
					context: context(event, type, campId),
					subject: {
						id: view?.bindle ?? record.freightId,
						source,
						content: { campId, freightId: record.freightId, ...extra },
					},
				}),
			);
		}
		const bindle = view?.bindle ?? record.freightId;
		return record.targetCampIds.map((campId) => {
			const list = history(campId, bindle);
			const type =
				list.length === 0
					? CDEVENT_TYPES.serviceDeployed
					: CDEVENT_TYPES.serviceUpgraded;
			if (list[list.length - 1] !== record.freightId)
				list.push(record.freightId);
			return serviceEvent(event, type, campId, bindle, record.freightId, extra);
		});
	};

	const onRolledBack = (event: EventEnvelope): CdEvent[] => {
		const record = parse(PromotionRecordSchema, event);
		if (record === undefined || record.freightId === "") {
			skipped += 1;
			return [];
		}
		const view = freights.get(record.freightId);
		const bindle = view?.bindle ?? record.freightId;
		const out: CdEvent[] = [];
		for (const campId of record.targetCampIds) {
			const list = history(campId, bindle);
			const at = list.lastIndexOf(record.freightId);
			if (at >= 0) list.splice(at, 1);
			const restored = list[list.length - 1];
			const extra: JsonObject = {
				promotionId: record.promotionId,
				rolledBackFreightId: record.freightId,
			};
			if (restored !== undefined) {
				out.push(
					serviceEvent(
						event,
						CDEVENT_TYPES.serviceRolledback,
						campId,
						bindle,
						restored,
						extra,
					),
				);
			} else {
				// Nothing earlier is known on this Camp: the service is gone.
				out.push(
					emit({
						context: context(event, CDEVENT_TYPES.serviceRemoved, campId),
						subject: {
							id: bindle,
							source,
							content: { environment: { id: campId, source } },
						},
						customData: extra,
						customDataContentType: "application/json",
					}),
				);
			}
		}
		return out;
	};

	const onConverged = (event: EventEnvelope): CdEvent[] => {
		const record = parse(ReconcileObservationRecordSchema, event);
		if (record === undefined) {
			skipped += 1;
			return [];
		}
		const set = sets.get(record.setId);
		if (set === undefined || !REMOVAL_ORIGINS.has(set.origin)) return [];
		const byBindle = deployed.get(set.campId);
		if (byBindle === undefined) return [];
		const out: CdEvent[] = [];
		for (const bindle of [...byBindle.keys()].sort()) {
			out.push(
				emit({
					context: context(
						event,
						CDEVENT_TYPES.serviceRemoved,
						`${set.campId}/${bindle}`,
					),
					subject: {
						id: bindle,
						source,
						content: { environment: { id: set.campId, source } },
					},
					customData: { setId: record.setId },
					customDataContentType: "application/json",
				}),
			);
		}
		deployed.delete(set.campId);
		return out;
	};

	const onEnvironmentCreated = (event: EventEnvelope): CdEvent[] => {
		const record = parse(PreviewEnvironmentRecordSchema, event);
		if (record === undefined || record.campId === "") {
			skipped += 1;
			return [];
		}
		if (environments.has(record.campId)) return [];
		environments.add(record.campId);
		return [
			environmentEvent(
				event,
				CDEVENT_TYPES.environmentCreated,
				record.campId,
				record.campId,
			),
		];
	};

	const onEnvironmentDeleted = (
		event: EventEnvelope,
		campId: string | undefined,
	): CdEvent[] => {
		if (campId === undefined) {
			skipped += 1;
			return [];
		}
		environments.delete(campId);
		deployed.delete(campId);
		return [
			emit({
				context: context(event, CDEVENT_TYPES.environmentDeleted, campId),
				subject: { id: campId, source, content: { name: campId } },
			}),
		];
	};

	const onCustom = (event: EventEnvelope, rule: CustomRule): CdEvent[] => {
		const record = parse(rule.schema, event);
		if (record === undefined) {
			skipped += 1;
			return [];
		}
		// SAFETY: toJson of a generated message is a JSON object.
		const content = toJson(rule.schema, record) as JsonObject;
		const subjectId = rule.subjectId(content) || event.streamId;
		const type = hoboEventType(rule.subject, rule.predicate);
		return [
			emit({
				context: context(event, type, subjectId),
				subject: { id: subjectId, source, content },
			}),
		];
	};

	return {
		get skipped() {
			return skipped;
		},
		apply(event) {
			switch (event.type) {
				case CD_EVENTS.FreightRecorded:
					return onFreightRecorded(event);
				case CD_EVENTS.SetCreated:
					return onSetCreated(event);
				case CD_EVENTS.EnvPromoted:
					return onPromoted(event);
				case CD_EVENTS.EnvPromoteRolledBack:
					return onRolledBack(event);
				case CD_EVENTS.Converged:
					return onConverged(event);
				case CD_EVENTS.EnvCloned:
					return onEnvironmentCreated(event);
				case CD_EVENTS.EnvExpired: {
					const record = parse(PreviewEnvironmentRecordSchema, event);
					return onEnvironmentDeleted(event, record?.campId || undefined);
				}
				case CD_EVENTS.CampDeparted:
					return onEnvironmentDeleted(event, campIdOf(event.data));
				default: {
					const rule = CUSTOM_RULES[event.type];
					return rule === undefined ? [] : onCustom(event, rule);
				}
			}
		},
	};
}

/** Project a whole journal (replay): same input, byte-identical output. */
export function projectCdEvents(
	events: Iterable<EventEnvelope>,
	options: CdEventsProjectorOptions,
): CdEvent[] {
	const projector = createCdEventsProjector(options);
	const out: CdEvent[] = [];
	for (const event of events) out.push(...projector.apply(event));
	return out;
}
