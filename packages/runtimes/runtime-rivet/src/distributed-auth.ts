import { createHash, type KeyObject, sign, verify } from "node:crypto";

export type RivetJournalAction =
	| "acquire"
	| "check"
	| "release"
	| "append"
	| "read";

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- SAFETY: action arguments and signed capabilities are untrusted Rivet RPC data. */
export interface RivetOperation {
	readonly actorKey: readonly string[];
	readonly action: RivetJournalAction;
	readonly args: unknown;
}

export interface RivetCapabilityClaims {
	readonly version: 1;
	readonly issuer: string;
	readonly audience: string;
	readonly subject: string;
	readonly capabilityId: string;
	readonly scopeDigest: string;
	readonly issuedAtMs: number;
	readonly expiresAtMs: number;
}

export interface RivetSignedCapability extends RivetCapabilityClaims {
	readonly signature: string;
}

export type RivetCapabilityErrorCode =
	| "INVALID_INPUT"
	| "INVALID_CAPABILITY"
	| "AUTHORITY_MISMATCH"
	| "CAPABILITY_NOT_YET_VALID"
	| "CAPABILITY_EXPIRED"
	| "CAPABILITY_DURATION_INVALID"
	| "SCOPE_MISMATCH"
	| "SIGNATURE_INVALID"
	| "POLICY_DENIED"
	| "AUTHORITY_UNAVAILABLE";

export class RivetCapabilityError extends Error {
	constructor(readonly code: RivetCapabilityErrorCode) {
		super(`Rivet capability rejected: ${code}`);
		this.name = "RivetCapabilityError";
	}
}

function validName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 200 &&
		value.trim() === value &&
		!/[\p{Cc}]/u.test(value)
	);
}

type Canonical = string | boolean | number | null | Canonical[];

function canonical(
	value: unknown,
	depth: number,
	ancestors: Set<object>,
	budget: { nodes: number; bytes: number },
): Canonical {
	if (--budget.nodes < 0 || depth > 32)
		throw new RivetCapabilityError("INVALID_INPUT");
	if (value === null) return ["null"];
	if (typeof value === "boolean") return ["boolean", value];
	if (typeof value === "string") {
		budget.bytes -= Buffer.byteLength(value);
		if (budget.bytes < 0) throw new RivetCapabilityError("INVALID_INPUT");
		return ["string", value];
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value) || Object.is(value, -0))
			throw new RivetCapabilityError("INVALID_INPUT");
		return ["number", String(value)];
	}
	if (typeof value !== "object" || ancestors.has(value))
		throw new RivetCapabilityError("INVALID_INPUT");
	ancestors.add(value);
	try {
		const fields = Object.getOwnPropertyDescriptors(value);
		if (Object.getOwnPropertySymbols(value).length > 0)
			throw new RivetCapabilityError("INVALID_INPUT");
		if (Array.isArray(value)) {
			if (
				value.length > 1024 ||
				Object.keys(fields).length !== value.length + 1 ||
				Object.keys(fields).some(
					(key) => key !== "length" && !/^(0|[1-9][0-9]*)$/u.test(key),
				)
			)
				throw new RivetCapabilityError("INVALID_INPUT");
			const items: Canonical[] = [];
			for (let index = 0; index < value.length; index++) {
				const descriptor = fields[String(index)];
				if (
					descriptor === undefined ||
					!("value" in descriptor) ||
					!descriptor.enumerable
				)
					throw new RivetCapabilityError("INVALID_INPUT");
				items.push(canonical(descriptor.value, depth + 1, ancestors, budget));
			}
			return ["array", items];
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null)
			throw new RivetCapabilityError("INVALID_INPUT");
		const entries: Canonical[] = [];
		for (const key of Object.keys(fields).sort()) {
			const field = fields[key];
			budget.bytes -= Buffer.byteLength(key);
			if (
				budget.bytes < 0 ||
				key.length > 200 ||
				field === undefined ||
				!("value" in field) ||
				!field.enumerable
			)
				throw new RivetCapabilityError("INVALID_INPUT");
			entries.push([key, canonical(field.value, depth + 1, ancestors, budget)]);
		}
		return ["object", entries];
	} finally {
		ancestors.delete(value);
	}
}

