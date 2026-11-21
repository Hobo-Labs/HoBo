import { createTrustedVault } from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	bitwardenEndpoints,
	parseBitwardenDeviceId,
	provisionBitwardenAccessToken,
} from "../../src/bitwarden-provision.js";
import { ensureBitwardenSignIn } from "../../src/bitwarden-sign-in.js";
import {
	API_KEY,
	fakeBitwarden,
	ORG_ID,
	OTHER_ORG_ID,
	OWNER_EMAIL,
	VAULTWARDEN_ORIGIN,
} from "../support/fake-bitwarden.js";

function setup(vaultwarden = false) {
	const provider = fakeBitwarden({ vaultwarden });
	const vault = createTrustedVault();
	vault.put("BW_CLIENTID", API_KEY.clientId);
	vault.put("BW_CLIENTSECRET", API_KEY.clientSecret);
	let saved: Record<string, string> = {};
	const lines: string[] = [];
	return {
		provider,
		vault,
		lines,
		options: {
			family: "cd" as const,
			vault,
			env: vaultwarden ? { BITWARDEN_SERVER_URL: VAULTWARDEN_ORIGIN } : {},
			locator: {
				read: async () => saved,
				write: async (values: Record<string, string>) => {
					saved = values;
				},
			},
			fetch: provider.fetch,
			emit: (line: string) => lines.push(line),
			sleep: async () => undefined,
			timeoutMs: 60_000,
		},
	};
}

const basicOwner = {
	openUrl: async () => undefined,
	captureSecret: async () => undefined,
	holds: () => false,
};

