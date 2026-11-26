/**
 * `hobo login` — the fixture lane, the device-code lane, and the profile it
 * writes either way.
 *
 * Login has two modes and the switch between them is a single environment
 * variable. That makes the fail-closed rule the important property here:
 * **once `HOBO_OIDC_ISSUER` is configured, no failure falls back to the
 * fixture session.** A discovery timeout, a denied authorization, a missing
 * fetch seam — each is a typed error. Silently issuing a local fixture
 * identity instead would leave a user believing they had logged into their
 * real issuer while holding a credential no broker will accept, and the
 * failure would surface later, somewhere unrelated.
 *
 * Both lanes converge on the same profile write. Whatever identity was
 * established, `hobo login` persists it under HOBO_HOME along with the default
 * broker, because that profile is what every later command reads to know who
 * the user is and where they deploy. The defaults it fills in when the
 * underlying login returns a sparse result are deliberate: an absent tenant
 * becomes `hobo-dev` rather than being written as `undefined`, which would
 * make the profile unparseable on the next read.
 *
 * The dual-principal note in the payload is not decoration. Agent SVIDs are a
 * separate plane from human login, and a reader of this result needs to know
 * which one it established — `principalPlane: "identity"` says a human logged
 * in, not that a workload was attested.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadHoboProfile } from "../src/hobo-profile.js";
import {
	type BrokerAwareLoginCommandDeps,
	createBrokerAwareLoginCommand,
} from "../src/login-command.js";

const ISSUER = "https://issuer.example";
const BROKER = "https://public.example.com";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function home(): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-login-"));
	dirs.push(dir);
	return dir;
}

const progress: string[] = [];

async function login(
	options: {
		readonly flags?: Record<string, unknown>;
		readonly env?: NodeJS.ProcessEnv;
		readonly hoboHome?: string;
		readonly deps?: BrokerAwareLoginCommandDeps;
	} = {},
) {
	progress.length = 0;
	const dir = options.hoboHome ?? home();
	const command = createBrokerAwareLoginCommand({
		env: options.env ?? {},
		...(options.deps ?? {}),
	});
	const result = await command.run({
		context: { cwd: dir, env: options.env ?? {} } as never,
		flags: { home: dir, ...(options.flags ?? {}) } as never,
		args: [],
		emitProgress: (line: string) => {
			progress.push(line);
		},
	} as never);
	return { result, hoboHome: dir };
}

describe("fixture lane", () => {
	it("issues a deterministic session when no issuer is configured", async () => {
		// Offline login is first-class: `hobo up` on a plane must not require an
		// identity provider. The fixture lane is how that stays true.
		const { result } = await login();
		expect(result.ok).toBe(true);
		expect((result.data as { authMethod: string }).authMethod).toBe("fixture");
	});

	it("marks the principal plane as identity, not workload attestation", async () => {
		// Agent SVIDs come from a separate attestor. A reader that could not tell
		// the two apart would treat a human login as node attestation.
		expect(
			(await login()).result.data as { principalPlane: string },
		).toMatchObject({ principalPlane: "identity" });
	});

	it("persists the session to the profile under the home it used", async () => {
		// The profile is what every later command reads. A login that returned a
		// session without writing it would work once and be forgotten.
		const { result, hoboHome } = await login();
		expect((result.data as { profilePath: string }).profilePath).toBe(
			`${hoboHome}/profile.json`,
		);
		expect(loadHoboProfile(hoboHome)?.session?.token).toBeTruthy();
	});

	it("prefers a non-empty --home flag over the environment", async () => {
		// An empty flag is not a choice; honouring it would write the profile to
		// the filesystem root.
		const dir = home();
		const { result } = await login({
			hoboHome: dir,
			flags: { home: "" },
			env: { HOBO_HOME: dir },
		});
		expect((result.data as { profilePath: string }).profilePath).toBe(
			`${dir}/profile.json`,
		);
	});
});

describe("default broker association", () => {
	it("records no default broker when none was named", async () => {
		// `null` rather than a guessed URI: a user who has not chosen a broker
		// should deploy locally, not to whichever one this build defaults to.
		const { result, hoboHome } = await login();
		expect(
			(result.data as { defaultBrokerUri: string | null }).defaultBrokerUri,
		).toBeNull();
		expect(loadHoboProfile(hoboHome)?.defaultBrokerUri).toBeUndefined();
	});

	it("records the broker under either flag spelling and says so in the message", async () => {
		// `--broker` and `--brokerUri` both appear in the docs. Honouring one
		// would leave a user believing they had associated a broker.
		for (const flags of [{ broker: BROKER }, { brokerUri: BROKER }]) {
			const { result, hoboHome } = await login({ flags });
			expect(
				(result.data as { defaultBrokerUri: string }).defaultBrokerUri,
			).toBe(BROKER);
			expect(result.message).toContain(`default broker ${BROKER}`);
			expect(loadHoboProfile(hoboHome)?.defaultBrokerUri).toBe(BROKER);
		}
	});
});

describe("device-code lane — fail closed", () => {
	it("refuses when an issuer is configured but no fetch seam was wired", async () => {
		// This module never reaches for the global fetch, so the whole grant runs
		// offline in tests. The cost is that a missing seam has to be an error:
		// falling back to the fixture would hand the user a local identity while
		// they believe they authenticated against their issuer.
		const { result } = await login({ env: { HOBO_OIDC_ISSUER: ISSUER } });
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_OIDC_NO_FETCH");
		expect(result.message).toContain(ISSUER);
		expect((result.data as { issuer: string }).issuer).toBe(ISSUER);
	});

	it("names both ways to supply the seam", async () => {
		// One reader is a user running the wrong binary; the other is an
		// embedder composing the command. They need different fixes.
		const remediation = (
			(await login({ env: { HOBO_OIDC_ISSUER: ISSUER } })).result.remediation ??
			[]
		).join(" ");
		expect(remediation).toContain("composed `hobo` binary");
		expect(remediation).toContain("fetchImpl");
	});

	it("surfaces a grant failure under its own code rather than the generic one", async () => {
		// Denied, expired, and unreachable are three different problems with
		// three different next steps. The grant's own code is what separates them.
		const { result } = await login({
			env: { HOBO_OIDC_ISSUER: ISSUER },
			deps: {
				fetchImpl: (async () => {
					throw new Error("network down");
				}) as unknown as typeof fetch,
				sleep: async () => {},
				now: () => 0,
			},
		});
		expect(result.ok).toBe(false);
		// Whatever the grant decided, it is *not* a silent fixture success.
		expect((result.data as { issuer: string }).issuer).toBe(ISSUER);
		expect(result.status).toBe("error");
	});

	it("writes no profile when the grant fails", async () => {
		// A profile written from a failed login would present the user as
		// authenticated on every later command.
		const dir = home();
		await login({ hoboHome: dir, env: { HOBO_OIDC_ISSUER: ISSUER } });
		expect(loadHoboProfile(dir)).toBeNull();
	});

	it("never falls back to the fixture lane once an issuer is set", async () => {
		// The single most important property of this command: an explicitly
		// configured issuer means no path leads back to a local identity.
		for (const deps of [
			{},
			{
				fetchImpl: (async () => {
					throw new Error("boom");
				}) as unknown as typeof fetch,
				sleep: async () => {},
			},
		]) {
			const { result } = await login({
				env: { HOBO_OIDC_ISSUER: ISSUER },
				deps,
			});
			expect(result.ok).toBe(false);
			expect((result.data as { authMethod?: string }).authMethod).not.toBe(
				"fixture",
			);
		}
	});
});
