import {
	allowDecision,
	denyDecision,
	type PolicyEngine,
	type PrincipalRef,
} from "@hobo/core";
import { POLICY_DECIDED_EVENT } from "../events.js";
import type {
	AuthorityDeps,
	AuthorityParts,
	FleetCommands,
	Outcome,
	PolicyDecisionRecorder,
} from "../ports.js";
import { checkClaim } from "../work/index.js";

const ENGINE_ID = "hobo-fleet-local-owner";

export function principalKey(principal: PrincipalRef): string {
	return `${principal.kind}:${principal.id}`;
}

function unavailable(what: string): Outcome<never> {
	return {
		ok: false,
		error: { code: "unavailable", message: `local mode has no ${what}` },
	};
}

export function ownerOnlyPolicy(owner: PrincipalRef): PolicyEngine {
	const key = principalKey(owner);
	return {
		engineId: ENGINE_ID,
		async evaluate(request) {
			return request.subject.identity === key
				? allowDecision(ENGINE_ID, request, [`${key} owns the local fleet`])
				: denyDecision(ENGINE_ID, request, [
						`only ${key} acts in the local fleet`,
					]);
		},
	};
}

const decisions: PolicyDecisionRecorder = {
	toEvent(request, decision) {
		return {
			type: POLICY_DECIDED_EVENT,
			data: {
				action: request.action,
				effect: decision.effect,
				engineId: decision.engineId,
				reasons: [...decision.reasons],
				subject: request.subject.identity,
				resourceKind: request.resource.kind,
				resourceId: request.resource.id,
			},
		};
	},
};

export function refusingDeps(): Pick<
	AuthorityDeps,
	| "decisions"
	| "issuer"
	| "directory"
	| "accounts"
	| "signIn"
	| "assertions"
	| "overlayMinters"
	| "discovery"
> {
	const noIssuer = (): never => {
		throw new Error("local mode issues no credentials");
	};
	return {
		decisions,
		issuer: {
			issueMember: async () => noIssuer(),
			issuePerson: async () => noIssuer(),
			verify: () => unavailable("credential issuer"),
			jwks: () => '{"keys":[]}',
		},
		directory: { tenantsOf: async () => [] },
		accounts: { verify: async () => unavailable("account credentials") },
		signIn: [],
		assertions: {
			verifyOidc: async () => unavailable("OIDC issuers"),
			verifyCertificateChain: () => unavailable("device CA roots"),
		},
		overlayMinters: [],
		discovery: {
			issuer: "",
			natsUrls: [],
			natsSentinelCredentials: "",
			relayUrls: [],
			minAgentVersion: "",
		},
	};
}

export function localParts(fleets: FleetCommands): AuthorityParts {
	const signIn = async () => unavailable("sign-in");
	return {
		signIn: {
			start: signIn,
			device: signIn,
			callback: signIn,
			approval: signIn,
			approve: signIn,
			complete: signIn,
			poll: signIn,
			refresh: signIn,
		},
		recorder: {
			start() {},
			async stop() {},
			workStatus: async () => unavailable("recorder"),
			workLogs: async () => unavailable("recorder"),
			reliability: () => new Map(),
		},
		projection: { async tick() {}, async caughtUp() {} },
		fleets,
		audit: { async tick() {} },
		checkClaim,
	};
}
