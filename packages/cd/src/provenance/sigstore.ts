// Sigstore bundle verification with sigstore@5.0.1's own verification stack,
// against a trusted root the operator injects (never fetched implicitly).
//
// `sigstore`'s top-level `verify()` always fetches its trusted root through TUF
// over its own HTTP client, which would bypass the injected `HttpTransport`
// and make verification depend on the network at decision time. The pieces
// it composes — `@sigstore/verify` (`Verifier`, `toTrustMaterial`,
// `toSignedEntity`), `@sigstore/bundle` and `@sigstore/protobuf-specs` — are
// loaded from the `sigstore` package's own dependency closure (so the version
// is exactly the one `sigstore@5.0.1` pins in the lockfile) and driven with
// the trusted root from the trust policy.

import type { KeyObject } from "node:crypto";
import { createRequire } from "node:module";
import { isJsonObject, type JsonObject } from "../artifacts/json.js";

type CertificateIdentity = Readonly<{
	subjectAlternativeName?: string;
	extensions?: Readonly<{ issuer?: string }>;
}>;

type VerificationPolicy = Readonly<{
	subjectAlternativeName?: string;
	extensions?: Readonly<{ issuer?: string }>;
}>;

type Signer = Readonly<{ key: KeyObject; identity?: CertificateIdentity }>;

type SigstoreVerifier = {
	verify(entity: object, policy?: VerificationPolicy): Signer;
};

type SigstoreModules = Readonly<{
	Verifier: new (trust: object, options: object) => SigstoreVerifier;
	toTrustMaterial(root: object): object;
	toSignedEntity(bundle: object, artifact?: Buffer): object;
	bundleFromJSON(json: JsonObject): object;
	trustedRootFromJSON(json: JsonObject): object;
	publicGoodSeedRoot(): JsonObject;
}>;

let loaded: SigstoreModules | undefined;

function hasFunction<K extends string>(
	value: object,
	key: K,
): value is Record<K, (...args: never[]) => object> {
	return key in value && typeof Reflect.get(value, key) === "function";
}

/** The sigstore@5.0.1 verification closure, resolved from the `sigstore` package itself. */
export function sigstoreModules(): SigstoreModules {
	if (loaded !== undefined) return loaded;
	const local = createRequire(import.meta.url);
	const fromSigstore = createRequire(local.resolve("sigstore"));
	const verify: object = fromSigstore("@sigstore/verify");
	const bundle: object = fromSigstore("@sigstore/bundle");
	const specs: object = fromSigstore("@sigstore/protobuf-specs");
	const tufEntry = fromSigstore.resolve("@sigstore/tuf");
	const seeds: object = createRequire(tufEntry)("../seeds.json");
	const trustedRoot = Reflect.get(specs, "TrustedRoot");
	if (
		!hasFunction(verify, "toTrustMaterial") ||
		!hasFunction(verify, "toSignedEntity") ||
		!hasFunction(bundle, "bundleFromJSON") ||
		typeof Reflect.get(verify, "Verifier") !== "function" ||
		typeof trustedRoot !== "object" ||
		trustedRoot === null ||
		!hasFunction(trustedRoot, "fromJSON")
	)
		throw new Error(
			"sigstore@5.0.1 verification modules are not the expected shape",
		);
	loaded = {
		// SAFETY: checked above to be the @sigstore/verify Verifier class.
		Verifier: Reflect.get(verify, "Verifier") as SigstoreModules["Verifier"],
		toTrustMaterial: (root) => verify.toTrustMaterial(root as never),
		toSignedEntity: (entity, artifact) =>
			verify.toSignedEntity(entity as never, artifact as never),
		bundleFromJSON: (json) => bundle.bundleFromJSON(json as never),
		trustedRootFromJSON: (json) => trustedRoot.fromJSON(json as never),
		publicGoodSeedRoot: () => {
			const seed = Reflect.get(seeds, "https://tuf-repo-cdn.sigstore.dev");
			const targets = isJsonObject(seed) ? seed.targets : undefined;
			const encoded = isJsonObject(targets)
				? targets["trusted_root.json"]
				: undefined;
			const parsed: unknown =
				typeof encoded === "string"
					? JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))
					: undefined;
			if (!isJsonObject(parsed))
				throw new Error(
					"the sigstore public-good seed has no trusted_root.json",
				);
			return parsed;
		},
	};
	return loaded;
}

