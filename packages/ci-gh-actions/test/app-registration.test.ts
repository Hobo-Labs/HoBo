import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
	AppRegistrationOwnerMismatchError,
	type AppRegistrationStatePort,
	AppRegistrationUncertainError,
	createAppRegistration,
} from "../src/app-registration.js";

const alice = { accountId: "alice", subject: "github-user-1" };
const bob = { accountId: "bob", subject: "github-user-2" };
function fixture(
	appId: number | null = 42,
	expectedOwnerId?: number,
	responseOwner?: { id: number; type: string },
	verificationEnabled = true,
) {
	const records = new Map<
		string,
		{ purpose: "register" | "install"; actor: typeof alice; expires: number }
	>();
	const saved: unknown[] = [];
	const bindings = new Map<number, string>();
	const network: string[] = [];
	let clock = 1_000;
	let allowed = true;
	let admin = true;
	let failConversion = false;
	const states: AppRegistrationStatePort = {
		async issue(digest, purpose, actor, expiresAt) {
			records.set(digest, { purpose, actor, expires: expiresAt });
		},
		async consume(digest, purpose, actor, now) {
			const record = records.get(digest);
			if (
				!record ||
				record.purpose !== purpose ||
				record.actor.accountId !== actor.accountId ||
				record.actor.subject !== actor.subject ||
				record.expires <= now
			)
				return false;
			records.delete(digest);
			return true;
		},
	};
	const service = createAppRegistration({
		appId: appId ?? undefined,
		expectedGithubOwnerId: expectedOwnerId,
		verifyConvertedApp:
			expectedOwnerId === undefined || !verificationEnabled
				? undefined
				: async () => {},
		states,
		now: () => clock,
		authority: {
			async authorize() {
				return allowed;
			},
			async verifyInstallationAdmin() {
				return admin;
			},
		},
		vault: {
			async saveApp(id, credentials) {
				saved.push({ id, credentials });
			},
			async bindInstallation(_app, id, account) {
				if (bindings.has(id) && bindings.get(id) !== account)
					throw new Error("installation already owned");
				bindings.set(id, account);
			},
		},
		github: {
			async appRequest(path) {
				network.push(path);
				return Response.json({ id: 88, app_id: 42, suspended_at: null });
			},
			async request() {
				throw new Error("unexpected request");
			},
		},
		fetch: async (url, init) => {
			network.push(String(url));
			expect(init?.redirect).toBe("error");
			if (failConversion) throw new Error("contains-secret-never-expose");
			return Response.json({
				id: 42,
				owner: responseOwner,
				pem: "PRIVATE KEY",
				webhook_secret: "webhook",
				client_id: "client",
				client_secret: "secret",
			});
		},
	});
	return {
		service,
		records,
		saved,
		bindings,
		network,
		advance: () => {
			clock += 600_000;
		},
		deny: () => {
			allowed = false;
		},
		denyAdmin: () => {
			admin = false;
		},
		fail: () => {
			failConversion = true;
		},
	};
}

it("binds a one-time state to account, actor and purpose, and stores only its digest", async () => {
	const f = fixture();
	const state = await f.service.begin(alice, "register");
	expect(f.records.has(state)).toBe(false);
	expect(f.records.has(createHash("sha256").update(state).digest("hex"))).toBe(
		true,
	);
	await expect(
		f.service.completeRegistration(bob, state, "code"),
	).rejects.toThrow(/state/);
	await expect(
		f.service.completeInstallation(alice, state, 88),
	).rejects.toThrow(/state/);
	expect(f.network).toEqual([]);
	expect(await f.service.completeRegistration(alice, state, "code")).toEqual({
		appId: 42,
	});
	expect(f.saved).toHaveLength(1);
	await expect(
		f.service.completeRegistration(alice, state, "code"),
	).rejects.toThrow(/state/);
	expect(f.network).toHaveLength(1);
});

it("saves a converted App only when its GitHub owner matches the trusted pin", async () => {
	expect(() => fixture(null, 7, { id: 7, type: "User" }, false)).toThrow(
		/requires App verification/,
	);
	for (const owner of [
		{ id: 99, type: "User" },
		{ id: 7, type: "Organization" },
		undefined,
	]) {
		const f = fixture(null, 7, owner);
		const state = await f.service.begin(alice, "register");
		await expect(
			f.service.completeRegistration(alice, state, "code"),
		).rejects.toBeInstanceOf(AppRegistrationOwnerMismatchError);
		expect(f.saved).toHaveLength(0);
		await expect(
			f.service.completeRegistration(alice, state, "code"),
		).rejects.toThrow(/state/);
		expect(f.network).toHaveLength(1);
	}
	const owned = fixture(null, 7, { id: 7, type: "User" });
	const state = await owned.service.begin(alice, "register");
	expect(
		await owned.service.completeRegistration(alice, state, "code"),
	).toEqual({ appId: 42 });
	expect(owned.saved).toHaveLength(1);
});

it("refuses expired or revoked sessions before remote effects", async () => {
	const f = fixture();
	const state = await f.service.begin(alice, "install");
	f.advance();
	await expect(
		f.service.completeInstallation(alice, state, 88),
	).rejects.toThrow(/expired/);
	f.deny();
	await expect(f.service.begin(alice, "install")).rejects.toThrow(/authorized/);
	expect(f.network).toEqual([]);
});

it("requires GitHub administrator authority before verifying or binding installation", async () => {
	const f = fixture();
	const state = await f.service.begin(alice, "install");
	f.denyAdmin();
	await expect(
		f.service.completeInstallation(alice, state, 88),
	).rejects.toThrow(/administrator/);
	expect(f.network).toEqual([]);
	expect(f.bindings.size).toBe(0);
});

it("binds only a verified App installation and refuses a second account", async () => {
	const f = fixture();
	const state = await f.service.begin(alice, "install");
	expect(await f.service.completeInstallation(alice, state, 88)).toEqual({
		installationId: 88,
	});
	const other = await f.service.begin(bob, "install");
	await expect(f.service.completeInstallation(bob, other, 88)).rejects.toThrow(
		/owned/,
	);
	expect(f.bindings.get(88)).toBe("alice");
});

it("retains uncertain conversion failures and never retries a consumed code or leaks the error", async () => {
	const f = fixture();
	const state = await f.service.begin(alice, "register");
	f.fail();
	await expect(
		f.service.completeRegistration(alice, state, "code"),
	).rejects.toBeInstanceOf(AppRegistrationUncertainError);
	await expect(
		f.service.completeRegistration(alice, state, "code"),
	).rejects.toThrow(/state/);
	expect(f.network).toHaveLength(1);
	expect(f.saved).toHaveLength(0);
});

it("registers an App before its GitHub-assigned ID exists", async () => {
	const f = fixture(null);
	const state = await f.service.begin(alice, "register");
	expect(await f.service.completeRegistration(alice, state, "code")).toEqual({
		appId: 42,
	});
	const setup = await f.service.begin(alice, "install");
	await expect(
		f.service.completeInstallation(alice, setup, 88),
	).rejects.toThrow(/registered App identity required/);
});

it("rejects unsafe conversion codes before an external call", async () => {
	const f = fixture();
	const state = await f.service.begin(alice, "register");
	await expect(
		f.service.completeRegistration(alice, state, "../../repos/a/b"),
	).rejects.toThrow();
	expect(f.network).toEqual([]);
	expect(
		await f.service.completeRegistration(alice, state, "safe-code"),
	).toEqual({ appId: 42 });
});
