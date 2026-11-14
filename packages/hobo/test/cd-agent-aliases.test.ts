/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unknown-parameters -- SAFETY: tests read recorded call arguments of a fake facade; casts select the member under test. */
// `hobo deploy agent …` are aliases of the `hobo fleet` commands of the same
// meaning (L19, design §8.2): a reconciler is a fleet DEVICE with role
// RECONCILER. `agent enroll --token-file` generates the device keys locally
// and enrolls through the Station's AgentEnrollment, the way
// `hobo fleet enroll --token-file` does; a token on the command line is
// refused (rule 11).
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EnrollmentRequest } from "@hobo/fleet";
import { describe, expect, it } from "vitest";
import {
	CD_DEPLOY_SUBCOMMANDS,
	runCdDeploySubcommand,
} from "../src/cd-deploy.js";
import { type Call, fakeCd, host } from "./support/cd-fakes.js";

const TOKEN = `hft_${"a".repeat(43)}`;

async function tokenDir() {
	const dir = await mkdtemp(join(tmpdir(), "cd-agent-alias-"));
	await writeFile(join(dir, "token"), `${TOKEN}\n`, { mode: 0o600 });
	return dir;
}

const ENROLL_FLAGS = {
	"token-file": "token",
	authority: "https://authority.fleet.test",
	tenant: "acme",
	fleet: "yard-a",
	"key-dir": "keys",
};

function enrollingCd(calls: Call[]) {
	return fakeCd(
		{
			enrollment: {
				enroll: (input: unknown) => {
					const request = (input as { request: EnrollmentRequest }).request;
					return {
						ok: true,
						value: {
							reconciler: { reconcilerId: "m-1", campIds: ["edge-1"] },
							state: 1,
							fleet: request.fleet,
						},
					};
				},
			},
		},
		calls,
	);
}

describe("hobo deploy agent aliases of hobo fleet", () => {
	it("refuses a bootstrap token on the command line", async () => {
		const calls: Call[] = [];
		const dir = await tokenDir();
		const out = await runCdDeploySubcommand(
			host(enrollingCd(calls), { cwd: dir }),
			["agent", "enroll"],
			{ ...ENROLL_FLAGS, token: TOKEN },
		);
		expect(out).toMatchObject({ ok: false, code: "token-on-command-line" });
		expect(calls.filter((c) => c.method === "enroll")).toHaveLength(0);
		expect(JSON.stringify(out)).not.toContain(TOKEN);
	});

	it("enroll --token-file generates the device keys locally and forwards a RECONCILER EnrollmentRequest", async () => {
		const calls: Call[] = [];
		const dir = await tokenDir();
		const out = await runCdDeploySubcommand(
			host(enrollingCd(calls), { cwd: dir }),
			["agent", "enroll"],
			{ ...ENROLL_FLAGS, camp: "edge-1" },
		);
		expect(out.ok).toBe(true);
		expect(JSON.stringify(out)).not.toContain(TOKEN);
		const call = calls.find((c) => c.method === "enroll");
		const input = call?.args[0] as {
			request: EnrollmentRequest;
			dpopProof: string;
			campIds: readonly string[];
		};
		expect(input.request.proof).toEqual({
			case: "bootstrapToken",
			value: TOKEN,
		});
		expect(input.request.fleet).toBe("yard-a");
		expect(input.request.tenant).toBe("acme");
		expect(input.request.identityJwk).not.toContain('"d"');
		expect(input.dpopProof.split(".")).toHaveLength(3);
		expect(input.campIds).toEqual(["edge-1"]);
		for (const name of ["identity", "sign", "seal"]) {
			const file = join(dir, "keys", `${name}.jwk.json`);
			expect((await stat(file)).mode & 0o777).toBe(0o600);
			const jwk = JSON.parse(await readFile(file, "utf8"));
			expect(jwk.d).toEqual(expect.any(String));
		}
	});

	it("never overwrites an existing key directory", async () => {
		const calls: Call[] = [];
		const dir = await tokenDir();
		const first = await runCdDeploySubcommand(
			host(enrollingCd(calls), { cwd: dir }),
			["agent", "enroll"],
			ENROLL_FLAGS,
		);
		expect(first.ok).toBe(true);
		const second = await runCdDeploySubcommand(
			host(enrollingCd(calls), { cwd: dir }),
			["agent", "enroll"],
			ENROLL_FLAGS,
		);
		expect(second).toMatchObject({ ok: false, code: "agent-keys-exist" });
	});

	it("each agent subcommand names the hobo fleet command it aliases", () => {
		const aliases: Record<string, string> = {
			"agent token": "hobo fleet token create",
			"agent enroll": "hobo fleet enroll --token-file",
			"agent approve-key": "hobo fleet member approve",
			"agent accept": "hobo fleet member accept",
			"agent run": "hobo fleet run",
			"agent revoke": "hobo fleet member revoke",
		};
		for (const [sub, fleet] of Object.entries(aliases))
			expect(CD_DEPLOY_SUBCOMMANDS[sub]?.summary).toContain(
				`alias of \`${fleet}\``,
			);
		expect(CD_DEPLOY_SUBCOMMANDS["agent enroll"]?.usage).not.toMatch(
			/--token </,
		);
	});
});