export type SigstoreTrust = Readonly<{
	verifier: SigstoreVerifier;
}>;

/** Build trust material once per trust policy; throws on a malformed trusted root. */
export function sigstoreTrust(
	trustedRoot: JsonObject,
	thresholds: Readonly<{ ctlogThreshold: number; tlogThreshold: number }>,
): SigstoreTrust {
	const modules = sigstoreModules();
	const material = modules.toTrustMaterial(
		modules.trustedRootFromJSON(trustedRoot),
	);
	return {
		verifier: new modules.Verifier(material, {
			ctlogThreshold: thresholds.ctlogThreshold,
			tlogThreshold: thresholds.tlogThreshold,
		}),
	};
}

export type SigstoreResult =
	| Readonly<{ ok: true; subjectAlternativeName: string; issuer: string }>
	| Readonly<{
			ok: false;
			stage: "bundle" | "payload" | "signature";
			detail: string;
	  }>;

function errorCode<E>(error: E): string {
	if (typeof error === "object" && error !== null) {
		const code = Reflect.get(error, "code");
		if (typeof code === "string") return code;
		const name = Reflect.get(error, "name");
		if (typeof name === "string") return name;
	}
	return "error";
}

const IN_TOTO_PAYLOAD_TYPE = "application/vnd.in-toto+json";

/**
 * Verify a serialized Sigstore bundle over exactly `statement`. A DSSE bundle's
 * payload must be byte-identical to the statement; a message-signature bundle
 * must sign the statement's digest.
 */
export function verifySigstoreBundle(
	trust: SigstoreTrust,
	bundle: JsonObject,
	statement: Uint8Array,
): SigstoreResult {
	const modules = sigstoreModules();
	let parsed: object;
	try {
		parsed = modules.bundleFromJSON(bundle);
	} catch (error) {
		return { ok: false, stage: "bundle", detail: errorCode(error) };
	}
	const envelope = bundle.dsseEnvelope;
	let entity: object;
	try {
		if (isJsonObject(envelope)) {
			const payload =
				typeof envelope.payload === "string"
					? Buffer.from(envelope.payload, "base64")
					: undefined;
			if (envelope.payloadType !== IN_TOTO_PAYLOAD_TYPE)
				return {
					ok: false,
					stage: "payload",
					detail: "payloadType is not application/vnd.in-toto+json",
				};
			if (payload === undefined || !payload.equals(Buffer.from(statement)))
				return {
					ok: false,
					stage: "payload",
					detail: "the DSSE payload is not the statement",
				};
			entity = modules.toSignedEntity(parsed);
		} else {
			entity = modules.toSignedEntity(parsed, Buffer.from(statement));
		}
	} catch (error) {
		return { ok: false, stage: "bundle", detail: errorCode(error) };
	}
	let signer: Signer;
	try {
		signer = trust.verifier.verify(entity);
	} catch (error) {
		return { ok: false, stage: "signature", detail: errorCode(error) };
	}
	return {
		ok: true,
		subjectAlternativeName: signer.identity?.subjectAlternativeName ?? "",
		issuer: signer.identity?.extensions?.issuer ?? "",
	};
}

/** Re-run sigstore's identity policy for the pin that matched (defence in depth). */
export function enforceSigstorePolicy(
	trust: SigstoreTrust,
	bundle: JsonObject,
	statement: Uint8Array,
	policy: Readonly<{ subjectAlternativeName: string; issuer: string }>,
): boolean {
	const modules = sigstoreModules();
	try {
		const parsed = modules.bundleFromJSON(bundle);
		const entity = isJsonObject(bundle.dsseEnvelope)
			? modules.toSignedEntity(parsed)
			: modules.toSignedEntity(parsed, Buffer.from(statement));
		trust.verifier.verify(entity, {
			subjectAlternativeName: policy.subjectAlternativeName,
			extensions: { issuer: policy.issuer },
		});
		return true;
	} catch {
		return false;
	}
}
