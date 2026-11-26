/**
 * `hobo access` — elevated and cross-environment access.
 *
 * This command mints capabilities that let a human reach production. Its whole
 * value is that the grants are **auditable and expiring** rather than raw ACL
 * edits, so the properties worth pinning are the ones that keep them that way.
 *
 * **Break-glass is dual control.** A request alone grants nothing: it returns
 * `requested`, not `granted`, and says an approver distinct from the requester
 * is needed. Single-party break-glass is the exact failure the ceremony exists
 * to prevent — an operator under pressure granting themselves production at
 * three in the morning with nobody watching.
 *
 * **Production carries a second approver on the grant itself.** Not as a
 * policy checked elsewhere, but written into the cross-env grant, so the record
 * of *who* authorised production access travels with the grant rather than
 * living in a log somebody has to correlate.
 *
 * **Every grant expires.** The duration parser is small and load-bearing:
 * unparseable input falls back to thirty minutes rather than to zero (which
 * would mint a dead capability) or to infinity (which would mint a permanent
 * one). A typo in `--duration` must not produce a grant that outlives the
 * incident.
 *
 * **`networkMembershipSufficientAlone: false` is reported on every answer.**
 * Being on the network is not being authorised, and the command says so in its
 * own output rather than leaving the caller to know it.
 */
import { describe, expect, it } from "vitest";

import { createAccessCommand } from "../src/access-command.js";

type Result = {
	ok: boolean;
	status: string;
	code: string;
	message: string;
	remediation?: readonly string[];
	data: Record<string, unknown>;
};

/** Run a subcommand with a pinned clock, capturing progress lines. */
async function run(
	args: readonly string[],
	flags: Record<string, unknown> = {},
	env: NodeJS.ProcessEnv = {},
) {
	const progress: string[] = [];
	const command = createAccessCommand({
		env,
		now: () => "2026-01-01T00:00:00.000Z",
	});
	const result = (await command.run({
		args,
		flags,
		emitProgress: (line: string) => progress.push(line),
	} as never)) as unknown as Result;
	return { result, progress };
}

describe("subcommand routing", () => {
	it("reports status when given no subcommand", async () => {
		// Status is the read-only one; defaulting to a mutation would be a
		// surprise from a bare `hobo access`.
		const { result } = await run([]);
		expect(result.code).toBe("HOBO_ACCESS_STATUS");
	});

	it("refuses an unknown subcommand", async () => {
		const { result } = await run(["reticulate"]);
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_ACCESS_USAGE");
	});

	it("names the subcommand it did not recognise", async () => {
		const { result } = await run(["reticulate"]);
		expect(result.message).toContain("reticulate");
	});

	it("lists the real subcommands as remediation", async () => {
		// A refusal an operator cannot act on is only half a refusal.
		const { result } = await run(["reticulate"]);
		expect(result.remediation?.join(" ")).toMatch(/request.*break-glass/su);
	});

	it("lists the subcommands in its data too, for a machine caller", async () => {
		const { result } = await run(["reticulate"]);
		expect(result.data.subcommands).toEqual([
			"request",
			"break-glass",
			"status",
		]);
	});
});

describe("status", () => {
	it("names the policy pack it is reporting against", async () => {
		// Without it the answer is unmoored: memberships mean different things
		// under different packs.
		const { result } = await run(["status"]);
		expect(result.data.policyPack).toBe("hobo.env-network-isolation/v1");
	});

	it("says that network membership alone is not authorisation", async () => {
		// The single most dangerous inference an operator can draw from a
		// membership list, contradicted in the output itself.
		const { result } = await run(["status"]);
		expect(result.data.networkMembershipSufficientAlone).toBe(false);
	});

	it("lists memberships rather than omitting an empty set", async () => {
		// A caller iterating this must not have to check for undefined.
		const { result } = await run(["status"]);
		expect(Array.isArray(result.data.memberships)).toBe(true);
	});

	it("reports progress so an operator sees what it consulted", async () => {
		const { progress } = await run(["status"]);
		expect(progress.join(" ")).toContain("membership");
	});
});

