/**
 * npm provenance: the Sigstore bundle a Freight carries, checked against the
 * tarball before it is attached to a publish.
 *
 * npm (libnpmpublish) attaches the bundle as `_attachments["<name>-<version>.sigstore"]`
 * with the bundle's own `mediaType` as `content_type` and the bundle JSON as
 * `data`. The registry then verifies it, and refuses the whole publish if the
 * attested subject is not this tarball. Doing the subject check here first
 * turns that remote 4xx into a typed local refusal that names the cause.
 *
 * This is a binding check, not a signature check: certificate chains and the
 * transparency log are verified by `@hobo/cd/provenance` at ingest and again
 * by the registry. What this module guarantees is that the bundle we attach is
 * *about these bytes and this package version*.
 */
import { reject } from "./errors.js";
import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";
import type { NpmTarball } from "./tarball.js";

const SIGSTORE_MEDIA_TYPE =
	/^application\/vnd\.dev\.sigstore\.bundle(?:\.v0\.[0-9]+)?\+json(?:;version=[0-9.]+)?$/u;

// domain-view: parse-time derived provenance attachment.
export interface NpmProvenanceAttachment {
	readonly contentType: string;
	readonly data: string;
}

export function parseProvenanceBundle(
	bytes: Uint8Array,
	tarball: NpmTarball,
	name: string,
	version: string,
): NpmProvenanceAttachment {
	let data: string;
	let bundle: JsonValue;
	try {
		data = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		// SAFETY: JSON.parse yields a JSON value at this artifact boundary.
		bundle = JSON.parse(data) as JsonValue;
	} catch {
		return reject("npm provenance bundle is not UTF-8 JSON");
	}
	if (
		!isJsonObject(bundle) ||
		!isJsonString(bundle.mediaType) ||
		!SIGSTORE_MEDIA_TYPE.test(bundle.mediaType)
	)
		reject("npm provenance blob is not a Sigstore bundle");
	const statement = dsseStatement(bundle);
	const purls = new Set([
		`pkg:npm/${name}@${version}`,
		`pkg:npm/${name.replace(/^@/u, "%40")}@${version}`,
	]);
	const subjects = isJsonArray(statement.subject) ? statement.subject : [];
	const bound = subjects.some(
		(subject) =>
			isJsonObject(subject) &&
			isJsonString(subject.name) &&
			purls.has(subject.name) &&
			isJsonObject(subject.digest) &&
			subject.digest.sha512 === tarball.sha512Hex,
	);
	if (!bound)
		reject(
			`npm provenance bundle does not attest ${name}@${version} with this tarball's sha512`,
			"attach the bundle produced for this exact tarball; the registry would refuse the publish",
		);
	return Object.freeze({ contentType: bundle.mediaType, data });
}

function dsseStatement(bundle: JsonObject): JsonObject {
	const envelope = bundle.dsseEnvelope;
	if (!isJsonObject(envelope) || !isJsonString(envelope.payload))
		return reject("npm provenance bundle carries no DSSE envelope");
	let statement: JsonValue;
	try {
		// SAFETY: JSON.parse yields a JSON value at this artifact boundary.
		statement = JSON.parse(
			Buffer.from(envelope.payload, "base64").toString("utf8"),
		) as JsonValue;
	} catch {
		return reject("npm provenance DSSE payload is not an in-toto statement");
	}
	if (!isJsonObject(statement))
		return reject("npm provenance DSSE payload is not an in-toto statement");
	return statement;
}
