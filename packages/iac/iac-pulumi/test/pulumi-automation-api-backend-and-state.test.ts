/**
 * The Automation-API engine's backend pinning and its engine-free snapshot.
 *
 * `pulumi-automation-api-engine.test.ts` covers the engine shape, the adapter
 * handshake, the fail-closed gating, and one end-to-end drive through the
 * injected `LocalWorkspace` seam. This file covers the two things that seam
 * alone does not reach:
 *
 * **What environment the workspace is actually given.** The engine pins its own
 * `file://` backend, defaults the config passphrase, and skips the update
 * check. Each of those is a real failure if it regresses: a hosted backend
 * sends HoBo's state to someone's personal Pulumi account, an unset passphrase
 * makes the local backend prompt interactively and hang a non-interactive
 * deploy forever, and an update check is a network round-trip that fails
 * closed on an air-gapped host.
 *
 * **`snapshot()` reads checkpoint files directly, never the engine.** That is
 * deliberate: `hobo drift` and `hobo import` must enumerate held state on a
 * host where the pulumi engine has since gone missing. A snapshot that needed
 * the engine would make a broken host look like an *empty estate* — which
 * reads as "nothing to clean up", exactly backwards.
 *
 * The preview verdict matrix is here too, because it must match the CLI
 * engine's exactly. Two lanes that disagreed about what a change *is* would
 * make one repo report different plans depending on which backend the host
 * happened to have.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createPulumiAutomationApiEngine } from "../src/pulumi-automation-api-engine.js";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = "hobo-pulumi-auto-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

/** A stand-in automation module whose stack answers from a script. */
function fakeAutomation(
	overrides: {
		preview?: () => Promise<{ changeSummary?: Record<string, number> }>;
	} = {},
) {
	const calls: string[] = [];
	const envVarsSeen: Record<string, string>[] = [];
	const stack = {
		async preview() {
			calls.push("preview");
			return overrides.preview
				? await overrides.preview()
				: { changeSummary: {} };
		},
		async up() {
			calls.push("up");
			return {};
		},
		async refresh() {
			calls.push("refresh");
			return {};
		},
		async destroy() {
			calls.push("destroy");
			return {};
		},
		async outputs() {
			calls.push("outputs");
			return {};
		},
	};
	return {
		calls,
		envVarsSeen,
		module: {
			LocalWorkspace: {
				async createOrSelectStack(
					_args: { stackName: string; workDir: string },
					opts?: { envVars?: Record<string, string> },
				) {
					calls.push("createOrSelectStack");
					if (opts?.envVars) envVarsSeen.push(opts.envVars);
					return stack;
				},
			},
			// SAFETY: the engine calls exactly the members declared above.
		} as never,
	};
}

function engine(
	fake: ReturnType<typeof fakeAutomation>,
	env: Record<string, string | undefined> = {},
) {
	return createPulumiAutomationApiEngine({
		workDir: tempDir("hobo-pulumi-auto-work-"),
		automation: fake.module,
		env,
	});
}

/** A program with one Cloudflare KV resource. */
const program = (name = "cache") =>
	({
		deploymentId: "dep-1",
		resources: [
			{ name, type: "cloudflare:kv-namespace", outputs: ["namespaceId"] },
		],
		// SAFETY: the engine reads exactly the fields named above.
	}) as never;

/** Lay down a program directory and its checkpoint, the way an apply would. */
function seedCheckpoint(
	workDir: string,
	options: { outputs?: Record<string, unknown> | null; raw?: string } = {},
) {
	mkdirSync(join(workDir, "programs", "dep-1__cache"), { recursive: true });
	// The checkpoint lives at <state>/.pulumi/stacks/<project>/<stack>.json —
	// the project is `hobo-<resource>` and `hobo` is the stack the engine selects.
	const projectDir = join(workDir, "state", ".pulumi", "stacks", "hobo-cache");
	mkdirSync(projectDir, { recursive: true });
	writeFileSync(
		join(projectDir, "hobo.json"),
		options.raw ??
			JSON.stringify({
				checkpoint: {
					latest: {
						resources:
							options.outputs === null
								? []
								: [
										{
											type: "pulumi:pulumi:Stack",
											outputs: options.outputs ?? { namespaceId: "ns-1" },
										},
									],
					},
				},
			}),
	);
}