function encoded(value: unknown): string {
	const text = JSON.stringify(
		canonical(value, 0, new Set(), { nodes: 4_096, bytes: 65_536 }),
	);
	if (Buffer.byteLength(text) > 262_144)
		throw new RivetCapabilityError("INVALID_INPUT");
	return text;
}

const ACTIONS = new Set(["acquire", "check", "release", "append", "read"]);

export function computeRivetOperationDigest(operation: RivetOperation): string {
	try {
		if (
			!Array.isArray(operation.actorKey) ||
			operation.actorKey.length !== 4 ||
			operation.actorKey[0] !== "hobo" ||
			!operation.actorKey.every(validName) ||
			!ACTIONS.has(operation.action) ||
			typeof operation.args !== "object" ||
			operation.args === null ||
			Array.isArray(operation.args)
		)
			throw new RivetCapabilityError("INVALID_INPUT");
		const body = encoded({
			actorKey: [...operation.actorKey],
			action: operation.action,
			args: operation.args,
		});
		return `sha256:${createHash("sha256").update("hobo.rivet.operation.v1\0").update(body).digest("hex")}`;
	} catch {
		throw new RivetCapabilityError("INVALID_INPUT");
	}
}

function validClaims(claims: RivetCapabilityClaims): boolean {
	return (
		claims.version === 1 &&
		[claims.issuer, claims.audience, claims.subject, claims.capabilityId].every(
			validName,
		) &&
		/^sha256:[a-f0-9]{64}$/u.test(claims.scopeDigest) &&
		Number.isSafeInteger(claims.issuedAtMs) &&
		claims.issuedAtMs >= 0 &&
		Number.isSafeInteger(claims.expiresAtMs) &&
		claims.expiresAtMs > claims.issuedAtMs
	);
}

function signable(claims: RivetCapabilityClaims): Buffer {
	return Buffer.from(`hobo.rivet.capability.v1\0${encoded(claims)}`);
}

export function issueRivetCapability(
	input: RivetOperation &
		Omit<RivetCapabilityClaims, "version" | "scopeDigest">,
	privateKey: KeyObject,
): RivetSignedCapability {
	if (
		privateKey.type !== "private" ||
		privateKey.asymmetricKeyType !== "ed25519"
	)
		throw new RivetCapabilityError("INVALID_INPUT");
	const claims: RivetCapabilityClaims = {
		version: 1,
		issuer: input.issuer,
		audience: input.audience,
		subject: input.subject,
		capabilityId: input.capabilityId,
		issuedAtMs: input.issuedAtMs,
		expiresAtMs: input.expiresAtMs,
		scopeDigest: computeRivetOperationDigest(input),
	};
	if (!validClaims(claims)) throw new RivetCapabilityError("INVALID_INPUT");
	return {
		...claims,
		signature: sign(null, signable(claims), privateKey).toString("base64url"),
	};
}

function readCapability(input: unknown): RivetSignedCapability | undefined {
	try {
		if (typeof input !== "object" || input === null || Array.isArray(input))
			return undefined;
		const properties = Object.getOwnPropertyDescriptors(input);
		if (
			Object.getOwnPropertySymbols(input).length !== 0 ||
			Object.keys(properties).length !== 9
		)
			return undefined;
		const read = (key: string): unknown => {
			const descriptor = properties[key];
			if (descriptor === undefined || !("value" in descriptor))
				throw new Error("missing capability field");
			return descriptor.value;
		};
		const version = read("version");
		const issuer = read("issuer");
		const audience = read("audience");
		const subject = read("subject");
		const capabilityId = read("capabilityId");
		const scopeDigest = read("scopeDigest");
		const issuedAtMs = read("issuedAtMs");
		const expiresAtMs = read("expiresAtMs");
		const signature = read("signature");
		if (
			version !== 1 ||
			!validName(issuer) ||
			!validName(audience) ||
			!validName(subject) ||
			!validName(capabilityId) ||
			typeof scopeDigest !== "string" ||
			typeof issuedAtMs !== "number" ||
			typeof expiresAtMs !== "number" ||
			typeof signature !== "string" ||
			!/^[A-Za-z0-9_-]{86}$/u.test(signature)
		)
			return undefined;
		const claims: RivetSignedCapability = {
			version,
			issuer,
			audience,
			subject,
			capabilityId,
			scopeDigest,
			issuedAtMs,
			expiresAtMs,
			signature,
		};
		return validClaims(claims) ? claims : undefined;
	} catch {
		return undefined;
	}
}

