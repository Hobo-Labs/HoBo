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
import {
	errorCodeOf,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
	parseJsonText,
} from "../artifacts/json.js";

// Opaque values that only ever flow between the sigstore modules.
type TrustedRootMessage = Readonly<{ readonly __sigstore: "TrustedRoot" }>;
type TrustMaterial = Readonly<{ readonly __sigstore: "TrustMaterial" }>;
type ParsedBundle = Readonly<{ readonly __sigstore: "Bundle" }>;
type SignedEntity = Readonly<{ readonly __sigstore: "SignedEntity" }>;

type CertificateIdentity = Readonly<{
	subjectAlternativeName?: string;
	extensions?: Readonly<{ issuer?: string }>;
}>;

type VerificationPolicy = Readonly<{
	subjectAlternativeName?: string;
	extensions?: Readonly<{ issuer?: string }>;
}>;

type VerifierOptions = Readonly<{
	ctlogThreshold: number;
	tlogThreshold: number;
}>;

type Signer = Readonly<{ key: KeyObject; identity?: CertificateIdentity }>;

interface SigstoreVerifier {
	verify(entity: SignedEntity, policy?: VerificationPolicy): Signer;
}

/** The surface of @sigstore/verify@4 that sigstore@5.0.1 itself uses. */
interface VerifyModule {
	Verifier: new (
		trust: TrustMaterial,
		options: VerifierOptions,
	) => SigstoreVerifier;
	toTrustMaterial(root: TrustedRootMessage): TrustMaterial;
	toSignedEntity(bundle: ParsedBundle, artifact?: Buffer): SignedEntity;
}

interface BundleModule {
	bundleFromJSON(json: JsonObject): ParsedBundle;
}

interface SpecsModule {
	TrustedRoot: Readonly<{ fromJSON(json: JsonObject): TrustedRootMessage }>;
}

type SigstoreModules = Readonly<{
	verify: VerifyModule;
	bundle: BundleModule;
	specs: SpecsModule;
	seeds: JsonValue;
}>;

let loaded: SigstoreModules | undefined;

/** The sigstore@5.0.1 verification closure, resolved from the `sigstore` package itself. */
function sigstoreModules(): SigstoreModules {
	if (loaded !== undefined) return loaded;
	const local = createRequire(import.meta.url);
	const fromSigstore = createRequire(local.resolve("sigstore"));
	const verify: VerifyModule = fromSigstore("@sigstore/verify");
	const bundle: BundleModule = fromSigstore("@sigstore/bundle");
	const specs: SpecsModule = fromSigstore("@sigstore/protobuf-specs");
	const seeds: JsonValue = createRequire(fromSigstore.resolve("@sigstore/tuf"))(
		"../seeds.json",
	);
	loaded = { verify, bundle, specs, seeds };
	return loaded;
}

/** The public-good trusted root embedded in the @sigstore/tuf seed that sigstore@5.0.1 ships. */
export function publicGoodSeedRoot(): JsonObject {
	const { seeds } = sigstoreModules();
	const seed = isJsonObject(seeds)
		? seeds["https://tuf-repo-cdn.sigstore.dev"]
		: undefined;
	const targets = isJsonObject(seed) ? seed.targets : undefined;
	const encoded = isJsonObject(targets)
		? targets["trusted_root.json"]
		: undefined;
	const parsed = isJsonString(encoded)
		? parseJsonText(Buffer.from(encoded, "base64").toString("utf8"))
		: undefined;
	if (!isJsonObject(parsed))
		throw new Error(
			"the sigstore public-good seed carries no trusted_root.json",
		);
	return parsed;
}

export type SigstoreTrust = Readonly<{ verifier: SigstoreVerifier }>;

/** Build trust material once per trust policy; throws on a malformed trusted root. */
export function sigstoreTrust(
	trustedRoot: JsonObject,
	thresholds: VerifierOptions,
): SigstoreTrust {
	const { verify, specs } = sigstoreModules();
	const material = verify.toTrustMaterial(
		specs.TrustedRoot.fromJSON(trustedRoot),
	);
	return {
		verifier: new verify.Verifier(material, {
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

const IN_TOTO_PAYLOAD_TYPE = "application/vnd.in-toto+json";

type Entity =
	| Readonly<{ ok: true; entity: SignedEntity }>
	| Readonly<{ ok: false; result: SigstoreResult }>;

function signedEntity(bundle: JsonObject, statement: Uint8Array): Entity {
	const { verify, bundle: bundles } = sigstoreModules();
	let parsed: ParsedBundle;
	try {
		parsed = bundles.bundleFromJSON(bundle);
	} catch (error) {
		return {
			ok: false,
			result: { ok: false, stage: "bundle", detail: errorCodeOf(error) },
		};
	}
	const envelope = bundle.dsseEnvelope;
	try {
		if (!isJsonObject(envelope))
			return {
				ok: true,
				entity: verify.toSignedEntity(parsed, Buffer.from(statement)),
			};
		if (envelope.payloadType !== IN_TOTO_PAYLOAD_TYPE)
			return {
				ok: false,
				result: {
					ok: false,
					stage: "payload",
					detail: "payloadType is not application/vnd.in-toto+json",
				},
			};
		const payload = isJsonString(envelope.payload)
			? Buffer.from(envelope.payload, "base64")
			: undefined;
		if (payload === undefined || !payload.equals(Buffer.from(statement)))
			return {
				ok: false,
				result: {
					ok: false,
					stage: "payload",
					detail: "the DSSE payload is not the statement",
				},
			};
		return { ok: true, entity: verify.toSignedEntity(parsed) };
	} catch (error) {
		return {
			ok: false,
			result: { ok: false, stage: "bundle", detail: errorCodeOf(error) },
		};
	}
}

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
	const entity = signedEntity(bundle, statement);
	if (!entity.ok) return entity.result;
	let signer: Signer;
	try {
		signer = trust.verifier.verify(entity.entity);
	} catch (error) {
		return { ok: false, stage: "signature", detail: errorCodeOf(error) };
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
	const entity = signedEntity(bundle, statement);
	if (!entity.ok) return false;
	try {
		trust.verifier.verify(entity.entity, {
			subjectAlternativeName: policy.subjectAlternativeName,
			extensions: { issuer: policy.issuer },
		});
		return true;
	} catch {
		return false;
	}
}
