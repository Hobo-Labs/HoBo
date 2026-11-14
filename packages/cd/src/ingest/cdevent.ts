// Inbound CDEvents (D3, D17): `dev.cdevents.artifact.published` and
// `.packaged`, bare or as the data of a CloudEvent. A CDEvent is a nudge: it
// names a purl, and the only way it can carry Freight is an in-toto statement
// plus a signature bundle under `customData["hobo.cd/attestation"]`, which the
// ingest verifies exactly like a pushed attestation (I15).
import type { JsonObject } from "@bufbuild/protobuf";
import {
	isJsonObject,
	objectAt,
	parseJsonText,
	stringAt,
} from "../freight/json.js";
import { reason } from "../freight/reasons.js";
import type { Outcome } from "../ports.js";
import { type Purl, parsePurl } from "./purl.js";
import { INGEST_REASON } from "./reasons.js";

// public-contract: customData key that carries an attestation on a CDEvent.
export const CDEVENT_ATTESTATION_KEY = "hobo.cd/attestation" as const;
// public-contract: largest inbound CDEvent body, in bytes.
export const CDEVENT_MAX_BYTES = 1_048_576 as const;

const ARTIFACT_EVENT =
	/^dev\.cdevents\.artifact\.(published|packaged)\.0\.\d+\.\d+$/;
const BASE64 = /^[A-Za-z0-9+/=_-]+$/;

export type CarriedAttestation = Readonly<{
	bindle: string;
	statement: Uint8Array;
	bundle: Uint8Array | undefined;
}>;

export type ArtifactCdEvent = Readonly<{
	id: string;
	type: string;
	purl: Purl;
	subjectId: string;
	attestation: CarriedAttestation | undefined;
	/**
	 * Why a carried attestation could not be read (bad base64). The nudge is
	 * still valid: the ingest schedules polls first, then refuses the
	 * attestation as an unverified trigger.
	 */
	attestationError: string | undefined;
}>;

function invalid(message: string): Outcome<never> {
	return {
		ok: false,
		reasons: [
			reason(
				INGEST_REASON.cdeventInvalid,
				message,
				"send a CDEvents v0.4 artifact event as JSON",
				"cdevent",
			),
		],
	};
}

function base64(text: string | undefined): Uint8Array | undefined {
	if (text === undefined || !BASE64.test(text)) return undefined;
	const bytes = Buffer.from(
		text,
		text.includes("-") || text.includes("_") ? "base64url" : "base64",
	);
	return bytes.length > 0 ? new Uint8Array(bytes) : undefined;
}

/** The CDEvent itself: the body, or the `data` of a CloudEvents 1.0 envelope. */
function unwrap(raw: JsonObject): JsonObject {
	return stringAt(raw, "specversion") === "1.0"
		? (objectAt(raw, "data") ?? raw)
		: raw;
}

export function parseArtifactCdEvent(
	body: Uint8Array,
): Outcome<ArtifactCdEvent> {
	if (body.byteLength > CDEVENT_MAX_BYTES)
		return invalid(`CDEvent exceeds ${CDEVENT_MAX_BYTES} bytes`);
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(body);
	} catch {
		return invalid("CDEvent body is not UTF-8");
	}
	const raw = parseJsonText(text);
	if (!isJsonObject(raw)) return invalid("CDEvent body is not a JSON object");
	const event = unwrap(raw);
	const context = objectAt(event, "context");
	const subject = objectAt(event, "subject");
	if (!context || !subject)
		return invalid("CDEvent needs context and subject objects");
	const type = stringAt(context, "type") ?? "";
	const id = stringAt(context, "id") ?? "";
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
	const subjectId = stringAt(subject, "id") ?? "";
	const purl = parsePurl(subjectId);
	if (!purl) return invalid("artifact CDEvent subject.id must be a purl");
	const carried = objectAt(
		objectAt(event, "customData"),
		CDEVENT_ATTESTATION_KEY,
	);
	const nudge = (
		attestation: CarriedAttestation | undefined,
		attestationError: string | undefined,
	): Outcome<ArtifactCdEvent> => ({
		ok: true,
		value: { id, type, purl, subjectId, attestation, attestationError },
	});
	if (!carried) return nudge(undefined, undefined);
	const statement = base64(stringAt(carried, "statement"));
	if (!statement)
		return nudge(
			undefined,
			`customData["${CDEVENT_ATTESTATION_KEY}"].statement must be base64`,
		);
	const bundle = base64(stringAt(carried, "bundle"));
	if (carried.bundle !== undefined && !bundle)
		return nudge(
			undefined,
			`customData["${CDEVENT_ATTESTATION_KEY}"].bundle must be base64`,
		);
	return nudge(
		{ bindle: stringAt(carried, "bindle") ?? "", statement, bundle },
		undefined,
	);
}
