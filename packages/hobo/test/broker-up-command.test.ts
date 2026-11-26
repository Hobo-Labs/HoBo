/**
 * `hobo up`'s broker-aware composition — the remote lanes.
 *
 * `hobo up` chooses between three quite different deployments from one
 * invocation: a local embedded broker, an anonymous/temporary remote session,
 * and an authenticated remote place. The choice is made by
 * `resolveBrokerTarget` from flags, env, profile, and a local default, and
 * everything downstream — which credential is minted, what the user is told to
 * run next, what lands in `data` — follows from it.
 *
 * Two properties are worth pinning.
 *
 * **Every refusal names the way out, and the ways out differ.** A broker that
 * does not advertise anonymous deploy, a missing principal, an unreachable
 * discovery document, and a missing bindle are four different problems with
 * four different fixes. Collapsing them into one "deploy failed" would leave a
 * user re-running the same command.
 *
 * **The anonymous lane's claim token is the deployment.** A temporary deploy
 * that is never claimed expires; the claim token and its deadline are the only
 * things standing between the user and losing the work. They appear in the
 * result data *and* in the progress stream, because a user who scrolled past
 * the progress line still needs them, and a script reading `data` should not
 * have to parse prose.
 *
 * The local lane is deliberately not exercised here: it installs a Yard,
 * starts an embedded broker, and binds a port. It has its own tests; this file
 * stays hermetic.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	BrokerDiscoveryError,
	createBrokerDiscoveryClient,
} from "../src/broker-discovery.js";
import { RemoteBrokerClientError } from "../src/broker-remote-client.js";
import {
	type BrokerAwareUpCommandDeps,
	createBrokerAwareUpCommand,
	createBrokerAwareUpCommandWithMock,
} from "../src/broker-up-command.js";
import type { PresentedCredential } from "../src/credential-presenter.js";

const BROKER = "https://public.example.com";

const dirs: string[] = [];

afterEach(() => {
	dirs.splice(0);
});

/** A project the bindle loader can actually import — it executes the module. */
async function projectWithBindle(name = "app"): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "hobo-up-"));
	dirs.push(dir);
	await mkdir(path.join(dir, "src"), { recursive: true });
	await writeFile(
		path.join(dir, "src", "bindle.mjs"),
		[
			"export default {",
			`  name: ${JSON.stringify(name)},`,
			"  resources: {",
			"    site: {",
			'      kind: "web",',
			'      name: "site",',
			'      stableId: "web:site",',
			"      declaredAllow: [],",
			"      annotations: [],",
			"      dependsOn: [],",
			"    },",
			"  },",
			"  edges: [],",
			"  requirements: { require: [], prefer: [], runtimes: [], labels: {} },",
			"  entrypoint: () => undefined,",
			"};",
			"",
		].join("\n"),
	);
	return dir;
}

/** An empty project — no bindle module for the loader to find. */
async function projectWithoutBindle(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "hobo-up-empty-"));
	dirs.push(dir);
	return dir;
}

const progressLines: string[] = [];

/** Invoke the command against a remote broker, collecting progress lines. */
async function up(
	command: ReturnType<typeof createBrokerAwareUpCommand>,
	options: {
		readonly projectDir: string;
		readonly flags?: Record<string, unknown>;
		readonly env?: NodeJS.ProcessEnv;
	},
) {
	progressLines.length = 0;
	return command.run({
		context: {
			cwd: options.projectDir,
			projectDir: options.projectDir,
			env: options.env ?? {},
		},
		flags: { broker: BROKER, ...(options.flags ?? {}) },
		args: [],
		emitProgress: (line: string) => {
			progressLines.push(line);
		},
	} as never);
}

/** The mock-backed command, which serves discovery and place in process. */
function mocked(supportsAnonymous = true) {
	return createBrokerAwareUpCommandWithMock({
		supportsAnonymous,
		brokerUri: BROKER,
	}).command;
}

