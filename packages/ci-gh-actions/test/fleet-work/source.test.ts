/**
 * The dispatcher half of `github-actions-job` (design §6.9 table, §7.3
 * `GithubWorkOptions`): the existing poller reads GitHub's queue through a
 * fake transport; each queued job becomes upstream work with its author,
 * origin, ref, workflow digest and size; `prepare` mints one registration
 * per claimant and returns it as the secret; `stillWanted` asks GitHub.
 */
import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import {
	CoordinationMode,
	FleetPolicySchema,
	type FleetRecord,
	FleetRecordSchema,
	MemberRecordSchema,
	type Outcome,
	WorkOfferSchema,
	WorkOrigin,
} from "@hobo/fleet";
import { workDigest } from "@hobo/fleet/work";
import { describe, expect, it } from "vitest";
import { createGithubActionsWorkSource } from "../../src/fleet-work/index.js";
import { GITHUB_RUNNER_IMAGE } from "../../src/fleet-work/runner.js";
import {
	createFakeGithub,
	type FakeGithub,
	queueJob,
} from "./support/github.js";

const NOW = Date.parse("2026-11-13T12:00:00.000Z");

function fleet(
	init: Readonly<{ labels?: string[]; repository?: string }> = {},
): FleetRecord {
	return create(FleetRecordSchema, {
		fleetId: "hobo",
		tenant: "acme",
		coordination: CoordinationMode.MANY_ACTIVE,
		policy: create(FleetPolicySchema, {
			repositories: [
				{ repository: init.repository ?? "acme/app", refs: ["refs/heads/**"] },
			],
			labels: init.labels ?? [],
		}),
	});
}

type Minted = {
	repository: string;
	labels: readonly string[];
	runnerName: string;
};

function source(
	github: FakeGithub,
	mint: (input: Minted) => Promise<Outcome<Uint8Array>> = async () => ({
		ok: true,
		value: new TextEncoder().encode("jit-config"),
	}),
) {
	const minted: Minted[] = [];
	const ingested: string[] = [];
	const work = createGithubActionsWorkSource({
		poller: {
			github,
			connections: async () => [
				{ installationId: 7, repositoryId: 42, repository: "acme/app" },
			],
			ingest: async (delivery) => {
				ingested.push(delivery.deliveryId);
				return "accepted";
			},
			now: () => NOW,
		},
		async mintRegistration(input) {
			minted.push({ ...input, labels: [...input.labels] });
			return mint(input);
		},
		now: () => NOW,
		log: () => undefined,
	});
	return { work, minted, ingested };
}

function offerOf(
	workKey: string,
	init: Partial<{ label: string; repository: string }> = {},
) {
	return create(WorkOfferSchema, {
		workKey,
		workDigest: workDigest("github-actions-job", workKey),
		kind: "github-actions-job",
		fleet: "hobo",
		label: init.label ?? "hobo",
		repository: init.repository ?? "acme/app",
	});
}

const claimant = create(MemberRecordSchema, {
	memberId: "mem_0123456789abcdef",
});

