import { readFileSync } from "node:fs";
import { create } from "@bufbuild/protobuf";
import {
	DEFAULT_RUNNER_ORDER,
	decideRunnerRoute,
	machineCandidate,
	NO_ROUTE_FACTS,
	RunnerRouteRequestSchema,
} from "@hobo/ci";
import {
	InMemoryMachineRegistry,
	testRouteRequest,
} from "@hobo/ci/runner-order/testing";
import { describe, expect, it } from "vitest";
import {
	ADOPTED_RUNNER_SIGNER,
	adoptionLabel,
	adoptRunner,
	isAdoptionLabel,
	listAdoptableRunners,
	RunnerAdoptionError,
	type RunnerAdoptionGithub,
	type RunnerLabelsBody,
	releaseRunner,
	runnerAdopter,
} from "../src/runner-adoption.js";

type FakeRunner = {
	id: number;
	name: string;
	os: string;
	status: "online" | "offline";
	busy: boolean;
	labels: string[];
	groupId?: number;
};

/**
 * GitHub's runner endpoints in memory: one repository, its organization's
 * runners and groups. Every request is recorded.
 */
class FakeGithubRunners implements RunnerAdoptionGithub {
	readonly requests: string[] = [];
	privateRepository = true;
	ownerType = "Organization";
	orgForbidden = false;
	readonly repoRunners: FakeRunner[] = [
		{
			id: 11,
			name: "build-box",
			os: "Linux",
			status: "online",
			busy: true,
			labels: ["self-hosted", "Linux", "X64", "gpu"],
		},
	];
	readonly orgRunners: FakeRunner[] = [
		{
			id: 21,
			name: "mac-mini",
			os: "macOS",
			status: "offline",
			busy: false,
			labels: ["self-hosted", "macOS", "ARM64"],
			groupId: 1,
		},
		{
			id: 22,
			name: "secret-team",
			os: "Linux",
			status: "online",
			busy: false,
			labels: ["self-hosted", "Linux", "X64"],
			groupId: 7,
		},
	];
	/** The groups `app` may use. */
	readonly visibleGroups = [1];

	private runnersOf(path: string): FakeRunner[] | undefined {
		if (path.startsWith("/repos/octo/app/actions/runners"))
			return this.repoRunners;
		if (path.startsWith("/orgs/octo/actions/runners")) return this.orgRunners;
		return undefined;
	}

	private shown(runner: FakeRunner) {
		return {
			id: runner.id,
			name: runner.name,
			os: runner.os,
			status: runner.status,
			busy: runner.busy,
			ephemeral: false,
			runner_group_id: runner.groupId ?? 1,
			labels: runner.labels.map((name, index) => ({
				id: index + 1,
				name,
				type: index < 3 ? "read-only" : "custom",
			})),
		};
	}

	async request(
		method: "GET" | "POST" | "DELETE",
		path: string,
		body: RunnerLabelsBody | undefined,
	): Promise<Response> {
		this.requests.push(`${method} ${path}`);
		if (method === "GET" && path === "/user")
			return Response.json({ id: 42, login: "octocat" });
		if (method === "GET" && path === "/repos/octo/app")
			return Response.json({
				private: this.privateRepository,
				owner: { login: "octo", type: this.ownerType },
			});
		if (path.startsWith("/orgs/") && this.orgForbidden)
			return Response.json(
				{ message: "Must have admin rights" },
				{ status: 403 },
			);
		if (
			method === "GET" &&
			path ===
				"/orgs/octo/actions/runner-groups?visible_to_repository=app&per_page=100"
		)
			return Response.json({
				total_count: this.visibleGroups.length,
				runner_groups: this.visibleGroups.map((id) => ({
					id,
					name: `group-${id}`,
					visibility: "selected",
				})),
			});
		const runners = this.runnersOf(path);
		if (!runners) return notFound();
		if (method === "GET" && path.endsWith("/runners?per_page=100&page=1"))
			return Response.json({
				total_count: runners.length,
				runners: runners.map((runner) => this.shown(runner)),
			});
		const match = /\/runners\/(\d+)\/labels(?:\/([^/]+))?$/u.exec(path);
		const runner = runners.find((each) => each.id === Number(match?.[1]));
		if (!match || !runner) return notFound();
		if (method === "POST" && body) {
			for (const label of body.labels)
				if (!runner.labels.includes(label)) runner.labels.push(label);
		} else if (method === "DELETE" && match[2]) {
			const at = runner.labels.indexOf(match[2]);
			if (at < 0) return notFound();
			runner.labels.splice(at, 1);
		} else return notFound();
		return Response.json({
			total_count: runner.labels.length,
			labels: this.shown(runner).labels,
		});
	}
}

function notFound(): Response {
	return Response.json({ message: "Not Found" }, { status: 404 });
}

