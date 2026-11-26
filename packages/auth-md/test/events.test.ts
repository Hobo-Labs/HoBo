import { describe, expect, it } from "vitest";

import type { AgentPrincipalEvent } from "../src/index.js";
import {
	EMPTY_AGENT_PRINCIPAL_VIEW,
	foldAgentPrincipalEvents,
	parseInstant,
	parseRegistrationRef,
	scopeWideningDeniedEvent,
} from "../src/index.js";
import { scopes } from "./fixtures.js";

const ref = parseRegistrationRef("reg_01H8XABCDEF");

const event = (
	type: AgentPrincipalEvent["type"],
	occurredAt: string,
	overrides: Partial<AgentPrincipalEvent> = {},
): AgentPrincipalEvent => ({
	type,
	registrationRef: ref,
	occurredAt: parseInstant(occurredAt),
	phase: "pre-claim",
	scopes: scopes("repo:read"),
	...overrides,
});

describe("agent principal projection", () => {
	it("folds a register → claim → rotate stream into the current view", () => {
		const view = foldAgentPrincipalEvents([
			event("authmd.AgentRegistered", "2026-08-08T12:00:00.000Z"),
			event("authmd.ClaimInitiated", "2026-08-08T12:01:00.000Z"),
			event("authmd.PrincipalClaimed", "2026-08-08T12:05:00.000Z", {
				phase: "human-bound",
				detail: "human:ada",
			}),
			event("authmd.CredentialsRotated", "2026-08-08T12:10:00.000Z", {
				phase: "human-bound",
				detail: "infrastructure-claim",
			}),
		]);

		expect(view).toMatchObject({
			registrationRef: ref,
			phase: "human-bound",
			claimedBy: "human:ada",
			rotationSatisfied: true,
			lastEventAt: "2026-08-08T12:10:00.000Z",
		});
	});

	it("counts denied widenings without changing the phase", () => {
		const view = foldAgentPrincipalEvents([
			event("authmd.AgentRegistered", "2026-08-08T12:00:00.000Z"),
			scopeWideningDeniedEvent({
				registrationRef: ref,
				occurredAt: parseInstant("2026-08-08T12:02:00.000Z"),
				phase: "pre-claim",
				attemptedScopes: scopes("admin:all"),
			}),
		]);

		expect(view.phase).toBe("pre-claim");
		expect(view.deniedWidenings).toBe(1);
	});

	it("clears scopes and rotation state on revocation", () => {
		const view = foldAgentPrincipalEvents([
			event("authmd.AgentRegistered", "2026-08-08T12:00:00.000Z"),
			event("authmd.CredentialsRotated", "2026-08-08T12:10:00.000Z", {
				phase: "human-bound",
			}),
			event("authmd.PrincipalRevoked", "2026-08-08T12:20:00.000Z", {
				phase: "revoked",
				scopes: [],
			}),
		]);

		expect(view.phase).toBe("revoked");
		expect(view.scopes).toEqual([]);
		expect(view.rotationSatisfied).toBe(false);
	});

	it("resumes from a snapshot", () => {
		const snapshot = foldAgentPrincipalEvents([
			event("authmd.AgentRegistered", "2026-08-08T12:00:00.000Z"),
		]);
		const resumed = foldAgentPrincipalEvents(
			[
				event("authmd.PrincipalClaimed", "2026-08-08T12:05:00.000Z", {
					phase: "human-bound",
					detail: "human:ada",
				}),
			],
			snapshot,
		);

		expect(resumed.phase).toBe("human-bound");
		expect(foldAgentPrincipalEvents([], EMPTY_AGENT_PRINCIPAL_VIEW).phase).toBe(
			"unregistered",
		);
	});
});