describe("Bitwarden owner hand-off privacy", () => {
	it.each([
		false,
		true,
	])("keeps approval details and organization coordinates private (vault=%s)", async (vaultwarden) => {
		const fixture = setup(vaultwarden);
		const prompts: { url: string; message: string }[] = [];
		const result = await ensureBitwardenSignIn({
			...fixture.options,
			handOff: true,
			silent: false,
			owner: {
				...basicOwner,
				canConfirm: () => true,
				confirm: async (prompt) => {
					prompts.push(prompt);
					return true;
				},
			},
		});
		expect(result).toBeUndefined();
		expect(prompts).toHaveLength(1);
		expect(prompts[0]?.message).toContain("fingerprint");
		const output = JSON.stringify({ result, lines: fixture.lines });
		for (const value of [
			ORG_ID,
			OWNER_EMAIL,
			VAULTWARDEN_ORIGIN,
			prompts[0]?.url,
			prompts[0]?.message,
		])
			if (value) expect(output).not.toContain(value);
		expect(output).not.toContain("Acme");
		expect(output).not.toContain(API_KEY.clientSecret);
	});

	it("refuses a remote hand-off before provider requests when no private approval is available", async () => {
		const fixture = setup();
		const result = await ensureBitwardenSignIn({
			...fixture.options,
			handOff: true,
			silent: false,
		});
		expect(result?.code).toBe("HOBO_CD_HANDOFF_SILENT");
		expect(fixture.provider.calls).toEqual([]);
		expect(fixture.lines).toEqual([]);
	});

	it("also refuses direct private provisioning without an approval channel", async () => {
		const provider = fakeBitwarden();
		const lines: string[] = [];
		const result = await provisionBitwardenAccessToken({
			family: "cd",
			endpoints: bitwardenEndpoints("us"),
			apiKey: { kind: "egress-proxy" },
			deviceId: parseBitwardenDeviceId("8d0f3c2e-1b4a-4c5d-9e6f-7a8b9c0d1e2f"),
			fetch: provider.fetch,
			emit: (line) => lines.push(line),
			privateOwner: true,
		});
		expect(result).toMatchObject({
			kind: "refused",
			code: "HOBO_CD_HANDOFF_SILENT",
		});
		expect(provider.calls).toEqual([]);
		expect(lines).toEqual([]);
	});

	it("keeps a self-hosted address out of the unanswered credential refusal", async () => {
		const fixture = setup(true);
		fixture.vault.drop("BW_CLIENTID");
		fixture.vault.drop("BW_CLIENTSECRET");
		const result = await ensureBitwardenSignIn({
			...fixture.options,
			handOff: true,
			silent: false,
			owner: basicOwner,
		});
		expect(result?.code).toBe("HOBO_CD_BITWARDEN_NEEDS_API_KEY");
		expect(JSON.stringify(result)).not.toContain(VAULTWARDEN_ORIGIN);
		expect(fixture.lines).toEqual([]);
	});

	it("keeps a self-hosted address out of rejected credential remediation", async () => {
		const fixture = setup(true);
		const result = await ensureBitwardenSignIn({
			...fixture.options,
			fetch: async () =>
				Response.json({ error: "invalid_client" }, { status: 400 }),
			handOff: true,
			silent: false,
			owner: {
				...basicOwner,
				canConfirm: () => true,
				confirm: async () => true,
			},
		});
		expect(result?.code).toBe("HOBO_CD_BITWARDEN_API_KEY_REJECTED");
		expect(JSON.stringify(result)).not.toContain(VAULTWARDEN_ORIGIN);
		expect(fixture.lines).toEqual([]);
	});

	it("refuses private owner channel failures without exposing their details", async () => {
		const captured = setup(true);
		captured.vault.drop("BW_CLIENTID");
		captured.vault.drop("BW_CLIENTSECRET");
		const captureResult = await ensureBitwardenSignIn({
			...captured.options,
			handOff: true,
			silent: false,
			owner: {
				...basicOwner,
				holds: () => {
					throw new Error("fixture-private-capture-error");
				},
			},
		});
		expect(captureResult?.code).toBe("HOBO_CD_OWNER_CHANNEL_FAILED");
		expect(JSON.stringify(captureResult)).not.toContain(
			"fixture-private-capture-error",
		);

		const requested = setup(true);
		requested.vault.drop("BW_CLIENTID");
		requested.vault.drop("BW_CLIENTSECRET");
		const requestResult = await ensureBitwardenSignIn({
			...requested.options,
			handOff: true,
			silent: false,
			owner: {
				...basicOwner,
				requestCaptures: () => {
					throw new Error("fixture-private-request-error");
				},
			},
		});
		expect(requestResult?.code).toBe("HOBO_CD_OWNER_CHANNEL_FAILED");
		expect(JSON.stringify(requestResult)).not.toContain(
			"fixture-private-request-error",
		);

		const approved = setup();
		const approvalResult = await ensureBitwardenSignIn({
			...approved.options,
			handOff: true,
			silent: false,
			owner: {
				...basicOwner,
				canConfirm: () => true,
				confirm: () => {
					throw new Error("fixture-private-approval-error");
				},
			},
		});
		expect(approvalResult?.code).toBe("HOBO_CD_OWNER_CHANNEL_FAILED");
		expect(JSON.stringify(approvalResult)).not.toContain(
			"fixture-private-approval-error",
		);
	});

	it("refuses an owner organization-choice failure explicitly", async () => {
		const fixture = setup();
		const provider = fakeBitwarden({ organizations: 2 });
		const result = await ensureBitwardenSignIn({
			...fixture.options,
			fetch: provider.fetch,
			handOff: true,
			silent: false,
			owner: {
				...basicOwner,
				canConfirm: () => true,
				confirm: async () => true,
				choose: async () => {
					throw new Error("fixture-private-choice-error");
				},
			},
		});
		expect(result?.code).toBe("HOBO_CD_OWNER_CHANNEL_FAILED");
		expect(JSON.stringify(result)).not.toContain(
			"fixture-private-choice-error",
		);
	});

	it("keeps the available organizations inside the owner choice", async () => {
		const fixture = setup();
		const provider = fakeBitwarden({ organizations: 2 });
		let choices: readonly { value: string; label: string }[] = [];
		const result = await ensureBitwardenSignIn({
			...fixture.options,
			fetch: provider.fetch,
			handOff: true,
			silent: false,
			owner: {
				...basicOwner,
				canConfirm: () => true,
				confirm: async () => true,
				choose: async (request) => {
					choices = request.choices;
					return undefined;
				},
			},
		});
		expect(result?.code).toBe("HOBO_CD_BITWARDEN_ORGANIZATION");
		expect(choices).toHaveLength(2);
		const output = JSON.stringify({ result, lines: fixture.lines });
		for (const value of [ORG_ID, OTHER_ORG_ID, "Acme", "Side project"])
			expect(output).not.toContain(value);
		expect(provider.requests).toHaveLength(0);
	});

	it("preserves terminal approval for a local owner", async () => {
		const fixture = setup();
		const result = await ensureBitwardenSignIn({
			...fixture.options,
			handOff: false,
			silent: false,
		});
		expect(result).toBeUndefined();
		expect(fixture.lines.join("\n")).toContain("HOBO_OWNER_BITWARDEN_APPROVE");
		expect(fixture.lines.join("\n")).not.toContain(ORG_ID);
	});
});