const adopter = { id: "42", login: "octocat" };
const adoptInput = (runnerId: number) => ({
	repository: "octo/app",
	runnerId,
	accountId: "acct-1",
	adopter,
	sharing: undefined,
	nowMs: 1_700_000_000_000,
});

describe("listAdoptableRunners", () => {
	it("offers the repository's runners and the organization runners its groups admit", async () => {
		const github = new FakeGithubRunners();
		const listing = await listAdoptableRunners(github, "octo/app");
		expect(listing.runners.map((runner) => runner.id)).toEqual([11, 21]);
		expect(listing.runners[0]).toMatchObject({
			scope: "repository",
			registeredOn: "octo/app",
			adoptedLabel: undefined,
		});
		expect(listing.runners[1]).toMatchObject({
			scope: "organization",
			registeredOn: "octo",
			groupId: 1,
		});
		expect(listing.leftOut.map((runner) => runner.id)).toEqual([22]);
		expect(listing.warnings).toEqual([]);
	});

	it("offers a public repository nothing", async () => {
		const github = new FakeGithubRunners();
		github.privateRepository = false;
		await expect(
			listAdoptableRunners(github, "octo/app"),
		).rejects.toMatchObject({ problem: "public_repository" });
		expect(github.requests).toEqual(["GET /repos/octo/app"]);
	});

	it("reads no organization for a personal repository", async () => {
		const github = new FakeGithubRunners();
		github.ownerType = "User";
		const listing = await listAdoptableRunners(github, "octo/app");
		expect(listing.runners.map((runner) => runner.id)).toEqual([11]);
		expect(github.requests.some((line) => line.includes("/orgs/"))).toBe(false);
	});

	it("keeps the repository's runners with a warning when the organization cannot be read", async () => {
		const github = new FakeGithubRunners();
		github.orgForbidden = true;
		const listing = await listAdoptableRunners(github, "octo/app");
		expect(listing.runners.map((runner) => runner.id)).toEqual([11]);
		expect(listing.warnings[0]).toContain("organization administrator");
	});

	it("refuses a name that is not owner/name before asking GitHub", async () => {
		const github = new FakeGithubRunners();
		await expect(
			listAdoptableRunners(github, "../octo"),
		).rejects.toBeInstanceOf(RunnerAdoptionError);
		expect(github.requests).toEqual([]);
	});
});

describe("adoptRunner", () => {
	it("adds one hobo-runner label and returns a host-isolated one-slot advert", async () => {
		const github = new FakeGithubRunners();
		const adoption = await adoptRunner(github, adoptInput(11));
		expect(adoption.changed).toBe(true);
		expect(isAdoptionLabel(adoption.label)).toBe(true);
		expect(adoption.label).toBe(adoptionLabel("repository", "octo/app", 11));
		expect(github.repoRunners[0]?.labels).toContain(adoption.label);
		expect(adoption.advert).toMatchObject({
			id: "github-runner-11",
			accountId: "acct-1",
			name: "build-box",
			runsOn: adoption.label,
			os: "linux",
			arch: "x64",
			slots: 1,
			busy: 1,
			paused: false,
			sharing: "only_me",
			ownerId: "42",
			ownerLogin: "octocat",
			repository: "octo/app",
			lastSeenMs: 1_700_000_000_000,
			signerKeyId: ADOPTED_RUNNER_SIGNER,
			isolation: "host",
		});
		expect(adoption.advert.labels).toEqual([
			"self-hosted",
			"Linux",
			"X64",
			"gpu",
			adoption.label,
		]);
		expect(Object.isFrozen(adoption.advert)).toBe(true);
	});

	it("is safe to repeat: a second adopt writes nothing and returns the same label", async () => {
		const github = new FakeGithubRunners();
		const first = await adoptRunner(github, adoptInput(11));
		const writes = github.requests.filter((line) => line.startsWith("POST"));
		const second = await adoptRunner(github, adoptInput(11));
		expect(second.changed).toBe(false);
		expect(second.label).toBe(first.label);
		expect(github.requests.filter((line) => line.startsWith("POST"))).toEqual(
			writes,
		);
	});

	it("adopts an organization runner through the organization's labels call", async () => {
		const github = new FakeGithubRunners();
		const adoption = await adoptRunner(github, {
			...adoptInput(21),
			sharing: "anyone",
		});
		expect(github.requests).toContain(
			"POST /orgs/octo/actions/runners/21/labels",
		);
		expect(adoption.advert).toMatchObject({
			os: "macos",
			arch: "arm64",
			busy: 0,
			sharing: "anyone",
			repository: "",
			// Offline: no freshness window counts it online.
			lastSeenMs: 1,
		});
	});

	it("does not offer a runner whose group leaves the repository out", async () => {
		const github = new FakeGithubRunners();
		await expect(adoptRunner(github, adoptInput(22))).rejects.toMatchObject({
			problem: "not_offered",
		});
		expect(github.orgRunners[1]?.labels.some(isAdoptionLabel)).toBe(false);
	});

	it("refuses an unknown runner", async () => {
		const github = new FakeGithubRunners();
		await expect(adoptRunner(github, adoptInput(99))).rejects.toMatchObject({
			problem: "not_found",
		});
	});

	it("refuses a runner it cannot advertise before writing a label", async () => {
		const github = new FakeGithubRunners();
		const runner = github.repoRunners[0];
		if (runner) runner.labels = ["self-hosted", "Linux"];
		await expect(adoptRunner(github, adoptInput(11))).rejects.toMatchObject({
			problem: "unsupported_runner",
		});
		expect(github.requests.some((line) => line.startsWith("POST"))).toBe(false);
	});
});

