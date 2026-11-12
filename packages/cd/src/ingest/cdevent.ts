// Inbound CDEvents (D3, D17): `dev.cdevents.artifact.published` and
// `.packaged`, bare or as the data of a CloudEvent. A CDEvent is a nudge: it
// names a purl, and the only way it can carry Freight is an in-toto statement
// plus a signature bundle under `customData["hobo.cd/attestation"]`, which the
// ingest verifies exactly like a pushed attestation (I15).
import type { Outcome } from "../ports.js";
import { reason } from "../freight/reasons.js";
import { type Purl, parsePurl } from "./purl.js";
import { INGEST_REASON } from "./reasons.js";

// public-contract: customData key that carries an attestation on a CDEvent.
export const CDEVENT_ATTESTATION_KEY = "hobo.cd/attestation" as const;
// public-contract: largest inbound CDEvent body, in bytes.
export const CDEVENT_MAX_BYTES = 1_048_576 as const;

const ARTIFACT_EVENT = /^dev\.cdevents\.artifact\.(published|packaged)\.0\.\d+\.\d+$/;

export type CarriedAttestation = Readonly<{ bindle: string; statement: Uint8Array; bundle?: Uint8Array }>;

export type ArtifactCdEvent = Readonly<{
	id: string;
	type: string;
	purl: Purl;
	subjectId: string;
	attestation?: CarriedAttestation;
}>;

type Json = { readonly [key: string]: unknown };

function object(value: unknown): Json | undefined {
	// SAFETY: a non-null, non-array object from JSON.parse is a string-keyed record.
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

function invalid(message: string): Outcome<never> {
	return { ok: false, reasons: [reason(INGEST_REASON.cdeventInvalid, message, "send a CDEvents v0.4 artifact event as JSON", "cdevent")] };
}

function base64(value: unknown): Uint8Array | undefined {
	if (typeof value !== "string" || !/^[A-Za-z0-9+/=_-]+$/.test(value)) return undefined;
	const bytes = Buffer.from(value, value.includes("-") || value.includes("_") ? "base64url" : "base64");
	return bytes.length > 0 ? new Uint8Array(bytes) : undefined;
}

export function parseArtifactCdEvent(body: Uint8Array): Outcome<ArtifactCdEvent> {
	if (body.byteLength > CDEVENT_MAX_BYTES) return invalid(`CDEvent exceeds ${CDEVENT_MAX_BYTES} bytes`);
	let raw: unknown;
	try {
		raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
	} catch {
		return invalid("CDEvent body is not UTF-8 JSON");
	}
	let event = object(raw);
	if (event?.specversion === "1.0" && object(event.data)) event = object(event.data);
	const context = object(event?.context);
	const subject = object(event?.subject);
	if (!event || !context || !subject) return invalid("CDEvent needs context and subject objects");
	const type = typeof context.type === "string" ? context.type : "";
	const id = typeof context.id === "string" ? context.id : "";
	if (!ARTIFACT_EVENT.test(type)) {
		return {
			ok: false,
			reasons: [
				reason(
					INGEST_REASON.cdeventUnsupported,
					`CDEvent type ${type || "(none)"} is not artifact.published or artifact.packaged`,
					"send other CDEvents to the outbound boundary, not to Freight ingest",
					type,
				),
			],
		};
	}
	if (id === "") return invalid("CDEvent context.id is required");
	const subjectId = typeof subject.id === "string" ? subject.id : "";
	const purl = parsePurl(subjectId);
	if (!purl) return invalid("artifact CDEvent subject.id must be a purl");
	const carried = object(object(event.customData)?.[CDEVENT_ATTESTATION_KEY]);
	if (!carried) return { ok: true, value: { id, type, purl, subjectId } };
	const statement = base64(carried.statement);
	if (!statement) return invalid(`customData["${CDEVENT_ATTESTATION_KEY}"].statement must be base64`);
	const bundle = carried.bundle === undefined ? undefined : base64(carried.bundle);
	if (carried.bundle !== undefined && !bundle) return invalid(`customData["${CDEVENT_ATTESTATION_KEY}"].bundle must be base64`);
	const attestation: CarriedAttestation = {
		bindle: typeof carried.bindle === "string" ? carried.bindle : "",
		statement,
		...(bundle ? { bundle } : {}),
	};
	return { ok: true, value: { id, type, purl, subjectId, attestation } };
}