/** A presenter that answers exactly what a test needs, and nothing more. */
function presenterReturning(
	credential: PresentedCredential | null,
): NonNullable<BrokerAwareUpCommandDeps["presenter"]> {
	return {
		presentAuthenticated: async () => credential,
		presentAnonymous: (input) => ({
			scheme: "anonymous",
			principal: input.ephemeralPrincipal,
			tenant: input.tenant ?? "temporary",
			accessToken: input.accessToken,
			audience: input.audience,
			expiresAt: input.expiresAt,
		}),
	} as NonNullable<BrokerAwareUpCommandDeps["presenter"]>;
}

const AUTHED: PresentedCredential = {
	scheme: "svid",
	principal: { kind: "agent", id: "agent:test" },
	tenant: "acme",
	accessToken: "token",
	audience: BROKER,
	expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};

describe("target resolution", () => {
	it("stays local when no broker is named anywhere", async () => {
		// Local is the zero-config default, and it must not be reachable by
		// accident from a remote invocation: the two lanes mint different
		// credentials and place through different code entirely.
		const result = await up(mocked(), {
			projectDir: await projectWithoutBindle(),
			flags: { broker: undefined },
		});
		// No bindle, so the local lane refuses before touching a Yard — which is
		// exactly the evidence that it took the local branch.
		expect(result.code).toBe("HOBO_UP_NO_BINDLE");
		expect((result.data as { mode?: string }).mode).toBe("local");
	});

	it("announces the remote target, its mode, and where it came from", async () => {
		// Which broker a deploy went to, and *why* that broker, is the first
		// question when a deploy lands somewhere unexpected. A user with a stale
		// HOBO_BROKER export and a --broker flag needs to see which one won.
		await up(mocked(), {
			projectDir: await projectWithBindle(),
			flags: { anonymous: true },
		});
		const announced = progressLines.find((line) =>
			line.includes("remote broker"),
		);
		expect(announced).toBeDefined();
		expect(announced).toContain(BROKER);
		expect(announced).toContain("mode=");
		expect(announced).toContain("source=");
	});
});

describe("missing bindle", () => {
	it("refuses a remote deploy and names the directory it searched", async () => {
		// "no loadable bindle" without the path is unactionable — the most common
		// cause is running from the repo root rather than the project.
		const dir = await projectWithoutBindle();
		const result = await up(mocked(), {
			projectDir: dir,
			flags: { anonymous: true },
		});
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_UP_NO_BINDLE");
		expect(result.message).toContain(dir);
		expect((result.data as { projectDir: string }).projectDir).toBe(dir);
	});

	it("points at the two loadable shapes and a worked example", async () => {
		const result = await up(mocked(), {
			projectDir: await projectWithoutBindle(),
			flags: { anonymous: true },
		});
		const remediation = (result.remediation ?? []).join(" ");
		expect(remediation).toContain("src/bindle.ts");
		expect(remediation).toContain("examples/hello-bindle");
	});
});

describe("discovery", () => {
	it("surfaces a discovery failure under the discovery error's own code", async () => {
		// The broker's own code says *how* discovery failed — unreachable, wrong
		// content type, malformed document. Rewriting it to a generic up-failed
		// code would discard the only signal that distinguishes a typo in the URI
		// from a broker that is up but misconfigured.
		const command = createBrokerAwareUpCommand({
			createRemoteClient: () =>
				({
					discover: async () => {
						throw new BrokerDiscoveryError(
							"broker unreachable",
							"HOBO_BROKER_DISCOVERY_FAILED",
						);
					},
				}) as never,
		});
		const result = await up(command, {
			projectDir: await projectWithBindle(),
			flags: { anonymous: true },
		});
		expect(result.ok).toBe(false);
		expect(result.status).toBe("discovery_failed");
		expect(result.code).toBe("HOBO_BROKER_DISCOVERY_FAILED");
		expect(result.message).toContain("broker unreachable");
	});

	it("offers the local fallback and login alongside the URI check", async () => {
		// Three different causes, three different fixes: a wrong URI, a broker
		// that needs auth, and a user who does not need a broker at all.
		const command = createBrokerAwareUpCommand({
			createRemoteClient: () =>
				({
					discover: async () => {
						throw new BrokerDiscoveryError("nope", "HOBO_BROKER_UNREACHABLE");
					},
				}) as never,
		});
		const result = await up(command, {
			projectDir: await projectWithBindle(),
			flags: { anonymous: true },
		});
		const remediation = (result.remediation ?? []).join(" ");
		expect(remediation).toContain("/.well-known/hobo-broker");
		expect(remediation).toContain("hobo login --broker");
		expect(remediation).toContain("without --broker");
	});

	it("lets a non-discovery throw fall through to the outer handler", async () => {
		// Only `BrokerDiscoveryError` describes a discovery problem. Catching
		// everything here would report an unrelated bug as "the broker is
		// unreachable" and send the user to check DNS.
		const command = createBrokerAwareUpCommand({
			createRemoteClient: () =>
				({
					discover: async () => {
						throw new TypeError("client is broken");
					},
				}) as never,
		});
		const result = await up(command, {
			projectDir: await projectWithBindle(),
			flags: { anonymous: true },
		});
		expect(result.code).toBe("HOBO_UP_FAILED");
		expect(result.message).toContain("client is broken");
	});
});

