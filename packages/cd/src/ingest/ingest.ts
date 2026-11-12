// createFreightIngest (WP1, D3): the push paths into the Freight ledger.
//
// - `manifest`: a `hobo.freight-manifest/v1` from any build, authenticated by
//   a trusted-publisher OIDC token or the calling HoBo principal. Provenance
//   a pushed manifest *claims* is kept as unverified metadata.
// - `attestation`: an in-toto Statement v1 with an SLSA v1 predicate, parsed
//   by @hobo/registry. Its subjects become the artifacts; the ProvenanceVerifier
//   (Sigstore or HoBo-signed) must verify it and cover every subject.
// - `cdevent`: an artifact CDEvent schedules polls on matching sources and
//   creates Freight only from a carried, verifiable attestation (I15).
//
// Every path authorizes `freight.record` for the effective principal before
// the ledger records anything.
import { clone, create, type JsonObject } from "@bufbuild/protobuf";
import type { PrincipalRef } from "@hobo/core";
import { parseProvenanceStatement } from "@hobo/registry";
import {
	FreightManifestRecordSchema,
	FreightOrigin,
	type FreightRecord,
	FreightSubject,
	type ProvenanceRef,
	SourceRefSchema,
} from "../_generated/cd_pb.js";
import { FREIGHT_MANIFEST_SCHEMA } from "../events.js";
import { emitCounter, principalName } from "../freight/journal.js";
import { isJsonObject, objectAt, parseJsonText, stringAt } from "../freight/json.js";
import { DIGEST_PATTERN, parseFreightManifest } from "../freight/manifest.js";
import { reason } from "../freight/reasons.js";
import type {
	CdAuthorizer,
	CdBase,
	CdContext,
	FreightIngest,
	FreightLedger,
	FreightSources,
	Outcome,
	ProvenanceVerifier,
	Refusal,
	TelemetrySink,
	TrustedPublisherVerifier,
} from "../ports.js";
import { parseArtifactCdEvent } from "./cdevent.js";
import { readTrustedPublishers } from "./publishers.js";
import { artifactFromSubject, sourcesForPurl } from "./purl.js";
import { INGEST_METRIC, INGEST_REASON } from "./reasons.js";

export type FreightIngestDeps = CdBase & {
	readonly ledger: FreightLedger;
	readonly publishers: TrustedPublisherVerifier;
	readonly provenance: ProvenanceVerifier;
	readonly sources: FreightSources;
	readonly authorizer: CdAuthorizer;
	readonly telemetry?: TelemetrySink;
};

// public-contract: SLSA externalParameters key that carries the Bindle
// declaration hash on an attestation-only push.
export const DECLARATION_HASH_PARAMETER = "hobo.cd/declaration-hash" as const;

function refuse(code: string, message: string, remediation: string, subject = ""): Refusal {
	return { ok: false, reasons: [reason(code, message, remediation, subject)] };
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values.filter((value) => value !== ""))].sort();
}

/**
 * SLSA v1 puts the builder at `predicate.runDetails.builder`; the
 * @hobo/registry parser reads `predicate.builder`. Present the v1 location to
 * the parser without changing the bytes that are verified.
 */
function forRegistryParser(raw: JsonObject): JsonObject {
	const predicate = objectAt(raw, "predicate");
	const runBuilder = objectAt(objectAt(predicate, "runDetails"), "builder");
	if (!predicate || predicate.builder !== undefined || !runBuilder) return raw;
	const withBuilder = { ...predicate, builder: runBuilder };
	const buildType = stringAt(objectAt(predicate, "buildDefinition"), "buildType");
	return { ...raw, predicate: buildType === undefined ? withBuilder : { ...withBuilder, buildType } };
}

type AttestationInput = Readonly<{ bindle: string; statement: Uint8Array; bundle: Uint8Array | undefined; publisherToken: string | undefined }>;