describe("createGithubActionsWorkSource", () => {
	it("has the kind github-actions-job", () => {
		expect(source(createFakeGithub()).work.kind).toBe("github-actions-job");
	});

	it("offers a queued internal job with its author, origin, ref, workflow digest and size", async () => {
		const github = createFakeGithub();
		const { job } = queueJob(github, {
			actorId: 2,
			triggeringActorId: 3,
			name: "Main full gate",
			workflow: "name: ci\n",
		});
		const { work, ingested } = source(github);
		const works = await work.poll(fleet());
		expect(works).toHaveLength(1);
		const [first] = works;
		expect(first?.workKey).toBe(`acme/app#${job.id}@1`);
		expect(first?.label).toBe("hobo");
		expect(first?.author).toBe("github:3");
		expect(first?.origin).toBe(WorkOrigin.INTERNAL);
		expect(first?.repository).toBe("acme/app");
		expect(first?.ref).toBe("refs/heads/main");
		expect(first?.workflowDigest).toBe(
			`sha256:${createHash("sha256").update("name: ci\n").digest("hex")}`,
		);
		expect(first?.queuedAtMs).toBe(Date.parse(job.createdAt));
		// "Main full gate" is a heavy job: 6 GiB by the worker's default classes.
		expect(first?.needs?.memoryMb).toBeGreaterThanOrEqual(4096);
		expect(first?.needs?.diskMb).toBe(12 * 1024);
		expect(first?.needs?.labels).toEqual(["hobo"]);
		expect(first?.needs?.platform?.os).toBe("linux");
		// The poller is the existing one: its intake still sees the job.
		expect(ingested).toHaveLength(1);
	});

	it("marks a pull request from a fork FORK and one from a branch INTERNAL", async () => {
		const github = createFakeGithub();
		const fork = queueJob(github, {
			event: "pull_request",
			headRepository: "mallory/app",
			pullRequest: 5,
			headBranch: "patch",
		});
		const own = queueJob(github, {
			event: "pull_request",
			headRepository: "acme/app",
			pullRequest: 6,
			headBranch: "feature",
		});
		const gone = queueJob(github, {
			event: "pull_request",
			headRepository: null,
			headBranch: "orphan",
		});
		const odd = queueJob(github, { event: "issue_comment" });
		const { work } = source(github);
		const works = await work.poll(fleet());
		const byJob = (id: number) =>
			works.find((entry) => entry.workKey === `acme/app#${id}@1`);
		expect(byJob(fork.job.id)?.origin).toBe(WorkOrigin.FORK);
		expect(byJob(fork.job.id)?.ref).toBe("refs/pull/5/merge");
		expect(byJob(own.job.id)?.origin).toBe(WorkOrigin.INTERNAL);
		expect(byJob(own.job.id)?.ref).toBe("refs/pull/6/merge");
		expect(byJob(gone.job.id)?.origin).toBe(WorkOrigin.UNKNOWN);
		expect(byJob(gone.job.id)?.ref).toBe("refs/heads/orphan");
		expect(byJob(odd.job.id)?.origin).toBe(WorkOrigin.UNKNOWN);
	});

	it("offers only repositories and labels the fleet's policy names", async () => {
		const github = createFakeGithub();
		queueJob(github, { labels: ["hobo-trunk"] });
		queueJob(github, { labels: ["hobo"] });
		const { work } = source(github);
		expect(await work.poll(fleet({ labels: ["hobo-trunk"] }))).toHaveLength(1);
		expect(await work.poll(fleet({ repository: "acme/other" }))).toHaveLength(
			0,
		);
		expect(await work.poll(fleet())).toHaveLength(2);
	});

	it("leaves out a job whose run GitHub will not describe, and leaves the digest empty without the workflow file", async () => {
		const github = createFakeGithub();
		const hidden = queueJob(github);
		const plain = queueJob(github, { path: ".github/workflows/x.yml" });
		github.failing.set(`/repos/acme/app/actions/runs/${hidden.run.id}`, 500);
		github.failing.set(
			`/repos/acme/app/contents/.github/workflows/x.yml?ref=${plain.run.headSha}`,
			404,
		);
		const { work } = source(github);
		const works = await work.poll(fleet());
		expect(works.map((entry) => entry.workKey)).toEqual([
			`acme/app#${plain.job.id}@1`,
		]);
		expect(works[0]?.workflowDigest).toBe("");
	});

	it("drops a job once GitHub assigns it", async () => {
		const github = createFakeGithub();
		const { job } = queueJob(github);
		const { work } = source(github);
		expect(await work.poll(fleet())).toHaveLength(1);
		job.status = "in_progress";
		job.runnerName = "someone-else";
		expect(await work.poll(fleet())).toHaveLength(0);
	});

	it("prepares one registration per claimant: the secret, the runner image and GitHub's hosts", async () => {
		const github = createFakeGithub();
		const { job } = queueJob(github, { labels: ["hobo-trunk"] });
		const { work, minted } = source(github);
		const [first] = await work.poll(fleet());
		const prepared = await work.prepare(
			offerOf(first?.workKey ?? "", { label: "hobo-trunk" }),
			claimant,
		);
		expect(prepared.ok).toBe(true);
		if (!prepared.ok) return;
		expect(new TextDecoder().decode(prepared.value.secret)).toBe("jit-config");
		expect(prepared.value.parameters.image).toBe(GITHUB_RUNNER_IMAGE);
		expect(prepared.value.egressAllow).toContain("api.github.com");
		expect(prepared.value.egressAllow).toContain(
			"broker.actions.githubusercontent.com",
		);
		expect(minted).toHaveLength(1);
		expect(minted[0]?.repository).toBe("acme/app");
		// A trunk runner never joins the shared label (runner-labels.ts).
		expect(minted[0]?.labels).toEqual(["hobo-trunk"]);
		expect(minted[0]?.runnerName).toMatch(/^hobo-fleet-[A-Za-z0-9._-]+$/u);
		expect(minted[0]?.runnerName.length).toBeLessThanOrEqual(64);
		// The secret never appears among the non-secret parameters.
		expect(JSON.stringify(prepared.value.parameters)).not.toContain(
			"jit-config",
		);
		// Prepared work is not offered again while GitHub still lists it queued.
		expect(await work.poll(fleet())).toHaveLength(0);
		expect(job.status).toBe("queued");
	});

	it("passes a failed registration on and refuses work it never saw", async () => {
		const github = createFakeGithub();
		queueJob(github);
		const { work } = source(github, async () => ({
			ok: false,
			error: { code: "forbidden", message: "no permission" },
		}));
		const [first] = await work.poll(fleet());
		const failed = await work.prepare(offerOf(first?.workKey ?? ""), claimant);
		expect(failed.ok).toBe(false);
		if (!failed.ok) expect(failed.error.code).toBe("forbidden");
		const unknown = await work.prepare(offerOf("acme/app#1@1"), claimant);
		expect(unknown.ok).toBe(false);
		if (!unknown.ok) expect(unknown.error.code).toBe("work-unknown");
	});

	it("still wants a job only while GitHub has it queued and unassigned", async () => {
		const github = createFakeGithub();
		const { job } = queueJob(github);
		const { work } = source(github);
		const [first] = await work.poll(fleet());
		const offer = offerOf(first?.workKey ?? "");
		expect(await work.stillWanted(offer)).toBe(true);
		github.failing.set(`/repos/acme/app/actions/jobs/${job.id}`, 502);
		// A GitHub error does not strand the queue.
		expect(await work.stillWanted(offer)).toBe(true);
		github.failing.clear();
		job.status = "in_progress";
		job.runnerName = "other";
		expect(await work.stillWanted(offer)).toBe(false);
		expect(await work.stillWanted(offerOf("acme/app#1@1"))).toBe(false);
	});
});