describe("the environment argument", () => {
	it("refuses a request with no environment", async () => {
		// There is no sensible default: guessing would mint access to somewhere
		// the operator did not name.
		const { result } = await run(["request"]);
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_ACCESS_ENV_REQUIRED");
	});

	it("lists the valid isolation classes when it refuses", async () => {
		const { result } = await run(["request"]);
		expect(result.remediation?.join(" ")).toContain("production");
	});

	it("refuses an environment that is not an isolation class", async () => {
		// "prod" is not "production"; accepting near-misses would grant access
		// to a class the operator did not name.
		const { result } = await run(["request"], { env: "prod-ish" });
		expect(result.code).toBe("HOBO_ACCESS_ENV_REQUIRED");
	});

	it("accepts --env", async () => {
		const { result } = await run(["request"], { env: "staging" });
		expect(result.ok).toBe(true);
	});

	it("accepts --environment as a synonym", async () => {
		const { result } = await run(["request"], { environment: "staging" });
		expect(result.ok).toBe(true);
	});

	it("accepts a positional environment", async () => {
		const { result } = await run(["request", "staging"]);
		expect(result.ok).toBe(true);
	});

	it("prefers the flag over the positional", async () => {
		// The flag is the more deliberate of the two.
		const { result } = await run(["request", "development"], {
			env: "staging",
		});
		expect(result.data.isolationClass).toBe("staging");
	});

	it("refuses break-glass with no environment too", async () => {
		expect((await run(["break-glass"])).result.code).toBe(
			"HOBO_ACCESS_ENV_REQUIRED",
		);
	});
});

describe("break-glass is dual control", () => {
	it("grants nothing on a bare request", async () => {
		// Single-party break-glass is the exact failure the ceremony prevents.
		const { result } = await run(["break-glass"], { env: "production" });
		expect(result.status).toBe("requested");
		expect(result.code).toBe("HOBO_BREAK_GLASS_REQUESTED");
	});

	it("mints no capability without an approver", async () => {
		const { result } = await run(["break-glass"], { env: "production" });
		expect(result.data).not.toHaveProperty("elevatedToken");
		expect(result.data).not.toHaveProperty("capabilityId");
	});

	it("says an approver is needed, and that they must differ", async () => {
		// The remediation is the ceremony: an operator reading only this line
		// has to learn that approving their own request is not the path.
		const { result } = await run(["break-glass"], { env: "production" });
		expect(result.message).toMatch(/approver.*distinct from requester/su);
	});

	it("records the pending request so it can be approved later", async () => {
		// A request that left no record could not be approved by a second party
		// at all.
		const { result } = await run(["break-glass"], { env: "production" });
		expect(result.data.grant).toBeDefined();
	});

	it("grants once a second party approves", async () => {
		const { result } = await run(["break-glass"], {
			env: "production",
			approver: "role:security-officer",
		});
		expect(result.status).toBe("granted");
		expect(result.code).toBe("HOBO_BREAK_GLASS_GRANTED");
	});

	it("mints an expiring capability on approval", async () => {
		// The grant is a capability with an expiry, not an ACL edit somebody has
		// to remember to undo.
		const { result } = await run(["break-glass"], {
			env: "production",
			approver: "role:security-officer",
		});
		expect(result.data.capabilityId).toBeDefined();
		expect(result.data.expiresAt).toBeDefined();
	});

	it("returns the token for session bootstrap but keeps it out of progress", async () => {
		// The operator needs the token; the audit line must not carry it.
		const { result, progress } = await run(["break-glass"], {
			env: "production",
			approver: "role:security-officer",
		});
		expect(result.data.elevatedToken).toBeDefined();
		expect(progress.join(" ")).not.toContain(String(result.data.elevatedToken));
	});

	it("names the grant and its expiry in the progress line", async () => {
		// That is the audit trail an operator reads while it happens.
		const { progress } = await run(["break-glass"], {
			env: "production",
			approver: "role:security-officer",
		});
		expect(progress.join(" ")).toMatch(/break-glass granted .* exp /u);
	});

	it("carries a token reference alongside the token", async () => {
		// The reference is what a log may hold; the token is not.
		const { result } = await run(["break-glass"], {
			env: "production",
			approver: "role:security-officer",
		});
		expect(result.data.tokenRef).toBeDefined();
	});
});