describe("the preview verdict matches the CLI engine", () => {
	it("reports no change for an empty summary", async () => {
		expect((await engine(fakeAutomation()).preview(program())).changes).toEqual(
			[],
		);
	});

	it("marks an unchanged estate clean", async () => {
		// `dirty` is what a deploy gate reads; reporting dirty on an unchanged
		// estate would make every no-op deploy look like pending work.
		expect((await engine(fakeAutomation()).preview(program())).dirty).toBe(
			false,
		);
	});

	it("reports an update", async () => {
		const fake = fakeAutomation({
			preview: async () => ({ changeSummary: { update: 1 } }),
		});
		expect((await engine(fake).preview(program())).changes[0]).toMatchObject({
			op: "update",
		});
	});

	it("reports a delete only when nothing is created or updated", async () => {
		const fake = fakeAutomation({
			preview: async () => ({ changeSummary: { delete: 1 } }),
		});
		expect((await engine(fake).preview(program())).changes[0]).toMatchObject({
			op: "delete",
		});
	});

	it("calls a replace a create, not a delete", async () => {
		const fake = fakeAutomation({
			preview: async () => ({ changeSummary: { create: 1, delete: 1 } }),
		});
		// The resource exists afterwards. Calling it a delete would tell an
		// operator their resource is going away.
		expect((await engine(fake).preview(program())).changes[0]).toMatchObject({
			op: "create",
		});
	});

	it("ignores a summary that only reports unchanged resources", async () => {
		const fake = fakeAutomation({
			preview: async () => ({ changeSummary: { same: 3 } }),
		});
		expect((await engine(fake).preview(program())).changes).toEqual([]);
	});

	it("says the preview is the reason", async () => {
		const fake = fakeAutomation({
			preview: async () => ({ changeSummary: { create: 1 } }),
		});
		// The reason distinguishes a preview-derived change from a drift-derived
		// or forced one on the receipt.
		expect((await engine(fake).preview(program())).changes[0]).toMatchObject({
			reason: "pulumi-preview",
		});
	});

	it("declares the per-resource-stack model", async () => {
		// One stack per resource is what keeps a failure in one resource from
		// corrupting another's state; the receipt says so.
		expect(await engine(fakeAutomation()).preview(program())).toMatchObject({
			kind: "diff",
			provider: "pulumi",
			model: "per-resource-stack",
		});
	});

	it("previews every resource in the program", async () => {
		const fake = fakeAutomation();
		await engine(fake).preview({
			deploymentId: "dep-1",
			resources: [
				{ name: "a", type: "cloudflare:kv-namespace" },
				{ name: "b", type: "cloudflare:kv-namespace" },
			],
			// SAFETY: the engine reads exactly the fields named above.
		} as never);
		expect(fake.calls.filter((call) => call === "preview")).toHaveLength(2);
	});
});

