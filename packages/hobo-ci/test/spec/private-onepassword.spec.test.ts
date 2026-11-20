import { describe, expect, it, vi } from "vitest";

import { provisionOnePasswordAccess } from "../../src/onepassword-access.js";
import { ONE_PASSWORD_TEST_TOKEN } from "../support/onepassword-service-account.js";
import { heldOwnerChannel } from "../support/remote-owner.js";

const VAULT = "private-fixture-vault";
const TOKEN = ONE_PASSWORD_TEST_TOKEN;

function provision(
	owner?: ReturnType<typeof heldOwnerChannel>,
	validateServiceAccount: () => Promise<boolean> = async () => true,
) {
	const run = vi.fn(async () => ({ code: 1, stdout: "", stderr: "" }));
	return {
		run,
		start: () =>
			provisionOnePasswordAccess({
				family: "cd",
				vaultId: VAULT,
				run,
				which: async () => undefined,
				toolsDir: "/unused",
				emit: () => undefined,
				interactive: false,
				validateServiceAccount,
				...(owner !== undefined ? { owner } : undefined),
			}),
	};
}

describe("private remote 1Password access", () => {
	it("uses an existing credential from the owner form without starting a subprocess", async () => {
		const owner = heldOwnerChannel();
		owner.deposit("OP_SERVICE_ACCOUNT_TOKEN", TOKEN);
		const request = provision(owner);
		const result = await request.start();
		expect(result).toEqual({ kind: "ready", token: TOKEN });
		expect(owner.holds("OP_SERVICE_ACCOUNT_TOKEN")).toBe(false);
		expect(request.run).not.toHaveBeenCalled();
	});

	it("waits for a private form without exposing settings or opening a process", async () => {
		const owner = heldOwnerChannel();
		const request = provision(owner);
		const result = await request.start();
		expect(result).toMatchObject({
			kind: "refused",
			code: "HOBO_CD_ONEPASSWORD_SIGN_IN",
		});
		expect(JSON.stringify(result)).not.toContain(VAULT);
		expect(JSON.stringify(result)).not.toContain(TOKEN);
		expect(request.run).not.toHaveBeenCalled();
	});

	it("does not start a process when there is no owner channel", async () => {
		const request = provision();
		expect(await request.start()).toMatchObject({
			kind: "refused",
			code: "HOBO_CD_ONEPASSWORD_SIGN_IN",
		});
		expect(request.run).not.toHaveBeenCalled();
	});

	it("does not expose private details from a failing owner channel", async () => {
		const owner = {
			...heldOwnerChannel(),
			requestCaptures: async () => {
				throw new Error(`${TOKEN} ${VAULT}`);
			},
		};
		const request = provision(owner);
		const result = await request.start();
		expect(result).toMatchObject({
			kind: "refused",
			code: "HOBO_CD_ONEPASSWORD_SIGN_IN",
		});
		expect(JSON.stringify(result)).not.toContain(TOKEN);
		expect(JSON.stringify(result)).not.toContain(VAULT);
		expect(request.run).not.toHaveBeenCalled();
	});

	it.each([
		"   ",
		"not-a-service-account",
		`ops_${Buffer.from("not-json").toString("base64url")}`,
		`ops_${Buffer.from(JSON.stringify({ secretKey: "missing-scope-material" })).toString("base64url")}`,
	])("fails closed for an invalid service-account token", async (token) => {
		const owner = heldOwnerChannel();
		owner.deposit("OP_SERVICE_ACCOUNT_TOKEN", token);
		const validate = vi.fn(async () => true);
		const request = provision(owner, validate);
		const result = await request.start();
		expect(result).toMatchObject({
			kind: "refused",
			code: "HOBO_CD_ONEPASSWORD_SERVICE_ACCOUNT",
		});
		expect(JSON.stringify(result)).not.toContain(token);
		expect(validate).not.toHaveBeenCalled();
		expect(request.run).not.toHaveBeenCalled();
	});

	it.each([false, true])(
		"fails closed when vault-scope validation returns false or throws (%s)",
		async (throws) => {
			const owner = heldOwnerChannel();
			owner.deposit("OP_SERVICE_ACCOUNT_TOKEN", TOKEN);
			const validate = vi.fn(async () => {
				if (throws) throw new Error(TOKEN);
				return false;
			});
			const request = provision(owner, validate);
			const result = await request.start();
			expect(result).toMatchObject({
				kind: "refused",
				code: "HOBO_CD_ONEPASSWORD_SERVICE_ACCOUNT",
			});
			expect(JSON.stringify(result)).not.toContain(TOKEN);
			expect(validate).toHaveBeenCalledWith(TOKEN, VAULT);
			expect(request.run).not.toHaveBeenCalled();
		},
	);

	it("refuses local provisioning when no CLI runner is available", async () => {
		const result = await provisionOnePasswordAccess({
			family: "ci",
			vaultId: VAULT,
			which: async () => undefined,
			toolsDir: "/unused",
			emit: () => undefined,
			interactive: true,
		});
		expect(result).toMatchObject({
			kind: "refused",
			code: "HOBO_CI_ONEPASSWORD_CLI_INSTALL",
		});
		expect(JSON.stringify(result)).not.toContain(VAULT);
	});
});