describe("anonymous lane", () => {
	it("refuses when the broker does not advertise anonymous deploy", async () => {
		// Discovery is the authority here, not the flag. Attempting the session
		// anyway would fail deeper in, with a transport error instead of a
		// sentence naming the broker that declined.
		const result = await up(mocked(false), {
			projectDir: await projectWithBindle(),
			flags: { anonymous: true },
		});
		expect(result.ok).toBe(false);
		expect(result.status).toBe("anonymous_not_supported");
		expect(result.code).toBe("HOBO_ANON_NOT_SUPPORTED");
		expect(
			(result.data as { supportsAnonymous: boolean }).supportsAnonymous,
		).toBe(false);
	});

	it("reports the auth methods the broker does advertise", async () => {
		// A user told only "not supported" has no next move. The advertised
		// methods are what turns the refusal into `hobo login`.
		const result = await up(mocked(false), {
			projectDir: await projectWithBindle(),
			flags: { temporary: true },
		});
		const methods = (result.data as { authMethods: readonly string[] })
			.authMethods;
		expect(Array.isArray(methods)).toBe(true);
		expect(methods).not.toContain("anonymous");
		expect((result.remediation ?? []).join(" ")).toContain(
			"hobo login --broker",
		);
	});

	it("deploys and returns the claim token with its deadline", async () => {
		// An unclaimed temporary deployment expires. The token and the expiry are
		// the whole product of this lane — a success that omitted either would be
		// a deployment the user cannot keep.
		const result = await up(mocked(), {
			projectDir: await projectWithBindle("temp-app"),
			flags: { anonymous: true },
		});
		expect(result.ok).toBe(true);
		expect(result.status).toBe("deployed_anonymous");
		const data = result.data as {
			claimToken: string;
			expiresAt: string;
			primaryUrl: string;
			mode: string;
		};
		expect(data.mode).toBe("anonymous");
		expect(data.claimToken).toBeTruthy();
		expect(data.expiresAt).toBeTruthy();
		expect(data.primaryUrl).toContain("http");
	});

	it("prints a ready-to-paste claim command, not a description of one", async () => {
		// The claim needs the broker URI *and* the token. A user reconstructing
		// that line by hand at the moment their deployment is expiring is the
		// failure this exists to avoid.
		const result = await up(mocked(), {
			projectDir: await projectWithBindle(),
			flags: { temporary: true },
		});
		const hint = (result.data as { claimHint: string }).claimHint;
		expect(hint).toContain("hobo claim");
		expect(hint).toContain(`--broker ${BROKER}`);
		expect(hint).toContain("--token");
		// And the same line reaches anyone watching the stream.
		expect(progressLines.some((line) => line.includes(hint))).toBe(true);
	});

	it("treats --temporary as --anonymous", async () => {
		// Two spellings of one intent. A user who reached for the friendlier word
		// should not get an authenticated deploy attempt and a login prompt.
		const result = await up(mocked(), {
			projectDir: await projectWithBindle(),
			flags: { temporary: true },
		});
		expect(result.status).toBe("deployed_anonymous");
	});

	it("carries the ephemeral principal through as the credential's own", async () => {
		// The anonymous principal is ephemeral by construction. Reporting a
		// stable identity for it would make the deployment look owned when it is
		// not yet claimed by anyone.
		const result = await up(mocked(), {
			projectDir: await projectWithBindle(),
			flags: { anonymous: true },
		});
		const data = result.data as {
			principalKind: string;
			credentialScheme: string;
		};
		expect(data.principalKind).toBeTruthy();
		expect(data.credentialScheme).toBeTruthy();
	});
});