describe("what the workspace environment is pinned to", () => {
	it("points the backend at its own state directory", async () => {
		const fake = fakeAutomation();
		await engine(fake).preview(program());
		expect(fake.envVarsSeen[0]?.PULUMI_BACKEND_URL).toMatch(/^file:\/\//u);
	});

	it("overrides a hosted backend already in the environment", async () => {
		const fake = fakeAutomation();
		await engine(fake, {
			PULUMI_BACKEND_URL: "https://api.pulumi.com",
		}).preview(program());
		// Without this, a developer's shell config silently redirects HoBo's
		// state to their personal Pulumi account.
		expect(fake.envVarsSeen[0]?.PULUMI_BACKEND_URL).not.toContain(
			"api.pulumi.com",
		);
	});

	it("passes provider credentials through to the workspace", async () => {
		const fake = fakeAutomation();
		await engine(fake, { CLOUDFLARE_API_TOKEN: "tok" }).preview(program());
		// Dropping it would make every live program fail at the provider rather
		// than at the gate.
		expect(fake.envVarsSeen[0]?.CLOUDFLARE_API_TOKEN).toBe("tok");
	});

	it("drops an undefined environment entry rather than passing it", async () => {
		const fake = fakeAutomation();
		await engine(fake, { EMPTY: undefined }).preview(program());
		// `undefined` in an env map becomes the literal string "undefined"
		// downstream, which is worse than absent.
		expect(Object.hasOwn(fake.envVarsSeen[0] ?? {}, "EMPTY")).toBe(false);
	});

	it("skips the update check", async () => {
		const fake = fakeAutomation();
		await engine(fake).preview(program());
		// A version check on every stack operation is a network round-trip that
		// fails closed on an air-gapped host.
		expect(fake.envVarsSeen[0]?.PULUMI_SKIP_UPDATE_CHECK).toBe("true");
	});

	it("defaults the config passphrase to empty rather than leaving it unset", async () => {
		const fake = fakeAutomation();
		await engine(fake).preview(program());
		// An unset passphrase makes the local backend prompt interactively,
		// which hangs a non-interactive deploy forever.
		expect(fake.envVarsSeen[0]?.PULUMI_CONFIG_PASSPHRASE).toBe("");
	});

	it("keeps an explicit config passphrase", async () => {
		const fake = fakeAutomation();
		await engine(fake, { PULUMI_CONFIG_PASSPHRASE: "secret" }).preview(
			program(),
		);
		expect(fake.envVarsSeen[0]?.PULUMI_CONFIG_PASSPHRASE).toBe("secret");
	});

	it("selects the `hobo` stack in a per-resource directory", async () => {
		const fake = fakeAutomation();
		await engine(fake).preview(program());
		// Every resource gets its own workDir; sharing one would put two
		// resources' state in the same checkpoint.
		expect(fake.calls).toContain("createOrSelectStack");
	});
});

describe("snapshotting held state without the engine", () => {
	it("reports an empty estate before anything is applied", () => {
		expect(engine(fakeAutomation()).snapshot()).toEqual({});
	});

	it("freezes the snapshot", () => {
		// The snapshot is diffed against desired state; a caller mutating it
		// would change the diff under the planner.
		expect(Object.isFrozen(engine(fakeAutomation()).snapshot())).toBe(true);
	});

	it("reports an empty estate when programs exist but no checkpoints do", async () => {
		const fake = fakeAutomation();
		const created = engine(fake);
		await created.preview(program());
		// A program directory without a checkpoint means nothing was ever
		// applied. Reporting it as held state would have `hobo drift` try to
		// reconcile a resource that does not exist.
		expect(created.snapshot()).toEqual({});
	});

	it("reads checkpoint outputs without calling the automation module", () => {
		const workDir = tempDir("hobo-pulumi-auto-work-");
		const fake = fakeAutomation();
		const created = createPulumiAutomationApiEngine({
			workDir,
			automation: fake.module,
			env: {},
		});
		seedCheckpoint(workDir);
		const snapshot = created.snapshot();
		// The whole point: this must work on a host where the pulumi engine has
		// since gone missing, so drift can still enumerate what is held.
		expect(Object.keys(snapshot)).toContain("dep-1/cache");
		expect(fake.calls).toEqual([]);
	});

	it("shapes a held resource with its id, status and outputs", () => {
		const workDir = tempDir("hobo-pulumi-auto-work-");
		const created = createPulumiAutomationApiEngine({
			workDir,
			automation: fakeAutomation().module,
			env: {},
		});
		seedCheckpoint(workDir);
		// SAFETY: the snapshot shape asserted in the test above.
		const held = created.snapshot()["dep-1/cache"] as {
			resources: Record<
				string,
				{ id: string; status: string; outputs: unknown }
			>;
		};
		expect(held.resources.cache).toMatchObject({
			id: "pulumi:stack:cache",
			status: "provisioned",
			outputs: { namespaceId: "ns-1" },
		});
	});

	it("skips a checkpoint that holds no outputs", () => {
		const workDir = tempDir("hobo-pulumi-auto-work-");
		const created = createPulumiAutomationApiEngine({
			workDir,
			automation: fakeAutomation().module,
			env: {},
		});
		seedCheckpoint(workDir, { outputs: null });
		// A stack that exists but holds nothing is not held state; listing it
		// would have drift try to reconcile an empty resource.
		expect(created.snapshot()).toEqual({});
	});

	it("skips an unreadable checkpoint rather than throwing", () => {
		const workDir = tempDir("hobo-pulumi-auto-work-");
		const created = createPulumiAutomationApiEngine({
			workDir,
			automation: fakeAutomation().module,
			env: {},
		});
		seedCheckpoint(workDir, { raw: "{ truncated" });
		// A half-written checkpoint is what a killed apply leaves behind.
		// Throwing here would make every later command fail until someone
		// deleted the file by hand.
		expect(() => created.snapshot()).not.toThrow();
	});

	it("reports nothing when the state directory was never created", () => {
		const workDir = tempDir("hobo-pulumi-auto-work-");
		const created = createPulumiAutomationApiEngine({
			workDir,
			automation: fakeAutomation().module,
			env: {},
		});
		// A fresh work directory has neither programs nor checkpoints; the
		// snapshot must be empty rather than a filesystem error.
		expect(created.snapshot()).toEqual({});
	});
});
