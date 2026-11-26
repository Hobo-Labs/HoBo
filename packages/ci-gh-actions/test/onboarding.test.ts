import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { toJsonString } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	applyOnboarding,
	connectRepository,
	createGithubAppManifest,
	type OnboardingGithubPort,
	OnboardingPlanSchema,
	parseOnboardingPlan,
	prepareOnboarding,
} from "../src/onboarding.js";

const Interaction = z.object({
	description: z.string(),
	request: z.object({
		scope: z.enum(["app", "installation"]),
		method: z.string(),
		path: z.string(),
		body: z.json().optional(),
	}),
	response: z.object({ status: z.number(), body: z.json().optional() }),
});
const corpus = z
	.object({
		metadata: z.object({
			consumerFixtures: z.object({
				principal: z.object({
					accountId: z.string(),
					installationIds: z.array(z.number()),
				}),
				options: z.object({
					principal: z.object({
						accountId: z.string(),
						installationIds: z.array(z.number()),
					}),
					installationId: z.number(),
					repository: z.string(),
					expectedRepositoryId: z.number(),
					relayUrl: z.string(),
					trustedRefs: z.array(z.string()),
					trustedRepositoryAcknowledged: z.boolean(),
					assets: z.object({ workflow: z.string(), bootstrap: z.string() }),
				}),
				plan: z.json(),
			}),
		}),
		interactions: z.array(Interaction),
	})
	.parse(
		JSON.parse(
			readFileSync(
				new URL("../contracts/onboarding-boundary.pact.json", import.meta.url),
				"utf8",
			),
		),
	);
const fixtures = corpus.metadata.consumerFixtures;
const identity = [
	"read authenticated App identity",
	"read App installation permissions",
	"bind repository to selected installation",
	"read installed repository identity",
	"resolve App bot actor identity",
];
const prepare = [
	...identity,
	"read reviewed default head",
	"read reviewed base tree",
];
const mergedFiles = [
	"verify merged .github/workflows/hobo-ci-host.yml",
	"verify merged .hobo-ci/bootstrap.mts",
];
const connect = [
	...identity,
	"find merged installation pull request",
	"read merged default head",
	...mergedFiles,
	...mergedFiles,
];
const existing = [
	"verify exact bridge commit pin",
	"verify acknowledged immutable protection",
	"verify acknowledged immutable protection",
	"verify exact bridge commit pin",
];
function interaction(description: string) {
	const fixture = corpus.interactions.find(
		(item) => item.description === description,
	);
	if (!fixture) throw new Error(`missing fixture: ${description}`);
	return structuredClone(fixture);
}
function port(
	sequence: string[],
	replace = new Map<number, z.infer<typeof Interaction>["response"]>(),
) {
	let count = 0;
	async function send(
		scope: string,
		path: string,
		method: string,
		body?: string,
	) {
		const index = count++;
		const name = sequence[index];
		if (!name) throw new Error("unexpected network request");
		const entry = interaction(name);
		expect({
			scope,
			path,
			method,
			body: body === undefined ? undefined : JSON.parse(body),
		}).toEqual({ ...entry.request, body: entry.request.body });
		const response = replace.get(index) ?? entry.response;
		return new Response(
			response.body === undefined ? null : JSON.stringify(response.body),
			{ status: response.status },
		);
	}
	const github: OnboardingGithubPort = {
		appRequest: (path) => send("app", path, "GET"),
		request: (id, path, method = "GET", body) => {
			expect(id).toBe(5);
			return send("installation", path, method, body);
		},
	};
	return { github, complete: () => expect(count).toBe(sequence.length) };
}
function plan() {
	return parseOnboardingPlan(JSON.stringify(fixtures.plan));
}
function changedResponse(
	description: string,
	body: z.infer<typeof Interaction>["response"]["body"],
) {
	return { ...interaction(description).response, body };
}