export interface RivetCapabilityVerifierOptions {
	readonly issuer: string;
	readonly audience: string;
	readonly publicKey: KeyObject;
	readonly nowMs: () => number;
	readonly maxTtlMs?: number;
	readonly authorize: (input: {
		readonly claims: RivetCapabilityClaims;
		readonly actorKey: readonly string[];
		readonly action: RivetJournalAction;
	}) => boolean | Promise<boolean>;
}

export function createRivetCapabilityVerifier(
	options: RivetCapabilityVerifierOptions,
) {
	const { issuer, audience, publicKey, nowMs, authorize } = options;
	const maxTtlMs = options.maxTtlMs ?? 60_000;
	if (
		!validName(issuer) ||
		!validName(audience) ||
		publicKey.type !== "public" ||
		publicKey.asymmetricKeyType !== "ed25519" ||
		!Number.isSafeInteger(maxTtlMs) ||
		maxTtlMs < 1 ||
		maxTtlMs > 300_000
	)
		throw new RivetCapabilityError("INVALID_INPUT");
	return async (
		input: RivetOperation & { readonly capability: unknown },
	): Promise<RivetCapabilityClaims> => {
		const capability = readCapability(input.capability);
		if (capability === undefined)
			throw new RivetCapabilityError("INVALID_CAPABILITY");
		if (capability.issuer !== issuer || capability.audience !== audience)
			throw new RivetCapabilityError("AUTHORITY_MISMATCH");
		const { signature, ...claims } = capability;
		const signatureBytes = Buffer.from(signature, "base64url");
		if (
			signatureBytes.length !== 64 ||
			signatureBytes.toString("base64url") !== signature ||
			!verify(null, signable(claims), publicKey, signatureBytes)
		)
			throw new RivetCapabilityError("SIGNATURE_INVALID");
		let now: number;
		try {
			now = nowMs();
		} catch {
			throw new RivetCapabilityError("AUTHORITY_UNAVAILABLE");
		}
		if (!Number.isSafeInteger(now) || now < 0)
			throw new RivetCapabilityError("AUTHORITY_UNAVAILABLE");
		if (claims.issuedAtMs > now)
			throw new RivetCapabilityError("CAPABILITY_NOT_YET_VALID");
		if (claims.expiresAtMs <= now)
			throw new RivetCapabilityError("CAPABILITY_EXPIRED");
		if (claims.expiresAtMs - claims.issuedAtMs > maxTtlMs)
			throw new RivetCapabilityError("CAPABILITY_DURATION_INVALID");
		const actorKey = [...input.actorKey];
		const action = input.action;
		const digest = computeRivetOperationDigest({
			actorKey,
			action,
			args: input.args,
		});
		if (claims.scopeDigest !== digest)
			throw new RivetCapabilityError("SCOPE_MISMATCH");
		let allowed: boolean;
		try {
			allowed = await authorize({
				claims: Object.freeze({ ...claims }),
				actorKey: Object.freeze(actorKey),
				action,
			});
		} catch {
			throw new RivetCapabilityError("AUTHORITY_UNAVAILABLE");
		}
		if (allowed !== true) throw new RivetCapabilityError("POLICY_DENIED");
		try {
			now = nowMs();
		} catch {
			throw new RivetCapabilityError("AUTHORITY_UNAVAILABLE");
		}
		if (!Number.isSafeInteger(now) || now < 0)
			throw new RivetCapabilityError("AUTHORITY_UNAVAILABLE");
		if (now < claims.issuedAtMs)
			throw new RivetCapabilityError("CAPABILITY_NOT_YET_VALID");
		if (now >= claims.expiresAtMs)
			throw new RivetCapabilityError("CAPABILITY_EXPIRED");
		return Object.freeze({ ...claims });
	};
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type */