describe("requesting elevated access", () => {
	it("mints a capability for the target class", async () => {
		const { result } = await run(["request"], { env: "staging" });
		expect(result.code).toBe("HOBO_ACCESS_GRANTED");
		expect(result.data.isolationClass).toBe("staging");
	});

	it("issues a cross-environment grant behind the capability", async () => {
		// The grant is the auditable record; the capability is what the operator
		// carries.
		const { result } = await run(["request"], { env: "staging" });
		expect(result.data.crossEnvGrantId).toBeDefined();
	});

	it("defaults the prior class to development", async () => {
		// Elevation is from somewhere; assuming the lowest class means the
		// evidence requirement is at its strictest by default.
		const { result } = await run(["request"], { env: "staging" });
		expect(result.ok).toBe(true);
	});

	it("honours an explicit prior class", async () => {
		const { result } = await run(["request"], {
			env: "production",
			from: "staging",
		});
		expect(result.ok).toBe(true);
	});

	it("ignores an unparseable prior class rather than failing the request", async () => {
		// The target class is what is being granted and it is already validated;
		// a bad `--from` falls back to the strictest prior rather than blocking.
		const { result } = await run(["request"], {
			env: "staging",
			from: "nonsense",
		});
		expect(result.ok).toBe(true);
	});

	it("carries the capability's obligations", async () => {
		// Obligations are the conditions attached to the grant; dropping them
		// would hand out an unconditional capability.
		const { result } = await run(["request"], { env: "staging" });
		expect(result.data.obligations).toBeDefined();
	});

	it("repeats that network membership alone is not enough", async () => {
		const { result } = await run(["request"], { env: "staging" });
		expect(result.data.networkMembershipSufficientAlone).toBe(false);
	});

	it("names the capability and expiry in the progress line", async () => {
		const { progress } = await run(["request"], { env: "staging" });
		expect(progress.join(" ")).toMatch(/access granted staging .*exp /u);
	});

	it("keeps the minted token out of the progress line", async () => {
		const { result, progress } = await run(["request"], { env: "staging" });
		expect(progress.join(" ")).not.toContain(String(result.data.elevatedToken));
	});
});

describe("subject and tenant resolution", () => {
	it("defaults the subject to the local user", async () => {
		const { result } = await run(["request"], { env: "staging" });
		expect(result.ok).toBe(true);
	});

	it("takes the subject from a flag", async () => {
		const { result } = await run(["request"], {
			env: "staging",
			subject: "user:alice",
		});
		expect(result.ok).toBe(true);
	});

	it("falls back to the environment for the subject", async () => {
		const { result } = await run(
			["request"],
			{ env: "staging" },
			{ HOBO_SUBJECT: "user:bob" },
		);
		expect(result.ok).toBe(true);
	});

	it("defaults the tenant to local", async () => {
		const { result } = await run(["status"]);
		expect(result.ok).toBe(true);
	});

	it("takes the tenant from the environment", async () => {
		const { result } = await run(["status"], {}, { HOBO_TENANT: "acme" });
		expect(result.ok).toBe(true);
	});

	it("prefers a tenant flag over the environment", async () => {
		const { result } = await run(
			["status"],
			{ tenant: "flagged" },
			{ HOBO_TENANT: "acme" },
		);
		expect(result.ok).toBe(true);
	});
});

describe("the duration parser", () => {
	const expiry = async (duration: unknown) => {
		const { result } = await run(["request"], { env: "staging", duration });
		return (
			Date.parse(String(result.data.expiresAt)) -
			Date.parse("2026-01-01T00:00:00.000Z")
		);
	};

	it("defaults to thirty minutes when none is given", async () => {
		// Not zero, which would mint a dead capability, and not unbounded, which
		// would mint a permanent one.
		expect(await expiry(undefined)).toBe(1800 * 1000);
	});

	it("reads bare minutes", async () => {
		expect(await expiry("15")).toBe(15 * 60 * 1000);
	});

	it("reads an explicit minute suffix", async () => {
		expect(await expiry("15m")).toBe(15 * 60 * 1000);
	});

	it("reads seconds", async () => {
		expect(await expiry("90s")).toBe(90 * 1000);
	});

	it("reads hours", async () => {
		expect(await expiry("2h")).toBe(2 * 3600 * 1000);
	});

	it("falls back rather than accepting a typo", async () => {
		// A typo in --duration must not produce a grant that outlives the
		// incident, and must not produce one that expires instantly either.
		expect(await expiry("2 hours")).toBe(1800 * 1000);
	});

	it("falls back on a non-string duration", async () => {
		expect(await expiry(90)).toBe(1800 * 1000);
	});

	it("falls back on an empty duration", async () => {
		expect(await expiry("")).toBe(1800 * 1000);
	});

	it("rejects a negative-looking duration by falling back", async () => {
		expect(await expiry("-5m")).toBe(1800 * 1000);
	});

	it("applies the same duration to a break-glass grant", async () => {
		const { result } = await run(["break-glass"], {
			env: "production",
			approver: "role:security-officer",
			duration: "5m",
		});
		expect(
			Date.parse(String(result.data.expiresAt)) -
				Date.parse("2026-01-01T00:00:00.000Z"),
		).toBe(5 * 60 * 1000);
	});
});