describe("repository onboarding authorization and failure boundaries", () => {
	it.each([
		"prepare",
		"apply",
		"connect",
	])("refuses another account installation before %s makes a network request", async (method) => {
		const subject = port([]);
		const foreign = { accountId: "foreign", installationIds: [] };
		const operation =
			method === "prepare"
				? prepareOnboarding(subject.github, {
						...fixtures.options,
						principal: foreign,
					})
				: method === "apply"
					? applyOnboarding(subject.github, foreign, plan())
					: connectRepository(subject.github, foreign, plan());
		await expect(operation).rejects.toThrow("not authorized");
		subject.complete();
	});
	it.each([
		"http://ci.test",
		"https://user:secret@ci.test",
		"https://ci.test/path",
		"https://ci.test/?secret=x",
		"https://ci.test/#fragment",
	])("rejects an unsafe relay origin %s", (relayUrl) => {
		expect(() =>
			createGithubAppManifest({
				name: "HoBo",
				manifestCallbackUrl: "https://ci.test/manifest",
				installationCallbackUrl: "https://ci.test/installed",
				relayUrl,
			}),
		).toThrow("HTTPS origin");
	});
	it.each([
		"https://localhost",
		"https://dev.localhost.",
		"https://127.1",
		"https://0.0.0.0",
		"https://10.1.2.3",
		"https://100.64.0.1",
		"https://169.254.1.1",
		"https://172.31.2.3",
		"https://192.168.2.3",
		"https://[::1]",
		"https://[::]",
		"https://[::ffff:127.0.0.1]",
		"https://[::ffff:10.0.0.1]",
		"https://[fd00::1]",
		"https://[fe80::1]",
	])("rejects unreachable GitHub App webhook origin %s", (relayUrl) => {
		expect(() =>
			createGithubAppManifest({
				name: "HoBo",
				manifestCallbackUrl: "https://ci.test/manifest",
				installationCallbackUrl: "https://ci.test/installed",
				relayUrl,
			}),
		).toThrow("public HTTPS tunnel");
	});
	it.each([
		"manifestCallbackUrl",
		"installationCallbackUrl",
	] as const)("accepts a browser-local GitHub App %s", (field) => {
		const manifest = createGithubAppManifest({
			name: "HoBo",
			relayUrl: "https://ci.test",
			manifestCallbackUrl: "https://ci.test/manifest",
			installationCallbackUrl: "https://ci.test/installed",
			[field]: "https://localhost/callback",
		});
		expect(manifest.hookAttributes?.url).toBe(
			"https://ci.test/github/webhooks",
		);
	});
	it("refuses repository-wide runner trust without acknowledgment before network", async () => {
		const subject = port([]);
		await expect(
			prepareOnboarding(subject.github, {
				...fixtures.options,
				trustedRepositoryAcknowledged: false,
			}),
		).rejects.toThrow("acknowledgment required");
		subject.complete();
	});
	it("requires a server-provided isolated host before preparing an all-PR grant", async () => {
		const subject = port([]);
		await expect(
			prepareOnboarding(subject.github, {
				...fixtures.options,
				allowAllPullRequests: true,
			}),
		).rejects.toThrow("isolated runner required");
		subject.complete();
	});
	it("binds the explicit all-PR grant into the reviewed plan digest", async () => {
		const subject = port(prepare);
		const result = await prepareOnboarding(subject.github, {
			...fixtures.options,
			allowAllPullRequests: true,
			isolatedHostAvailable: true,
		});
		expect(result.allowAllPullRequests).toBe(true);
		expect(result.planDigest).not.toBe(plan().planDigest);
		expect(result.installBranch).not.toBe(plan().installBranch);
		subject.complete();
	});
	it("requires explicit real HTTPS registration callback URLs", () => {
		expect(() =>
			createGithubAppManifest({
				name: "HoBo CI",
				relayUrl: "https://ci.test",
				manifestCallbackUrl: "http://ci.test/manifest",
				installationCallbackUrl: "https://ci.test/installed",
			}),
		).toThrow("callback must be an HTTPS URL");
	});
	it("renders the shipped workflow and bootstrap into reviewable install files", async () => {
		const subject = port(prepare);
		const assets = {
			workflow: readFileSync(
				new URL("../templates/hobo-ci-host.yml", import.meta.url),
				"utf8",
			),
			bootstrap: readFileSync(
				new URL("../src/bootstrap.ts", import.meta.url),
				"utf8",
			),
		};
		const result = await prepareOnboarding(subject.github, {
			...fixtures.options,
			assets,
		});
		expect(result.files[0]?.content).toContain(
			'HOBO_CI_RELAY_URL: "https://ci.hobo.test"',
		);
		expect(result.files[0]?.content).not.toContain("vars.HOBO_CI_RELAY_URL");
		expect(result.files[1]?.content).toBe(assets.bootstrap);
		subject.complete();
	});
	it("uses a different branch identity when reviewed trust policy changes", async () => {
		const subject = port(prepare);
		const result = await prepareOnboarding(subject.github, {
			...fixtures.options,
			trustedRefs: ["refs/heads/release"],
		});
		expect(result.installBranch).not.toBe(plan().installBranch);
		expect(result.planDigest).not.toBe(plan().planDigest);
		subject.complete();
	});
	it("loads the shipped bootstrap in a connected repository with explicit CommonJS packaging", async () => {
		const subject = port(prepare);
		const result = await prepareOnboarding(subject.github, {
			...fixtures.options,
			assets: {
				workflow: readFileSync(
					new URL("../templates/hobo-ci-host.yml", import.meta.url),
					"utf8",
				),
				bootstrap: readFileSync(
					new URL("../src/bootstrap.ts", import.meta.url),
					"utf8",
				),
			},
		});
		const workspace = await mkdtemp(
			join(tmpdir(), "hobo-onboarding-commonjs-"),
		);
		try {
			await writeFile(join(workspace, "package.json"), '{"type":"commonjs"}');
			await mkdir(join(workspace, ".hobo-ci"));
			const bootstrap = result.files[1];
			if (!bootstrap) throw new Error("missing bootstrap artifact");
			const target = join(workspace, bootstrap.path);
			await writeFile(target, bootstrap.content);
			const child = await promisify(execFile)(
				process.execPath,
				[
					"--experimental-strip-types",
					"--input-type=module",
					"--eval",
					`await import(${JSON.stringify(pathToFileURL(target).href)})`,
				],
				{ cwd: workspace, timeout: 5000, env: {} },
			);
			expect(child.stdout).toBe("");
			expect(child.stderr).toBe("");
			expect(result.files[0]?.content).toContain(".hobo-ci/bootstrap.mts");
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
		subject.complete();
	});
	it("rejects a suspended or different App installation", async () => {
		for (const patch of [
			{ app_id: 99 },
			{ suspended_at: "2026-10-27T00:00:00Z" },
		]) {
			const body = z
				.object({
					id: z.number(),
					app_id: z.number(),
					suspended_at: z.string().nullable(),
					permissions: z.record(z.string(), z.string()),
				})
				.parse(interaction(identity[1] ?? "").response.body);
			const subject = port(
				identity.slice(0, 2),
				new Map([
					[1, changedResponse(identity[1] ?? "", { ...body, ...patch })],
				]),
			);
			await expect(
				prepareOnboarding(subject.github, fixtures.options),
			).rejects.toThrow("not active");
			subject.complete();
		}
	});
	it("requires workflow modification permission before creating setup files", async () => {
		const body = z
			.object({
				id: z.number(),
				app_id: z.number(),
				suspended_at: z.string().nullable(),
				permissions: z.record(z.string(), z.string()),
			})
			.parse(interaction(identity[1] ?? "").response.body);
		const subject = port(
			identity.slice(0, 2),
			new Map([
				[
					1,
					changedResponse(identity[1] ?? "", {
						...body,
						permissions: { ...body.permissions, workflows: "read" },
					}),
				],
			]),
		);
		await expect(
			prepareOnboarding(subject.github, fixtures.options),
		).rejects.toThrow("workflows:write");
		subject.complete();
	});
	it("rejects a repository associated with another installation", async () => {
		const subject = port(
			identity.slice(0, 3),
			new Map([[2, changedResponse(identity[2] ?? "", { id: 6, app_id: 17 })]]),
		);
		await expect(
			prepareOnboarding(subject.github, fixtures.options),
		).rejects.toThrow("another GitHub App installation");
		subject.complete();
	});
	it("rejects a renamed or replaced repository identity", async () => {
		const subject = port(identity.slice(0, 4));
		await expect(
			prepareOnboarding(subject.github, {
				...fixtures.options,
				expectedRepositoryId: 99,
			}),
		).rejects.toThrow("identity changed");
		subject.complete();
	});
	it.each([
		[false, false],
		[true, false],
		[false, true],
	])("rejects public onboarding without acknowledgment %s and an isolated host %s", async (acknowledged, isolatedHostAvailable) => {
		const repo = {
			id: 42,
			full_name: "widget/repo",
			private: false,
			default_branch: "main",
		};
		const subject = port(
			identity.slice(0, 4),
			new Map([[3, changedResponse(identity[3] ?? "", repo)]]),
		);
		await expect(
			prepareOnboarding(subject.github, {
				...fixtures.options,
				publicRepoAcknowledged: acknowledged,
				isolatedHostAvailable,
			}),
		).rejects.toThrow(
			"public repositories require acknowledgment and an isolated runner provider",
		);
		subject.complete();
	});
	it("requires the isolated host again when applying or connecting a public setup", async () => {
		const repo = {
			id: 42,
			full_name: "widget/repo",
			private: false,
			default_branch: "main",
		};
		const publicResponse = changedResponse(identity[3] ?? "", repo);
		const subject = port(prepare, new Map([[3, publicResponse]]));
		const publicPlan = await prepareOnboarding(subject.github, {
			...fixtures.options,
			publicRepoAcknowledged: true,
			isolatedHostAvailable: true,
		});
		expect(publicPlan.publicRepoAcknowledged).toBe(true);
		subject.complete();
		for (const phase of ["apply", "connect"] as const) {
			const disabled = port(
				identity.slice(0, 4),
				new Map([[3, publicResponse]]),
			);
			const operation =
				phase === "apply"
					? applyOnboarding(disabled.github, fixtures.principal, publicPlan)
					: connectRepository(disabled.github, fixtures.principal, publicPlan);
			await expect(operation).rejects.toThrow(
				"public repositories require acknowledgment and an isolated runner provider",
			);
			disabled.complete();
			const enabled = port(identity, new Map([[3, publicResponse]]));
			let count = 0;
			const github: OnboardingGithubPort = {
				appRequest: (...args) => {
					count++;
					return enabled.github.appRequest(...args);
				},
				request: (...args) => {
					count++;
					if (count > 5)
						return Promise.resolve(new Response(null, { status: 503 }));
					return enabled.github.request(...args);
				},
			};
			const authorized =
				phase === "apply"
					? applyOnboarding(github, fixtures.principal, publicPlan, true)
					: connectRepository(github, fixtures.principal, publicPlan, true);
			await expect(authorized).rejects.toThrow(
				"GitHub onboarding request failed (503)",
			);
			expect(count).toBe(6);
			enabled.complete();
		}
	});
	it("rejects a private setup that becomes public without a reviewed public acknowledgment", async () => {
		const publicResponse = changedResponse(identity[3] ?? "", {
			id: 42,
			full_name: "widget/repo",
			private: false,
			default_branch: "main",
		});
		for (const phase of ["apply", "connect"] as const) {
			const subject = port(
				identity.slice(0, 4),
				new Map([[3, publicResponse]]),
			);
			const operation =
				phase === "apply"
					? applyOnboarding(subject.github, fixtures.principal, plan(), true)
					: connectRepository(subject.github, fixtures.principal, plan(), true);
			await expect(operation).rejects.toThrow(
				"public repositories require acknowledgment and an isolated runner provider",
			);
			subject.complete();
		}
	});
	it("rejects a bot login mismatch rather than substituting the App ID as actor", async () => {
		const subject = port(
			identity,
			new Map([
				[
					4,
					changedResponse(identity[4] ?? "", {
						id: 17,
						login: "other[bot]",
						type: "Bot",
					}),
				],
			]),
		);
		await expect(
			prepareOnboarding(subject.github, fixtures.options),
		).rejects.toThrow("bot identity");
		subject.complete();
	});
	it("detects plan and file mutation before executing any side effect", async () => {
		const subject = port([]);
		const mutated = structuredClone(plan());
		mutated.repository = "widget/elsewhere";
		await expect(
			applyOnboarding(subject.github, fixtures.principal, mutated),
		).rejects.toThrow("digest mismatch");
		const fileMutation = structuredClone(plan());
		const first = fileMutation.files[0];
		if (!first) throw new Error("fixture missing file");
		first.content += "# injected";
		await expect(
			connectRepository(subject.github, fixtures.principal, fileMutation),
		).rejects.toThrow("artifact digest mismatch");
		subject.complete();
	});
	it("freezes nested file and ref lists and rejects unknown protobuf input fields", () => {
		const parsed = plan();
		const file = parsed.files[0];
		if (!file) throw new Error("missing file");
		expect(() => parsed.files.push(file)).toThrow();
		expect(() => parsed.trustedRefs.push("refs/heads/untrusted")).toThrow();
		const raw = JSON.parse(toJsonString(OnboardingPlanSchema, parsed));
		expect(() =>
			parseOnboardingPlan(JSON.stringify({ ...raw, force: true })),
		).toThrow();
	});
	it("rejects a deterministic installation branch with a different source parent", async () => {
		const commit = z
			.object({
				sha: z.string(),
				tree: z.object({ sha: z.string() }),
				parents: z.array(z.object({ sha: z.string() })),
			})
			.parse(interaction("verify installation parent commit").response.body);
		const sequence = [
			...identity,
			"read deterministic installation branch",
			"verify installation parent commit",
		];
		const subject = port(
			sequence,
			new Map([
				[
					sequence.length - 1,
					changedResponse("verify installation parent commit", {
						...commit,
						parents: [{ sha: "9".repeat(40) }],
					}),
				],
			]),
		);
		await expect(
			applyOnboarding(subject.github, fixtures.principal, plan()),
		).rejects.toThrow("reviewed source parent");
		subject.complete();
	});
	it("does not adopt a retry branch carrying additional unreviewed source changes", async () => {
		const sequence = [
			...identity,
			"read deterministic installation branch",
			"verify installation parent commit",
			"verify only reviewed files changed",
		];
		const subject = port(
			sequence,
			new Map([
				[
					sequence.length - 1,
					changedResponse("verify only reviewed files changed", {
						status: "ahead",
						total_commits: 1,
						files: [{ filename: "unreviewed.ts", status: "added" }],
					}),
				],
			]),
		);
		await expect(
			applyOnboarding(subject.github, fixtures.principal, plan()),
		).rejects.toThrow("outside reviewed files");
		subject.complete();
	});
	it("recovers an ambiguous PR create response by discovering the single existing PR", async () => {
		const sequence = [
			...identity,
			"read deterministic installation branch",
			"verify installation parent commit",
			"verify only reviewed files changed",
			"verify installation .github/workflows/hobo-ci-host.yml",
			"verify installation .hobo-ci/bootstrap.mts",
			"installation pull request absent",
			"create one reviewed installation pull request",
			"find existing installation pull request",
		];
		const subject = port(
			sequence,
			new Map([
				[
					sequence.length - 2,
					{ status: 503, body: { message: "temporary upstream error" } },
				],
			]),
		);
		expect(
			(await applyOnboarding(subject.github, fixtures.principal, plan()))
				.pullRequestNumber,
		).toBe(7);
		subject.complete();
	});
	it("refuses to protect or publish mismatched merged artifacts", async () => {
		const sequence = connect.slice(0, 8);
		const subject = port(
			sequence,
			new Map([
				[
					7,
					changedResponse(mergedFiles[0] ?? "", {
						type: "file",
						encoding: "base64",
						content: Buffer.from("bad").toString("base64"),
						size: 3,
					}),
				],
			]),
		);
		await expect(
			connectRepository(subject.github, fixtures.principal, plan()),
		).rejects.toThrow("reviewed content");
		subject.complete();
	});
	it("rejects malformed base64 at GitHub's content boundary", async () => {
		const sequence = connect.slice(0, 8);
		const subject = port(
			sequence,
			new Map([
				[
					7,
					changedResponse(mergedFiles[0] ?? "", {
						type: "file",
						encoding: "base64",
						content: "!!!",
						size: 3,
					}),
				],
			]),
		);
		await expect(
			connectRepository(subject.github, fixtures.principal, plan()),
		).rejects.toThrow("file encoding");
		subject.complete();
	});
	it("returns the same protected pin on retry without issuing any mutation", async () => {
		const subject = port([...connect, ...existing]);
		const connection = await connectRepository(
			subject.github,
			fixtures.principal,
			plan(),
		);
		expect(connection.bridgeSha).toBe("7".repeat(40));
		subject.complete();
	});
	it("does not mistake protection HTTP success for an acknowledged lock", async () => {
		const sequence = [
			...connect,
			"verify exact bridge commit pin",
			"verify acknowledged immutable protection",
		];
		const subject = port(
			sequence,
			new Map([
				[
					sequence.length - 1,
					changedResponse("verify acknowledged immutable protection", {
						enforce_admins: { enabled: true },
						lock_branch: { enabled: false },
						allow_force_pushes: { enabled: false },
						allow_deletions: { enabled: false },
					}),
				],
			]),
		);
		await expect(
			connectRepository(subject.github, fixtures.principal, plan()),
		).rejects.toThrow();
		subject.complete();
	});
	it("rejects a bridge moved during protection acknowledgment", async () => {
		const sequence = [...connect, ...existing];
		const subject = port(
			sequence,
			new Map([
				[
					sequence.length - 1,
					changedResponse("verify exact bridge commit pin", {
						ref: `refs/heads/${plan().bridgeRef}`,
						object: { type: "commit", sha: "9".repeat(40) },
					}),
				],
			]),
		);
		await expect(
			connectRepository(subject.github, fixtures.principal, plan()),
		).rejects.toThrow("moved while applying protection");
		subject.complete();
	});
});