describe("releaseRunner", () => {
	it("takes the hobo-runner label off and is safe to repeat", async () => {
		const github = new FakeGithubRunners();
		const { label } = await adoptRunner(github, adoptInput(11));
		const released = await releaseRunner(github, {
			repository: "octo/app",
			runnerId: 11,
		});
		expect(released.removed).toEqual([label]);
		expect(released.runner.adoptedLabel).toBeUndefined();
		expect(github.repoRunners[0]?.labels).toEqual([
			"self-hosted",
			"Linux",
			"X64",
			"gpu",
		]);
		const again = await releaseRunner(github, {
			repository: "octo/app",
			runnerId: 11,
		});
		expect(again.removed).toEqual([]);
	});

	it("releases a runner whose group no longer admits the repository", async () => {
		const github = new FakeGithubRunners();
		await adoptRunner(github, adoptInput(21));
		github.visibleGroups.splice(0);
		const released = await releaseRunner(github, {
			repository: "octo/app",
			runnerId: 21,
		});
		expect(released.removed).toHaveLength(1);
		expect(github.orgRunners[0]?.labels.some(isAdoptionLabel)).toBe(false);
	});
});

describe("runnerAdopter", () => {
	it("reads the signed-in user as the owner", async () => {
		expect(await runnerAdopter(new FakeGithubRunners())).toEqual(adopter);
	});
});

describe("M10: an existing runner is adopted with no change on its machine", () => {
	it("routes the next relay job to the adopted runner's label", async () => {
		const github = new FakeGithubRunners();
		const { advert, label } = await adoptRunner(github, adoptInput(11));
		const registry = new InMemoryMachineRegistry();
		await registry.put(advert);
		const machines = (await registry.list("acct-1")).map((each) =>
			machineCandidate(each, { online: true, ownerCanRead: true }),
		);
		const request = create(RunnerRouteRequestSchema, {
			...testRouteRequest("octo/app"),
			inputs: [{ key: "machine", labels: [label] }],
			actorId: "42",
			triggeringActorId: "42",
		});
		// The runner is busy on GitHub when adopted; once its job ends it has room.
		const free = machines.map((machine) => ({ ...machine, busy: 0 }));
		const decision = decideRunnerRoute(DEFAULT_RUNNER_ORDER, request, {
			...NO_ROUTE_FACTS,
			machines: free,
		});
		expect(decision.outcome).toBe("routed");
		expect(decision.runner).toBe(label);
		expect(decision.machineId).toBe("github-runner-11");
	});

	it("asks GitHub only for runner lists, groups and labels: nothing reaches the machine", async () => {
		const github = new FakeGithubRunners();
		await listAdoptableRunners(github, "octo/app");
		await adoptRunner(github, adoptInput(11));
		await adoptRunner(github, adoptInput(21));
		await releaseRunner(github, { repository: "octo/app", runnerId: 11 });
		await runnerAdopter(github);
		const allowed = [
			/^GET \/user$/u,
			/^GET \/repos\/octo\/app$/u,
			/^GET \/(?:repos\/octo\/app|orgs\/octo)\/actions\/runners\?per_page=100&page=\d+$/u,
			/^GET \/orgs\/octo\/actions\/runner-groups\?visible_to_repository=app&per_page=100$/u,
			/^POST \/(?:repos\/octo\/app|orgs\/octo)\/actions\/runners\/\d+\/labels$/u,
			/^DELETE \/(?:repos\/octo\/app|orgs\/octo)\/actions\/runners\/\d+\/labels\/hobo-runner-[0-9a-f]{8}$/u,
		];
		for (const line of github.requests)
			expect(
				allowed.some((pattern) => pattern.test(line)),
				line,
			).toBe(true);
	});

	it("imports nothing that could start a process or reach a machine", () => {
		const source = readFileSync(
			new URL("../src/runner-adoption.ts", import.meta.url),
			"utf8",
		);
		const imported = [...source.matchAll(/from "([^"]+)"/gu)].map(
			(match) => match[1],
		);
		expect(imported.sort()).toEqual([
			"@bufbuild/protobuf",
			"@hobo/ci",
			"node:crypto",
			"zod",
		]);
		expect(source).not.toMatch(
			/\bfetch\(|generate-jitconfig|registration-token|remove-token/u,
		);
	});
});
