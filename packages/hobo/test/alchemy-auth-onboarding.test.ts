import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandRunInput } from "@hobo/cli";
import { afterEach, describe, expect, it } from "vitest";
import { createDoctorCommand } from "../src/doctor-command.js";
import { loadHoboProfile } from "../src/hobo-profile.js";
import { createBrokerAwareLoginCommand } from "../src/login-command.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function makeLoginInput(
	flags: Record<string, string | boolean>,
	cwd: string,
	verb = "login",
): CommandRunInput {
	const args: readonly string[] = [];
	return {
		verb,
		args,
		// SAFETY: test flags mirror parsed CLI flag entries consumed by login/doctor handlers.
		flags: flags as CommandRunInput["flags"],
		// SAFETY: login and doctor only read context.cwd at this unit boundary.
		context: { cwd } as CommandRunInput["context"],
		emitProgress: () => {},
	};
}

describe("HoBo Alchemy auth onboarding, restart reuse, and cross-box session reuse", () => {
	it("fails closed when owner secret store session is absent", async () => {
		const home = makeTempDir("hobo-alchemy-no-store-");
		const login = createBrokerAwareLoginCommand({ env: { HOBO_HOME: home } });
		const result = await login.run(makeLoginInput({ setup: true, home }, home));
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_AUTH_OWNER_STORE_REQUIRED");
	});

	it("runs initial Alchemy + Better Auth setup, survives HoBo restarts, reuses session on a different box, and fails closed after revocation", async () => {
		const sharedDir = makeTempDir("hobo-alchemy-shared-");
		const box1Home = makeTempDir("hobo-alchemy-box1-");
		const box2Home = makeTempDir("hobo-alchemy-box2-");
		const sharedAuthDb = join(sharedDir, "shared-better-auth.sqlite");
		const sharedSecondaryDb = join(
			sharedDir,
			"shared-better-auth-secondary.sqlite",
		);
		const sharedDomainDb = join(sharedDir, "shared-auth-onboarding.sqlite");

		const signingKeyValue = "owner-vault-signing-secret-v1-at-least-32-chars";
		const ownerVault = new Map<string, string>([
			["HOBO_AUTH_SECRET", signingKeyValue],
			["HOBO_AUTH_OWNER_PASSCODE", "OwnerVaultPasscode!2026"],
		]);
		let heldCookieHeader: string | null = null;
		const sharedCustody = {
			getSessionCookie: () => heldCookieHeader,
			putSessionCookie: (cookie: string) => {
				heldCookieHeader = cookie;
			},
			clearSessionCookie: () => {
				heldCookieHeader = null;
			},
		};
		const resolveOwnerSecret = (name: string) => ownerVault.get(name);

		const box1InitialCli = createBrokerAwareLoginCommand({
			env: { HOBO_HOME: box1Home },
			alchemyAuth: {
				resolveOwnerSecret,
				sessionCustody: sharedCustody,
			},
		});

		const setupResult = await box1InitialCli.run(
			makeLoginInput(
				{
					setup: true,
					home: box1Home,
					workspace: "ws-hobo-prod",
					session: "sess-hobo-prod-1",
					email: "tyler@hobo.localhost",
					name: "Tyler Owner",
					box: "box-macbook-1",
					"alchemy-profile": "default",
					stage: "prod",
					"vault-provider": "infisical",
					issuer: "http://auth.hobo.localhost",
					"base-path": "/api/auth",
					"signing-key-ref": "owner://HOBO_AUTH_SECRET",
					storage: "secondary-sqlite",
					"auth-db": sharedAuthDb,
					"secondary-db": sharedSecondaryDb,
					"domain-db": sharedDomainDb,
				},
				box1Home,
			),
		);

		expect(setupResult.ok).toBe(true);
		expect(setupResult.data).toMatchObject({
			command: "login",
			authMethod: "alchemy-setup",
			authProvider: "HoboAuth",
			workspaceId: "ws-hobo-prod",
			workspacePhase: "Ready",
			sessionId: "sess-hobo-prod-1",
			boxId: "box-macbook-1",
			signingKeyLocator: "owner://HOBO_AUTH_SECRET",
			reusableAcrossBoxes: true,
		});
		expect(heldCookieHeader).toBeTruthy();

		const profileText = readFileSync(join(box1Home, "profile.json"), "utf8");
		expect(profileText).not.toContain(signingKeyValue);
		expect(profileText).not.toContain("OwnerVaultPasscode!2026");
		expect(profileText).not.toContain(heldCookieHeader ?? "");
		const domainDbBytes = readFileSync(sharedDomainDb, "latin1");
		expect(domainDbBytes).not.toContain(signingKeyValue);
		expect(domainDbBytes).not.toContain("OwnerVaultPasscode!2026");

		const parsedProfile = loadHoboProfile(box1Home);
		expect(parsedProfile?.alchemyAuth?.workspaceId).toBe("ws-hobo-prod");
		expect(parsedProfile?.alchemyAuth?.signingKeyLocator).toBe(
			"owner://HOBO_AUTH_SECRET",
		);

		const box1RestartedCli = createBrokerAwareLoginCommand({
			env: { HOBO_HOME: box1Home },
			alchemyAuth: {
				resolveOwnerSecret,
				sessionCustody: sharedCustody,
			},
		});
		const restartResult = await box1RestartedCli.run(
			makeLoginInput(
				{
					resume: true,
					home: box1Home,
					"secondary-db": sharedSecondaryDb,
				},
				box1Home,
			),
		);
		expect(restartResult.ok).toBe(true);
		expect(restartResult.data).toMatchObject({
			authMethod: "alchemy-resume",
			resumed: true,
			crossBox: false,
			boxId: "box-macbook-1",
			resumeCount: 1,
			observedBoxes: ["box-macbook-1"],
		});

		const box2Cli = createBrokerAwareLoginCommand({
			env: { HOBO_HOME: box2Home },
			alchemyAuth: {
				resolveOwnerSecret,
				sessionCustody: sharedCustody,
			},
		});
		const unauthorizedBox2 = await box2Cli.run(
			makeLoginInput(
				{
					resume: true,
					home: box2Home,
					workspace: "ws-hobo-prod",
					session: "sess-hobo-prod-1",
					principal: "user:tyler@hobo.localhost",
					box: "box-devbox-2",
					storage: "secondary-sqlite",
					"auth-db": sharedAuthDb,
					"secondary-db": sharedSecondaryDb,
					"domain-db": sharedDomainDb,
				},
				box2Home,
			),
		);
		expect(unauthorizedBox2.ok).toBe(false);
		expect(unauthorizedBox2.code).toBe(
			"HOBO_AUTH_RESUME_BOXNOTAUTHORIZEDFORSESSION",
		);

		const authorizedBox2 = await box2Cli.run(
			makeLoginInput(
				{
					resume: true,
					home: box2Home,
					workspace: "ws-hobo-prod",
					session: "sess-hobo-prod-1",
					principal: "user:tyler@hobo.localhost",
					box: "box-devbox-2",
					"authorize-box": true,
					storage: "secondary-sqlite",
					"auth-db": sharedAuthDb,
					"secondary-db": sharedSecondaryDb,
					"domain-db": sharedDomainDb,
				},
				box2Home,
			),
		);
		expect(authorizedBox2.ok).toBe(true);
		expect(authorizedBox2.data).toMatchObject({
			authMethod: "alchemy-resume",
			resumed: true,
			crossBox: true,
			boxId: "box-devbox-2",
			resumeCount: 2,
			observedBoxes: ["box-macbook-1", "box-devbox-2"],
		});

		const doctor = createDoctorCommand({ env: { HOBO_HOME: box2Home } });
		const doctorResult = await doctor.run(
			makeLoginInput({}, box2Home, "doctor"),
		);
		expect(doctorResult.data).toMatchObject({
			alchemyAuth: {
				configured: true,
				authProvider: "HoboAuth",
				workspaceId: "ws-hobo-prod",
				signingKeyLocator: "owner://HOBO_AUTH_SECRET",
				boxId: "box-devbox-2",
				allowCrossBoxReuse: true,
				sessionExpired: false,
			},
		});
		expect(JSON.stringify(doctorResult)).not.toContain(signingKeyValue);

		const savedCookieBeforeRevoke = heldCookieHeader ?? "";
		const revokeResult = await box2Cli.run(
			makeLoginInput(
				{
					revoke: true,
					home: box2Home,
					reason: "signed-out-from-box-2",
					"secondary-db": sharedSecondaryDb,
				},
				box2Home,
			),
		);
		expect(revokeResult.ok).toBe(true);
		expect(revokeResult.data).toMatchObject({
			authMethod: "alchemy-revoke",
			revoked: true,
			sessionId: "sess-hobo-prod-1",
			reason: "signed-out-from-box-2",
		});

		heldCookieHeader = savedCookieBeforeRevoke;
		const box1AfterRevoke = await box1RestartedCli.run(
			makeLoginInput(
				{
					resume: true,
					home: box1Home,
					"secondary-db": sharedSecondaryDb,
				},
				box1Home,
			),
		);
		expect(box1AfterRevoke.ok).toBe(false);
		expect(
			box1AfterRevoke.code === "HOBO_AUTH_BETTER_AUTH_SESSION_INVALID" ||
				box1AfterRevoke.code === "HOBO_AUTH_RESUME_AUTHSESSIONALREADYREVOKED",
		).toBe(true);
	});

	it("fails closed when owner://HOBO_AUTH_SECRET rotates underneath an existing session", async () => {
		const home = makeTempDir("hobo-alchemy-rotate-");
		let currentSecret = "initial-signing-secret-value-at-least-32-chars";
		let heldCookieHeader: string | null = null;
		const deps = {
			env: { HOBO_HOME: home },
			alchemyAuth: {
				resolveOwnerSecret: (name: string) =>
					name === "HOBO_AUTH_SECRET" ? currentSecret : undefined,
				sessionCustody: {
					getSessionCookie: () => heldCookieHeader,
					putSessionCookie: (cookie: string) => {
						heldCookieHeader = cookie;
					},
				},
			},
		};
		const cli = createBrokerAwareLoginCommand(deps);
		const setup = await cli.run(
			makeLoginInput(
				{
					setup: true,
					home,
					workspace: "ws-rotate-e2e",
					session: "sess-rotate-e2e",
					email: "rotate@hobo.localhost",
					box: "box-rotate-1",
				},
				home,
			),
		);
		expect(setup.ok).toBe(true);

		currentSecret = "rotated-signing-secret-value-at-least-32-chars";
		const resumeAfterRotate = await cli.run(
			makeLoginInput({ resume: true, home }, home),
		);
		expect(resumeAfterRotate.ok).toBe(false);
		expect(resumeAfterRotate.code).toBe(
			"HOBO_AUTH_BETTER_AUTH_SESSION_INVALID",
		);
	});

	it("supports idempotent re-setup refresh, post-revoke re-establishment, and rejects unknown flags fail-closed", async () => {
		const home = makeTempDir("hobo-alchemy-resetup-");
		let heldCookieHeader: string | null = null;
		const cli = createBrokerAwareLoginCommand({
			env: { HOBO_HOME: home },
			alchemyAuth: {
				resolveOwnerSecret: (name: string) =>
					name === "HOBO_AUTH_SECRET"
						? "resetup-signing-secret-value-at-least-32-chars"
						: undefined,
				sessionCustody: {
					getSessionCookie: () => heldCookieHeader,
					putSessionCookie: (cookie: string) => {
						heldCookieHeader = cookie;
					},
					clearSessionCookie: () => {
						heldCookieHeader = null;
					},
				},
			},
		});

		const invalidVault = await cli.run(
			makeLoginInput({ setup: true, home, "vault-provider": "bogus" }, home),
		);
		expect(invalidVault.ok).toBe(false);
		expect(invalidVault.code).toBe("HOBO_AUTH_INVALID_FLAG");

		const invalidStorage = await cli.run(
			makeLoginInput({ setup: true, home, storage: "bogus" }, home),
		);
		expect(invalidStorage.ok).toBe(false);
		expect(invalidStorage.code).toBe("HOBO_AUTH_INVALID_FLAG");

		const firstSetup = await cli.run(
			makeLoginInput(
				{
					setup: true,
					home,
					workspace: "ws-resetup-1",
					session: "sess-resetup-1",
					email: "resetup@hobo.localhost",
					box: "box-resetup-1",
				},
				home,
			),
		);
		expect(firstSetup.ok).toBe(true);

		const refreshedSetup = await cli.run(
			makeLoginInput(
				{
					setup: true,
					home,
					workspace: "ws-resetup-1",
					session: "sess-resetup-1",
					email: "resetup@hobo.localhost",
					box: "box-resetup-1",
				},
				home,
			),
		);
		expect(refreshedSetup.ok).toBe(true);
		expect(refreshedSetup.data).toMatchObject({
			sessionId: "sess-resetup-1",
			workspacePhase: "Ready",
		});

		const revoked = await cli.run(makeLoginInput({ revoke: true, home }, home));
		expect(revoked.ok).toBe(true);

		const reestablished = await cli.run(
			makeLoginInput(
				{
					setup: true,
					home,
					workspace: "ws-resetup-1",
					session: "sess-resetup-1",
					email: "resetup@hobo.localhost",
					box: "box-resetup-1",
				},
				home,
			),
		);
		expect(reestablished.ok).toBe(true);
		expect(reestablished.data).toMatchObject({
			workspacePhase: "Ready",
		});
		const resumedFresh = await cli.run(
			makeLoginInput({ resume: true, home }, home),
		);
		expect(resumedFresh.ok).toBe(true);
	});
});