export function createFreightIngest(deps: FreightIngestDeps): FreightIngest {
	function emit(name: string, attributes: Readonly<Record<string, string>>, value = 1): void {
		emitCounter(deps.telemetry, { name, unit: "{event}", atMs: deps.now(), attributes: { tenant: deps.tenant, ...attributes }, value });
	}

	function finish(path: string, outcome: Outcome<FreightRecord>): Outcome<FreightRecord> {
		if (outcome.ok) emit(INGEST_METRIC.accepted, { path });
		else emit(INGEST_METRIC.refused, { path, code: outcome.reasons[0]?.code ?? "" });
		return outcome;
	}

	async function principalFor(bindle: string, token: string | undefined, ctx: CdContext): Promise<Outcome<PrincipalRef>> {
		if (token === undefined) return { ok: true, value: ctx.principal };
		const verified = await deps.publishers.verify(token, ctx);
		if (!verified.ok) return verified;
		const record = (await readTrustedPublishers(deps)).get(verified.value.publisher);
		if (!record?.bindles.includes(bindle)) {
			return refuse(
				INGEST_REASON.publisherScope,
				`publisher ${verified.value.publisher} is not trusted for Bindle ${bindle}`,
				"add the Bindle to the publisher's TrustedPublisherRecord, or publish from the right repository",
				bindle,
			);
		}
		return { ok: true, value: verified.value.principal };
	}

	async function govern(subject: Readonly<Record<string, string>>, ctx: CdContext): Promise<Outcome<string>> {
		const decision = await deps.authorizer.authorize("freight.record", subject, ctx);
		if (!decision.ok) {
			return {
				ok: false,
				reasons: [reason(INGEST_REASON.unauthorized, "freight.record was denied by policy", "request the grant from a policy owner", subject.bindle ?? ""), ...decision.reasons],
			};
		}
		if (decision.value.proposalOnly) {
			return refuse(
				INGEST_REASON.proposalOnly,
				`${principalName(ctx.principal)} may only propose Freight`,
				"publish from a trusted publisher or a granted principal",
				subject.bindle ?? "",
			);
		}
		return { ok: true, value: decision.value.decisionId };
	}

	async function fromAttestation(
		input: AttestationInput,
		origin: FreightOrigin,
		ctx: CdContext,
	): Promise<Outcome<FreightRecord>> {
		let text: string | undefined;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(input.statement);
		} catch {
			text = undefined;
		}
		const raw = text === undefined ? undefined : parseJsonText(text);
		if (!isJsonObject(raw)) return refuse(INGEST_REASON.attestationInvalid, "statement is not a JSON object", "send the in-toto Statement v1 bytes", input.bindle);
		const parsed = parseProvenanceStatement(forRegistryParser(raw));
		if (!parsed.ok) {
			return {
				ok: false,
				reasons: parsed.errors.map((error) =>
					reason(INGEST_REASON.attestationInvalid, `${error.code}: ${error.message}`, "attest with in-toto Statement v1 and an SLSA v1 predicate", input.bindle),
				),
			};
		}
		const declaration = stringAt(objectAt(objectAt(objectAt(raw, "predicate"), "buildDefinition"), "externalParameters"), DECLARATION_HASH_PARAMETER);
		if (declaration === undefined || !DIGEST_PATTERN.test(declaration)) {
			return refuse(
				INGEST_REASON.declarationMissing,
				`externalParameters["${DECLARATION_HASH_PARAMETER}"] must carry the Bindle declaration hash`,
				"add the declaration hash to the build's external parameters, or push a manifest",
				input.bindle,
			);
		}
		const principal = await principalFor(input.bindle, input.publisherToken, ctx);
		if (!principal.ok) return principal;
		const actx: CdContext = { ...ctx, principal: principal.value };
		const artifacts = parsed.statement.subject.map((subject) => artifactFromSubject(subject.name, subject.sha256));
		const pinned = (await deps.sources.list()).filter((source) => source.bindle === input.bindle);
		const request: Parameters<ProvenanceVerifier["verify"]>[0] = {
			statement: input.statement,
			subjects: artifacts,
			trustedBuilderIds: unique(pinned.flatMap((source) => source.subscriptions.flatMap((sub) => sub.trustedBuilderIds))),
			trustedSignerIdentities: unique(pinned.flatMap((source) => source.subscriptions.flatMap((sub) => sub.trustedSignerIdentities))),
		};
		const verified = await deps.provenance.verify(input.bundle ? { ...request, bundle: input.bundle } : request, actx);
		const unverifiedHead = reason(
			INGEST_REASON.provenanceUnverified,
			"the attestation did not verify for every subject",
			"sign the exact statement (Sigstore bundle or HoBo-signed) with a trusted builder and signer",
			input.bindle,
		);
		if (!verified.ok) return { ok: false, reasons: [unverifiedHead, ...verified.reasons] };
		const refs: readonly ProvenanceRef[] = verified.value;
		const covered = new Set(refs.filter((ref) => ref.verified).flatMap((ref) => ref.subjectDigests));
		if (refs.length === 0 || refs.some((ref) => !ref.verified) || artifacts.some((item) => !covered.has(item.digest))) {
			return { ok: false, reasons: [unverifiedHead] };
		}
		const governed = await govern({ bindle: input.bindle, origin: FreightOrigin[origin] ?? "", declarationHash: declaration }, actx);
		if (!governed.ok) return governed;
		const manifest = create(FreightManifestRecordSchema, {
			schemaVersion: FREIGHT_MANIFEST_SCHEMA,
			bindle: input.bindle,
			declarationHash: declaration,
			artifacts,
			source: create(SourceRefSchema, { builderId: parsed.statement.predicate.builderId }),
			provenance: [...refs],
			subject: FreightSubject.BINDLE,
		});
		return deps.ledger.record({ manifest, origin }, actx);
	}

	return {
		async manifest(input, ctx) {
			const parsed = parseFreightManifest(input.manifest);
			if (!parsed.ok) return finish("manifest", parsed);
			const principal = await principalFor(parsed.value.bindle, input.publisherToken, ctx);
			if (!principal.ok) return finish("manifest", principal);
			const actx: CdContext = { ...ctx, principal: principal.value };
			const governed = await govern(
				{ bindle: parsed.value.bindle, origin: "MANIFEST", declarationHash: parsed.value.declarationHash },
				actx,
			);
			if (!governed.ok) return finish("manifest", governed);
			const manifest = clone(FreightManifestRecordSchema, parsed.value);
			for (const ref of manifest.provenance) ref.verified = false;
			return finish("manifest", await deps.ledger.record({ manifest, origin: FreightOrigin.MANIFEST }, actx));
		},

		async attestation(input, ctx) {
			const request: AttestationInput = {
				bindle: input.bindle,
				statement: input.statement,
				bundle: input.bundle,
				publisherToken: input.publisherToken,
			};
			return finish("attestation", await fromAttestation(request, FreightOrigin.ATTESTATION, ctx));
		},

		async cdevent(input, ctx) {
			const event = parseArtifactCdEvent(input.body);
			if (!event.ok) {
				emit(INGEST_METRIC.refused, { path: "cdevent", code: event.reasons[0]?.code ?? "" });
				return event;
			}
			const sources = await deps.sources.list();
			const scheduledPolls = sourcesForPurl(event.value.purl, sources);
			if (scheduledPolls.length > 0) {
				await deps.sources.schedule(scheduledPolls, ctx);
				emit(INGEST_METRIC.pollsScheduled, { path: "cdevent" }, scheduledPolls.length);
			}
			const carried = event.value.attestation;
			if (!carried) return { ok: true, value: { scheduledPolls } };
			const bindles = unique(sources.filter((source) => scheduledPolls.includes(source.name)).map((source) => source.bindle));
			const bindle = carried.bindle !== "" ? carried.bindle : bindles.length === 1 ? (bindles[0] ?? "") : "";
			const trigger = reason(
				INGEST_REASON.unverifiedTrigger,
				`CDEvent ${event.value.id} carried an attestation that did not verify; polls scheduled: ${scheduledPolls.join(", ") || "none"}`,
				"the scheduled polls read the source; fix the attestation to create Freight from the event",
				event.value.subjectId,
			);
			if (bindle === "") return { ok: false, reasons: [trigger, reason(INGEST_REASON.attestationInvalid, "the attestation names no Bindle", "set bindle in the carried attestation", "")] };
			const recorded = finish(
				"cdevent",
				await fromAttestation(
					{ bindle, statement: carried.statement, bundle: carried.bundle, publisherToken: undefined },
					FreightOrigin.CDEVENT,
					ctx,
				),
			);
			if (!recorded.ok) return { ok: false, reasons: [trigger, ...recorded.reasons] };
			return { ok: true, value: { freight: recorded.value, scheduledPolls } };
		},
	};
}
