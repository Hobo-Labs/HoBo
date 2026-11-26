import { describe, expect, it } from "vitest";

import {
	advanceAgentPrincipal,
	advanceHumanSession,
	advanceInfrastructure,
	isWorkClaimedByHumanWithRevokedAgent,
	planeSnapshot,
} from "../src/index.js";

describe("the three state machines stay independent", () => {
	it("authenticating a human does not advance the agent or the infrastructure", () => {
		const before = planeSnapshot("anonymous", "pre-claim", "temporary");
		const after = planeSnapshot(
			advanceHumanSession(before.humanSession, "authenticate"),
			before.agentPrincipal,
			before.infrastructure,
		);

		expect(after.humanSession).toBe("authenticated");
		expect(after.agentPrincipal).toBe("pre-claim");
		expect(after.infrastructure).toBe("temporary");
	});

	it("claiming infrastructure does not bind the agent to a human", () => {
		const before = planeSnapshot("authenticated", "pre-claim", "temporary");
		const after = planeSnapshot(
			before.humanSession,
			before.agentPrincipal,
			advanceInfrastructure(before.infrastructure, "claimOwnership"),
		);

		expect(after.infrastructure).toBe("owner-controlled");
		expect(after.agentPrincipal).toBe("pre-claim");
	});

	it("binding an agent to a human does not claim infrastructure", () => {
		const after = planeSnapshot(
			"authenticated",
			advanceAgentPrincipal("pre-claim", "bindToHuman"),
			"temporary",
		);

		expect(after.agentPrincipal).toBe("human-bound");
		expect(after.infrastructure).toBe("temporary");
	});

	it("represents claimed work with a revoked agent", () => {
		expect(
			isWorkClaimedByHumanWithRevokedAgent(
				planeSnapshot("authenticated", "revoked", "owner-controlled"),
			),
		).toBe(true);
		expect(
			isWorkClaimedByHumanWithRevokedAgent(
				planeSnapshot("authenticated", "human-bound", "owner-controlled"),
			),
		).toBe(false);
	});
});

/**
 * Assert an illegal transition is refused *by the transition table*.
 *
 * A bare `.toThrow()` here is worth nothing: `advance` reaches
 * `table[phase][command]`, so a phase the table does not carry throws a
 * `TypeError` on the indexed access instead of refusing, and a bare matcher
 * cannot tell "the machine says no" from "the machine fell over". These pin
 * the `AUTHMD_REVOKED` code, the machine name, and the phase/command pair the
 * refusal is about.
 */
function expectIllegalTransition(
	call: () => unknown,
	machine: string,
	phase: string,
	command: string,
): void {
	let thrown: unknown;
	try {
		call();
	} catch (cause) {
		thrown = cause;
	}
	expect(
		thrown,
		`${machine}: ${command} from ${phase} was allowed`,
	).toBeInstanceOf(Error);
	const error = thrown as Error & {
		code?: unknown;
		details?: Record<string, unknown>;
	};
	expect(error.name).toBe("AuthMdError");
	expect(error.code).toBe("AUTHMD_REVOKED");
	expect(error.message).toBe(
		`${machine}: command ${command} is not legal from ${phase}`,
	);
	expect(error.details).toEqual({ machine, phase, command });
}

describe("illegal transitions fail closed", () => {
	it("cannot bind an unregistered agent to a human", () => {
		expectIllegalTransition(
			() => advanceAgentPrincipal("unregistered", "bindToHuman"),
			"agent-principal",
			"unregistered",
			"bindToHuman",
		);
	});

	it("cannot revoke an already-revoked agent", () => {
		expectIllegalTransition(
			() => advanceAgentPrincipal("revoked", "revoke"),
			"agent-principal",
			"revoked",
			"revoke",
		);
	});

	it("re-registration is the only way back from revoked", () => {
		expect(advanceAgentPrincipal("revoked", "reRegister")).toBe("pre-claim");
	});

	it("owner-controlled infrastructure cannot revert to temporary", () => {
		expectIllegalTransition(
			() => advanceInfrastructure("owner-controlled", "claimOwnership"),
			"infrastructure",
			"owner-controlled",
			"claimOwnership",
		);
		expectIllegalTransition(
			() => advanceInfrastructure("expired", "claimOwnership"),
			"infrastructure",
			"expired",
			"claimOwnership",
		);
	});

	it("cannot authenticate an already-authenticated session", () => {
		expectIllegalTransition(
			() => advanceHumanSession("authenticated", "authenticate"),
			"human-session",
			"authenticated",
			"authenticate",
		);
	});
});
