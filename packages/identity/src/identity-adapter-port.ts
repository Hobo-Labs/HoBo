/**
 * Identity adapter verification port — source/target dual path implements this.
 * Contract-asserted fixtures satisfy the same port offline (ADR-0070 + ADR-0132).
 */
import type { AdapterClaims } from "./dual-adapter.js";
import {
	createContractAssertedDualFixtures,
	type DualIdentityFixtures,
} from "./migration-dual-fixtures.js";

// public-contract: identity adapter port interface id.
export const IDENTITY_ADAPTER_INTERFACE = "hobo:identity/adapter" as const;

export type IdentityAdapterKind = "oidc" | "saml" | "custom-jwt" | "fixture";

export type AdapterVerifyResult =
	| Readonly<{
			ok: true;
			adapterId: string;
			claims: AdapterClaims;
			fidelity: "live" | "simulated";
	  }>
	| Readonly<{
			ok: false;
			adapterId: string;
			code: string;
			reason: string;
	  }>;

/**
 * Port shape every identity adapter (live IdP or contract fixture) implements.
 * Dual-path migration verifies both source and target through this port.
 */
export interface IdentityAdapter {
	readonly id: string;
	readonly kind: IdentityAdapterKind;
	readonly fidelity: "live" | "simulated";
	/** Verify presented material → claims. Fixtures use contract-asserted claims. */
	verify(input: {
		readonly subjectHint?: string;
		readonly material?: string;
	}): AdapterVerifyResult;
	/** Opaque subject for a known PrincipalRef alias (if linked). */
	subjectFor?(principalRef: string): string | undefined;
}

export class ContractAssertedIdentityAdapter implements IdentityAdapter {
	readonly id: string;
	readonly kind: IdentityAdapterKind = "fixture";
	readonly fidelity = "simulated" as const;
	private readonly claims: AdapterClaims;

	constructor(input: {
		readonly id: string;
		readonly claims: AdapterClaims;
	}) {
		this.id = input.id;
		this.claims = Object.freeze({ ...input.claims });
	}

	verify(input: {
		readonly subjectHint?: string;
		readonly material?: string;
	}): AdapterVerifyResult {
		// Material is ignored for fixtures; subjectHint may select alternate subject.
		const claims =
			input.subjectHint && input.subjectHint !== this.claims.sub
				? Object.freeze({ ...this.claims, sub: input.subjectHint })
				: this.claims;
		return Object.freeze({
			ok: true as const,
			adapterId: this.id,
			claims,
			fidelity: this.fidelity,
		});
	}
}

export type DualAdapterPair = Readonly<{
	source: IdentityAdapter;
	target: IdentityAdapter;
	fixtures: DualIdentityFixtures;
}>;

/**
 * Build source+target adapters from contract-asserted dual fixtures.
 * Production swaps these for live OIDC adapters behind the same port.
 */
export function createDualAdapterPair(input?: {
	readonly tenant?: string;
	readonly sourceAdapter?: string;
	readonly targetAdapter?: string;
	readonly subject?: string;
}): DualAdapterPair {
	const fixtures = createContractAssertedDualFixtures(input);
	return Object.freeze({
		source: new ContractAssertedIdentityAdapter({
			id: fixtures.sourceAdapter,
			claims: fixtures.sourceClaims,
		}),
		target: new ContractAssertedIdentityAdapter({
			id: fixtures.targetAdapter,
			claims: fixtures.targetClaims,
		}),
		fixtures,
	});
}

/**
 * Verify both adapters and return claims for dualVerifyClaims.
 * Fail-closed if either adapter fails.
 */
export function verifyDualAdapters(input: {
	readonly source: IdentityAdapter;
	readonly target: IdentityAdapter;
	readonly subjectHint?: string;
}):
	| {
			ok: true;
			sourceClaims: AdapterClaims;
			targetClaims: AdapterClaims;
			fidelity: "live" | "simulated";
	  }
	| { ok: false; code: string; reason: string } {
	const s = input.source.verify({
		...(input.subjectHint !== undefined
			? { subjectHint: input.subjectHint }
			: undefined),
	});
	const t = input.target.verify({
		...(input.subjectHint !== undefined
			? { subjectHint: input.subjectHint }
			: undefined),
	});
	if (s.ok === false) {
		return {
			ok: false,
			code: s.code,
			reason: `source adapter: ${s.reason}`,
		};
	}
	if (t.ok === false) {
		return {
			ok: false,
			code: t.code,
			reason: `target adapter: ${t.reason}`,
		};
	}
	const fidelity =
		s.fidelity === "live" && t.fidelity === "live" ? "live" : "simulated";
	return {
		ok: true,
		sourceClaims: s.claims,
		targetClaims: t.claims,
		fidelity,
	};
}