describe("authenticated lane", () => {
	it("refuses without a principal rather than deploying anonymously", async () => {
		// Silently downgrading an authenticated deploy to an anonymous one would
		// place the user's work under a temporary owner that expires — the exact
		// opposite of what asking for authentication means.
		const { mock } = createBrokerAwareUpCommandWithMock({ brokerUri: BROKER });
		const command = createBrokerAwareUpCommand({
			mockRemote: mock,
			discovery: createBrokerDiscoveryClient({
				fixed: new Map([[BROKER, mock.discovery]]),
			}),
			presenter: presenterReturning(null),
		});
		const result = await up(command, {
			projectDir: await projectWithBindle(),
		});
		expect(result.ok).toBe(false);
		expect(result.status).toBe("no_principal");
		expect(result.code).toBe("HOBO_UP_NO_PRINCIPAL");
	});

	it("names all four ways to get a principal", async () => {
		// Human login, workload SVID, opt-in anonymous, and local — four
		// different users, four different fixes. A message naming only `hobo
		// login` strands the agent running in CI with no browser.
		const { mock } = createBrokerAwareUpCommandWithMock({ brokerUri: BROKER });
		const command = createBrokerAwareUpCommand({
			mockRemote: mock,
			discovery: createBrokerDiscoveryClient({
				fixed: new Map([[BROKER, mock.discovery]]),
			}),
			presenter: presenterReturning(null),
		});
		const remediation = (
			(await up(command, { projectDir: await projectWithBindle() }))
				.remediation ?? []
		).join(" ");
		expect(remediation).toContain("hobo login --broker");
		expect(remediation).toContain("HOBO_AGENT_SVID");
		expect(remediation).toContain("--anonymous");
		expect(remediation).toContain("no --broker");
	});

	it("places under the resolved principal and says so", async () => {
		const { mock } = createBrokerAwareUpCommandWithMock({ brokerUri: BROKER });
		const command = createBrokerAwareUpCommand({
			mockRemote: mock,
			discovery: createBrokerDiscoveryClient({
				fixed: new Map([[BROKER, mock.discovery]]),
			}),
			presenter: presenterReturning(AUTHED),
		});
		const result = await up(command, {
			projectDir: await projectWithBindle("owned-app"),
		});
		expect(result.ok).toBe(true);
		expect(result.status).toBe("deployed");
		const data = result.data as { mode: string; principalKind: string };
		expect(data.mode).toBe("auth");
		expect(data.principalKind).toBe("agent");
		expect(result.message).toContain("agent:test");
	});

	it("reports a single principal as not dual", async () => {
		// `dualPrincipal` is how a reader tells "an agent acted alone" from "an
		// agent acted for a human". Defaulting it to true would attribute
		// unattended automation to whoever last logged in.
		const { mock } = createBrokerAwareUpCommandWithMock({ brokerUri: BROKER });
		const command = createBrokerAwareUpCommand({
			mockRemote: mock,
			discovery: createBrokerDiscoveryClient({
				fixed: new Map([[BROKER, mock.discovery]]),
			}),
			presenter: presenterReturning(AUTHED),
		});
		const data = (await up(command, { projectDir: await projectWithBindle() }))
			.data as { dualPrincipal: boolean; humanPrincipal?: unknown };
		expect(data.dualPrincipal).toBe(false);
		expect(data.humanPrincipal).toBeUndefined();
	});

	it("keeps the human principal beside the agent when one is present", async () => {
		// An agent acting on a human's behalf is two identities, and collapsing
		// them into one would make the audit trail unable to answer "who asked
		// for this?" separately from "what carried it out?".
		const { mock } = createBrokerAwareUpCommandWithMock({ brokerUri: BROKER });
		const command = createBrokerAwareUpCommand({
			mockRemote: mock,
			discovery: createBrokerDiscoveryClient({
				fixed: new Map([[BROKER, mock.discovery]]),
			}),
			presenter: presenterReturning({
				...AUTHED,
				humanPrincipal: { kind: "user", id: "user:ada" },
			}),
		});
		const data = (await up(command, { projectDir: await projectWithBindle() }))
			.data as {
			dualPrincipal: boolean;
			humanPrincipal: { id: string };
			humanPrincipalKind: string;
		};
		expect(data.dualPrincipal).toBe(true);
		expect(data.humanPrincipal.id).toBe("user:ada");
		expect(data.humanPrincipalKind).toBe("user");
	});
});

