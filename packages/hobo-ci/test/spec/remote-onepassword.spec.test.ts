import { describe, expect, it, vi } from "vitest";

import {
	ONE_PASSWORD_SERVICE_ACCOUNT_CAPTURE,
	provisionOnePasswordAccess,
} from "../../src/index.js";
import { ONE_PASSWORD_TEST_TOKEN } from "../support/onepassword-service-account.js";
import { driveRemoteOwner, heldOwnerChannel } from "../support/remote-owner.js";

const TOKEN = ONE_PASSWORD_TEST_TOKEN;
const VAULT = "fixture-private-vault";

function provisioner(
	owner?: ReturnType<typeof heldOwnerChannel>,
	family: "ci" | "cd" = "cd",
) {
	const run = vi.fn(async () => ({ code: 1, stdout: "", stderr: "" }));
	const start = () =>
		provisionOnePasswordAccess({
			family,
			vaultId: VAULT,
			run,
			which: async () => undefined,
			toolsDir: "/unused",
			emit: () => undefined,
			interactive: false,
			validateServiceAccount: async () => true,
			...(owner !== undefined ? { owner } : undefined),
		});
	return { start, run };
}

describe("remote 1Password owner hand-off", () => {
	it.each([
		"ci",
		"cd",
	] as const)("connects an existing service account through the %s owner form", async (family) => {
		const owner = heldOwnerChannel();
		const machine = provisioner(owner, family);
		const exposed: string[] = [];
		const result = await driveRemoteOwner({
			run: async () => {
				const access = await machine.start();
				const lines =
					access.kind === "ready"
						? []
						: [access.code, access.message, ...access.remediation];
				exposed.push(...lines);
				return { ready: access.kind === "ready", lines };
			},
			hands: {
				capture: async (name) => {
					expect(name).toBe(ONE_PASSWORD_SERVICE_ACCOUNT_CAPTURE);
					owner.deposit(name, TOKEN);
				},
			},
		});
		expect(result).toMatchObject({ kind: "ready", trail: ["capture"] });
		expect(machine.run).not.toHaveBeenCalled();
		expect(exposed.join("\n")).not.toContain(TOKEN);
		expect(exposed.join("\n")).not.toContain(VAULT);
		expect(owner.holds(ONE_PASSWORD_SERVICE_ACCOUNT_CAPTURE)).toBe(false);
	});

	it("asks again when the owner channel restarts before the credential is used", async () => {
		const owner = heldOwnerChannel();
		owner.deposit(ONE_PASSWORD_SERVICE_ACCOUNT_CAPTURE, TOKEN);
		owner.restart();
		const machine = provisioner(owner);
		expect(await machine.start()).toMatchObject({
			kind: "refused",
			code: "HOBO_CD_ONEPASSWORD_SIGN_IN",
		});
		expect(machine.run).not.toHaveBeenCalled();
	});

	it("does not treat an empty form submission as a connection", async () => {
		const owner = heldOwnerChannel();
		owner.deposit(ONE_PASSWORD_SERVICE_ACCOUNT_CAPTURE, "");
		const machine = provisioner(owner);
		expect(await machine.start()).toMatchObject({
			kind: "refused",
			code: "HOBO_CD_ONEPASSWORD_SIGN_IN",
		});
		expect(machine.run).not.toHaveBeenCalled();
	});

	it("asks for the secure owner channel without starting a process when none exists", async () => {
		const machine = provisioner();
		const outcome = await machine.start();
		expect(outcome).toMatchObject({
			kind: "refused",
			code: "HOBO_CD_ONEPASSWORD_SIGN_IN",
		});
		expect(machine.run).not.toHaveBeenCalled();
	});
});
