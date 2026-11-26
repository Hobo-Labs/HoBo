/**
 * The CLI's trust roots: who is allowed to vouch for provider evidence.
 *
 * `@hobo/trust` implements no cryptography on purpose — it states the port and
 * treats anything other than `valid` as a reason not to select a provider.
 * This module is the Station-local implementation of that port: Ed25519 public
 * keys published under `HOBO_HOME/trust-roots/`, and `node:crypto` doing the
 * verifying.
 *
 * Fail-closed is the whole design. An operator with no roots configured gets
 * `unknown` for every artifact and therefore selects nothing, which is the
 * correct outcome: "I never said whose attestations I accept" and "nobody
 * attested this" should not lead to different deployments.
 */

import { createPublicKey, verify as verifySignature } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	EvidenceVerificationRequest,
	EvidenceVerifier,
} from "@hobo/trust";
import { isJsonObject, isJsonString, type JsonValue } from "./json.js";

/** Directory under `HOBO_HOME` holding published trust roots. */
// public-contract: operators publish accepted roots under this stable path.
export const TRUST_ROOTS_DIRECTORY = "trust-roots";

/** Signature encoding this verifier understands. */
// public-contract: evidence signatures advertise this supported encoding.
export const SIGNATURE_PREFIX = "ed25519:";

export type TrustRootRecord = {
	/** Stable id, reported in the verdict so a verdict says *who* vouched. */
	readonly id: string;
	/** SPKI public key, PEM encoded. */
	readonly publicKeyPem: string;
	/**
	 * Providers this root may vouch for. Absent means every provider.
	 *
	 * Scoping matters once more than one party publishes evidence: a root that
	 * only ran the Netlify suites should not be able to vouch for Neon.
	 */
	readonly providerIds?: readonly string[];
};

export class TrustRootError extends Error {
	readonly code: string;

	constructor(code: string, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "TrustRootError";
		this.code = code;
	}
}

function parseTrustRoot(
	fileName: string,
	value: JsonValue | undefined,
): TrustRootRecord {
	if (!isJsonObject(value) || value === null) {
		throw new TrustRootError(
			"trust-root-invalid",
			`trust-root-invalid: ${fileName} is not an object`,
		);
	}
	// SAFETY: assertion required at this I/O or test boundary.
	const record = value as Partial<TrustRootRecord>;
	if (!isJsonString(record.id) || record.id.length === 0) {
		throw new TrustRootError(
			"trust-root-invalid",
			`trust-root-invalid: ${fileName} declares no id`,
		);
	}
	if (
		!isJsonString(record.publicKeyPem) ||
		!record.publicKeyPem.includes("BEGIN PUBLIC KEY")
	) {
		throw new TrustRootError(
			"trust-root-invalid",
			`trust-root-invalid: ${fileName} declares no SPKI public key`,
		);
	}
	if (
		record.providerIds !== undefined &&
		(!Array.isArray(record.providerIds) ||
			record.providerIds.some((entry) => !isJsonString(entry)))
	) {
		throw new TrustRootError(
			"trust-root-invalid",
			`trust-root-invalid: ${fileName} declares a non-string providerId`,
		);
	}
	return {
		id: record.id,
		publicKeyPem: record.publicKeyPem,
		...(record.providerIds !== undefined
			? { providerIds: [...record.providerIds] }
			: undefined),
	};
}

/** Read every published trust root, sorted so the verifier id is stable. */
export async function loadTrustRoots(
	home: string,
): Promise<readonly TrustRootRecord[]> {
	const directory = join(home, TRUST_ROOTS_DIRECTORY);
	let entries: readonly string[];
	try {
		entries = await readdir(directory);
	} catch (cause) {
		// SAFETY: assertion required at this I/O or test boundary.
		if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw new TrustRootError(
			"trust-roots-unreadable",
			`trust-roots-unreadable: cannot read ${directory}`,
			{ cause },
		);
	}
	const roots: TrustRootRecord[] = [];
	for (const entry of [...entries].sort()) {
		if (!entry.endsWith(".json")) continue;
		const path = join(directory, entry);
		let parsed: JsonValue;
		try {
			parsed = JSON.parse(await readFile(path, "utf8"));
		} catch (cause) {
			throw new TrustRootError(
				"trust-root-invalid",
				`trust-root-invalid: ${entry} is not valid JSON`,
				{ cause },
			);
		}
		roots.push(parseTrustRoot(entry, parsed));
	}
	return roots;
}

/**
 * Build the verifier from a set of roots.
 *
 * A malformed key or an unparseable signature answers `invalid` rather than
 * throwing: a broken artifact must cost that one provider its ranking, not
 * abort the whole resolution.
 */
export function createTrustRootVerifier(
	roots: readonly TrustRootRecord[],
): EvidenceVerifier {
	const id =
		roots.length === 0
			? "hobo.no-trust-root/v1"
			: `hobo.station-trust-roots/v1#${roots.map((root) => root.id).join(",")}`;

	return {
		id,
		verify(request: EvidenceVerificationRequest) {
			if (roots.length === 0) return "unknown";
			if (!request.signature.startsWith(SIGNATURE_PREFIX)) return "unknown";
			const signature = Buffer.from(
				request.signature.slice(SIGNATURE_PREFIX.length),
				"base64",
			);
			if (signature.length === 0) return "invalid";

			const applicable = roots.filter(
				(root) =>
					root.providerIds === undefined ||
					root.providerIds.includes(request.providerId),
			);
			if (applicable.length === 0) return "unknown";

			for (const root of applicable) {
				try {
					const key = createPublicKey(root.publicKeyPem);
					// The caller recomputed the digest; the signature is over those
					// canonical bytes and nothing else.
					if (
						verifySignature(
							null,
							Buffer.from(request.evidenceDigest, "utf8"),
							key,
							signature,
						)
					) {
						return "valid";
					}
				} catch {
					// A key this Station cannot load vouches for nothing. Keep
					// checking the others rather than failing the whole set.
				}
			}
			return "invalid";
		},
	};
}

/** Convenience: read the Station's roots and build the verifier. */
export async function stationEvidenceVerifier(
	home: string,
): Promise<EvidenceVerifier> {
	return createTrustRootVerifier(await loadTrustRoots(home));
}