describe("failure handling", () => {
	it("surfaces a remote client error under its own code", async () => {
		// The broker's rejection reason — quota, unknown camp, bad credential —
		// is the actionable part. Flattening it to HOBO_UP_FAILED would leave the
		// user re-running an invocation the broker will keep refusing.
		const command = createBrokerAwareUpCommand({
			createRemoteClient: () =>
				({
					discover: async () => ({
						brokerId: "b",
						issuer: BROKER,
						supportsAnonymous: true,
						authMethods: ["anonymous"],
					}),
					createAnonymousSession: async () => {
						throw new RemoteBrokerClientError(
							"quota exhausted",
							"HOBO_BROKER_QUOTA",
							{ retryAfter: 60 },
						);
					},
				}) as never,
		});
		const result = await up(command, {
			projectDir: await projectWithBindle(),
			flags: { anonymous: true },
		});
		expect(result.ok).toBe(false);
		expect(result.status).toBe("remote_error");
		expect(result.code).toBe("HOBO_BROKER_QUOTA");
		expect((result.data as { retryAfter: number }).retryAfter).toBe(60);
	});

	it("still reports the home and project on an unexpected failure", async () => {
		// The catch-all is where a bug lands. Even there the result names which
		// project and which install root were in play, because without them a
		// bug report is a message with no context to reproduce from.
		const command = createBrokerAwareUpCommand({
			createRemoteClient: () =>
				({
					discover: async () => {
						throw new RangeError("boom");
					},
				}) as never,
		});
		const dir = await projectWithBindle();
		const result = await up(command, {
			projectDir: dir,
			flags: { anonymous: true, home: "/tmp/hobo-up-home" },
		});
		expect(result.code).toBe("HOBO_UP_FAILED");
		const data = result.data as { projectDir: string; hoboHome: string };
		expect(data.projectDir).toBe(dir);
		expect(data.hoboHome).toBe("/tmp/hobo-up-home");
	});

	it("stringifies a non-Error throw rather than losing it", async () => {
		// A thrown string carries the only description of what went wrong.
		// `String(error)` on a non-Error is the difference between a diagnosable
		// failure and "[object Object]".
		const command = createBrokerAwareUpCommand({
			createRemoteClient: () =>
				({
					discover: async () => {
						throw "plain string failure";
					},
				}) as never,
		});
		const result = await up(command, {
			projectDir: await projectWithBindle(),
			flags: { anonymous: true },
		});
		expect(result.message).toContain("plain string failure");
		expect((result.data as { error: string }).error).toBe(
			"plain string failure",
		);
	});
});

describe("install root resolution", () => {
	it("prefers a non-empty --home flag over the environment", async () => {
		// An empty string is not a choice — treating it as one would send every
		// install into the filesystem root.
		const command = createBrokerAwareUpCommand({
			env: { HOBO_HOME: "/tmp/from-env" },
			createRemoteClient: () =>
				({
					discover: async () => {
						throw new Error("stop here");
					},
				}) as never,
		});
		const flagged = await up(command, {
			projectDir: await projectWithBindle(),
			flags: { anonymous: true, home: "/tmp/from-flag" },
		});
		expect((flagged.data as { hoboHome: string }).hoboHome).toBe(
			"/tmp/from-flag",
		);

		const empty = await up(command, {
			projectDir: await projectWithBindle(),
			flags: { anonymous: true, home: "" },
		});
		expect((empty.data as { hoboHome: string }).hoboHome).not.toBe("");
	});
});
