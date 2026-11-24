import type { CredentialResolver } from "@hobo/cd";
import { createTrustedVault } from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	RELAY_DEPLOY_TOKEN_REF,
	readRelayDeployToken,
} from "../src/ci-relay-deploy-credential.js";
import { OwnerCredentialUnavailable } from "../src/owner-store-session.js";

const TOKEN = "synthetic-vercel-token-0123";

function ownerStore(entries: Readonly<Record<string, string>>) {
	const asked: string[] = [];
	const resolver: CredentialResolver = {
		async resolve(ref) {
			asked.push(ref);
			const value = entries[ref];
			if (value === undefined)
				throw new OwnerCredentialUnavailable(ref, "not-in-store");
			return { token: value };
		},
	};
	return { asked, resolver };
}

const noSession: CredentialResolver = {
	async resolve(ref) {
		throw new OwnerCredentialUnavailable(ref, "no-session");
	},
};

describe("readRelayDeployToken", () => {
	it("reads the deploy token hobo cd up keeps, through the owner's store session", async () => {
		const store = ownerStore({ [RELAY_DEPLOY_TOKEN_REF]: TOKEN });
		const read = await readRelayDeployToken({
			ownerCredentials: store.resolver,
		});
		expect(RELAY_DEPLOY_TOKEN_REF).toBe("owner://HOBO_CD_VERCEL_TOKEN");
		expect(read).toEqual({ ok: true, token: TOKEN, source: "owner-store" });
		expect(store.asked).toEqual([RELAY_DEPLOY_TOKEN_REF]);
	});

	it("refuses without a session and points at choose_secret_store", async () => {
		for (const ownerCredentials of [undefined, noSession]) {
			const read = await readRelayDeployToken(
				ownerCredentials === undefined ? {} : { ownerCredentials },
			);
			expect(read).toMatchObject({
				ok: false,
				code: "HOBO_CI_SECRET_STORE_SESSION_REQUIRED",
				message: expect.stringContaining("choose_secret_store"),
			});
		}
	});

	it("refuses a session whose store holds no deploy token and points at hobo cd up", async () => {
		const read = await readRelayDeployToken({
			ownerCredentials: ownerStore({}).resolver,
		});
		expect(read).toMatchObject({
			ok: false,
			code: "HOBO_CI_DEPLOY_AUTH_REQUIRED",
			message: expect.stringContaining("hobo cd up"),
		});
	});

	it("refuses a stored value that is not a single-line token, and does not say it", async () => {
		const bad = "not a\ntoken value";
		const read = await readRelayDeployToken({
			ownerCredentials: ownerStore({ [RELAY_DEPLOY_TOKEN_REF]: bad }).resolver,
		});
		expect(read.ok).toBe(false);
		expect(JSON.stringify(read)).not.toContain("token value");
	});

	it("takes the token hobo ci up's prepare read into its run vault when the session resolver has none", async () => {
		const runVault = createTrustedVault();
		runVault.put("VERCEL_TOKEN", TOKEN);
		expect(await readRelayDeployToken({ runVault })).toEqual({
			ok: true,
			token: TOKEN,
			source: "run-vault",
		});
		expect(
			await readRelayDeployToken({ ownerCredentials: noSession, runVault }),
		).toEqual({ ok: true, token: TOKEN, source: "run-vault" });
	});
});
