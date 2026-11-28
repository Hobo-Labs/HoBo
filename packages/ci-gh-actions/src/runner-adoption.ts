import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import {
	defineMachineAdvert,
	type MachineAdvert,
	MachineAdvertSchema,
	type MachineSharing,
} from "@hobo/ci";
import { z } from "zod";

// public-contract: an adopted runner's label is this prefix and 8 lowercase hex digits.
export const ADOPTED_RUNNER_LABEL_PREFIX = "hobo-runner-";
const ADOPTED_LABEL = /^hobo-runner-[0-9a-f]{8}$/u;
// public-contract: the signer an adopted runner's advert names; GitHub's labels API vouches for it, not a mesh key.
export const ADOPTED_RUNNER_SIGNER = "github:runner-labels";
const MAX_PAGES = 10;
const MAX_LABELS = 32;

const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;

export type RunnerLabelsBody = Readonly<{ labels: readonly string[] }>;

export interface RunnerAdoptionGithub {
	request(
		method: "GET" | "POST" | "DELETE",
		path: string,
		body: RunnerLabelsBody | undefined,
	): Promise<Response>;
}

export type RunnerAdoptionProblem =
	| "public_repository"
	| "not_found"
	| "not_offered"
	| "forbidden"
	| "unsupported_runner"
	| "github_failed";

export class RunnerAdoptionError extends Error {
	constructor(
		readonly problem: RunnerAdoptionProblem,
		message: string,
	) {
		super(message);
		this.name = "RunnerAdoptionError";
	}
}

export type RunnerScope = "repository" | "organization";

export type AdoptableRunner = Readonly<{
	id: number;
	name: string;
	scope: RunnerScope;
	registeredOn: string;
	os: string;
	status: "online" | "offline";
	busy: boolean;
	labels: readonly string[];
	adoptedLabel: string | undefined;
	groupId: number | undefined;
}>;

export type RunnerListing = Readonly<{
	repository: string;
	runners: readonly AdoptableRunner[];
	leftOut: readonly AdoptableRunner[];
	warnings: readonly string[];
}>;

const LabelSchema = z.looseObject({ name: z.string().min(1).max(200) });
const LabelsSchema = z.looseObject({ labels: z.array(LabelSchema) });
const RunnerSchema = z.looseObject({
	id: z.number().int().positive(),
	name: z.string().min(1).max(200),
	os: z.string().max(40),
	status: z.enum(["online", "offline"]),
	busy: z.boolean(),
	labels: z.array(LabelSchema),
	runner_group_id: z.number().int().nonnegative().nullish(),
});
const RunnersPageSchema = z.looseObject({ runners: z.array(RunnerSchema) });
const GroupsPageSchema = z.looseObject({
	runner_groups: z.array(z.looseObject({ id: z.number().int().nonnegative() })),
});
const RepositorySchema = z.looseObject({
	private: z.boolean(),
	owner: z.looseObject({
		id: z.number().int().positive().optional(),
		login: z.string(),
		type: z.string(),
	}),
});
const UserSchema = z.looseObject({
	id: z.number().int().positive(),
	login: z.string().min(1).max(39),
});

export function adoptionLabel(
	scope: RunnerScope,
	registeredOn: string,
	runnerId: number,
): string {
	const digest = createHash("sha256")
		.update(`${scope}:${registeredOn.toLowerCase()}:${runnerId}`)
		.digest("hex");
	return `${ADOPTED_RUNNER_LABEL_PREFIX}${digest.slice(0, 8)}`;
}

export function isAdoptionLabel(label: string): boolean {
	return ADOPTED_LABEL.test(label);
}

function failed(status: number, what: string): RunnerAdoptionError {
	if (status === 401 || status === 403)
		return new RunnerAdoptionError(
			"forbidden",
			`GitHub refused to ${what} (${status}). Adopting runners needs administrator access.`,
		);
	if (status === 404)
		return new RunnerAdoptionError(
			"not_found",
			`GitHub found nothing to ${what} (404).`,
		);
	return new RunnerAdoptionError(
		"github_failed",
		`GitHub could not ${what} (${status}).`,
	);
}

async function readJson<T>(
	response: Response,
	schema: z.ZodType<T>,
	what: string,
): Promise<T> {
	if (!response.ok) throw failed(response.status, what);
	const parsed = schema.safeParse(await response.json().catch(() => null));
	if (!parsed.success)
		throw new RunnerAdoptionError(
			"github_failed",
			`GitHub answered with something that is not what was asked when trying to ${what}.`,
		);
	return parsed.data;
}

function runnersPath(scope: RunnerScope, registeredOn: string): string {
	return scope === "repository"
		? `/repos/${registeredOn}/actions/runners`
		: `/orgs/${registeredOn}/actions/runners`;
}

async function readRunners(
	github: RunnerAdoptionGithub,
	scope: RunnerScope,
	registeredOn: string,
): Promise<AdoptableRunner[]> {
	const found: AdoptableRunner[] = [];
	for (let page = 1; page <= MAX_PAGES; page += 1) {
		const listed = await readJson(
			await github.request(
				"GET",
				`${runnersPath(scope, registeredOn)}?per_page=100&page=${page}`,
				undefined,
			),
			RunnersPageSchema,
			`list the runners of ${registeredOn}`,
		);
		for (const runner of listed.runners) {
			const labels = runner.labels.map((label) => label.name);
			found.push({
				id: runner.id,
				name: runner.name,
				scope,
				registeredOn,
				os: runner.os,
				status: runner.status,
				busy: runner.busy,
				labels,
				adoptedLabel: labels.find(
					(label) =>
						label.toLowerCase() ===
						adoptionLabel(scope, registeredOn, runner.id),
				),
				groupId:
					scope === "organization"
						? (runner.runner_group_id ?? undefined)
						: undefined,
			});
		}
		if (listed.runners.length < 100) break;
	}
	return found;
}

function checkedRepository(repository: string): string {
	if (
		!REPOSITORY.test(repository) ||
		repository.split("/").some((part) => part === "." || part === "..")
	)
		throw new RunnerAdoptionError(
			"not_found",
			`${repository} is not an owner/name repository.`,
		);
	return repository;
}

export async function listAdoptableRunners(
	github: RunnerAdoptionGithub,
	repository: string,
): Promise<RunnerListing> {
	const name = checkedRepository(repository);
	const described = await readJson(
		await github.request("GET", `/repos/${name}`, undefined),
		RepositorySchema,
		`read ${name}`,
	);
	if (!described.private)
		throw new RunnerAdoptionError(
			"public_repository",
			`${name} is public. A public repository's jobs never run on machines, so it adopts no runner.`,
		);
	const runners = await readRunners(github, "repository", name);
	const leftOut: AdoptableRunner[] = [];
	const warnings: string[] = [];
	const org = described.owner.login;
	if (described.owner.type === "Organization" && LOGIN.test(org)) {
		try {
			const repoName = name.slice(name.indexOf("/") + 1);
			const groups = await readJson(
				await github.request(
					"GET",
					`/orgs/${org}/actions/runner-groups?visible_to_repository=${repoName}&per_page=100`,
					undefined,
				),
				GroupsPageSchema,
				`list the runner groups ${name} may use`,
			);
			const admitted = new Set(groups.runner_groups.map((group) => group.id));
			for (const runner of await readRunners(github, "organization", org)) {
				if (runner.groupId !== undefined && admitted.has(runner.groupId))
					runners.push(runner);
				else leftOut.push(runner);
			}
		} catch (error) {
			if (
				!(error instanceof RunnerAdoptionError) ||
				error.problem !== "forbidden"
			)
				throw error;
			warnings.push(
				`The runners of the organization ${org} could not be read: listing them needs organization administrator access.`,
			);
		}
	}
	return { repository: name, runners, leftOut, warnings };
}

function find(listing: RunnerListing, runnerId: number): AdoptableRunner {
	const runner = listing.runners.find((each) => each.id === runnerId);
	if (runner) return runner;
	if (listing.leftOut.some((each) => each.id === runnerId))
		throw new RunnerAdoptionError(
			"not_offered",
			`Runner ${runnerId} is in a runner group that leaves ${listing.repository} out, so it is not offered.`,
		);
	throw new RunnerAdoptionError(
		"not_found",
		`${listing.repository} has no self-hosted runner ${runnerId}.`,
	);
}

function osOf(runner: AdoptableRunner): MachineAdvert["os"] {
	const os = runner.os.toLowerCase();
	if (os === "linux" || os === "macos" || os === "windows") return os;
	throw new RunnerAdoptionError(
		"unsupported_runner",
		`Runner ${runner.id} reports the OS "${runner.os}", which a machine cannot advertise.`,
	);
}

function archOf(runner: AdoptableRunner): MachineAdvert["arch"] {
	const names = new Set(runner.labels.map((label) => label.toLowerCase()));
	if (names.has("arm64")) return "arm64";
	if (names.has("x64")) return "x64";
	if (names.has("arm")) return "arm";
	throw new RunnerAdoptionError(
		"unsupported_runner",
		`Runner ${runner.id} has no X64, ARM64 or ARM label, so its architecture is unknown.`,
	);
}

export type RunnerAdopter = Readonly<{ id: string; login: string }>;

export type AdoptRunnerInput = Readonly<{
	repository: string;
	runnerId: number;
	accountId: string;
	adopter: RunnerAdopter;
	sharing: MachineSharing | undefined;
	nowMs: number;
}>;

export type RunnerAdoption = Readonly<{
	runner: AdoptableRunner;
	label: string;
	changed: boolean;
	advert: MachineAdvert;
}>;

export function adoptedRunnerAdvert(
	runner: AdoptableRunner,
	label: string,
	input: Omit<AdoptRunnerInput, "repository" | "runnerId">,
): MachineAdvert {
	const labels = runner.labels.includes(label)
		? runner.labels
		: [...runner.labels, label];
	if (labels.length > MAX_LABELS)
		throw new RunnerAdoptionError(
			"unsupported_runner",
			`Runner ${runner.id} has more than ${MAX_LABELS} labels, more than a machine advert holds.`,
		);
	return defineMachineAdvert(
		create(MachineAdvertSchema, {
			id: `github-runner-${runner.id}`,
			accountId: input.accountId,
			name: runner.name,
			runsOn: label,
			labels: [...labels],
			os: osOf(runner),
			arch: archOf(runner),
			slots: 1,
			busy: runner.busy ? 1 : 0,
			paused: false,
			sharing: input.sharing ?? "only_me",
			ownerId: input.adopter.id,
			ownerLogin: input.adopter.login,
			repository: runner.scope === "repository" ? runner.registeredOn : "",
			lastSeenMs: runner.status === "online" ? input.nowMs : 1,
			signerKeyId: ADOPTED_RUNNER_SIGNER,
			isolation: "host",
			lastPickedAtMs: 0,
		}),
	);
}

function labelsPath(runner: AdoptableRunner): string {
	return `${runnersPath(runner.scope, runner.registeredOn)}/${runner.id}/labels`;
}

export async function adoptRunner(
	github: RunnerAdoptionGithub,
	input: AdoptRunnerInput,
): Promise<RunnerAdoption> {
	const listing = await listAdoptableRunners(github, input.repository);
	const runner = find(listing, input.runnerId);
	const label =
		runner.adoptedLabel ??
		adoptionLabel(runner.scope, runner.registeredOn, runner.id);
	if (
		[...listing.runners, ...listing.leftOut].some(
			(other) =>
				(other.scope !== runner.scope ||
					other.registeredOn !== runner.registeredOn ||
					other.id !== runner.id) &&
				other.labels.some((name) => name.toLowerCase() === label.toLowerCase()),
		)
	)
		throw new RunnerAdoptionError(
			"unsupported_runner",
			`The label ${label} is also present on another runner; remove the collision before adoption.`,
		);
	const advert = adoptedRunnerAdvert(runner, label, input);
	if (runner.adoptedLabel !== undefined)
		return { runner, label, changed: false, advert };
	const after = await readJson(
		await github.request("POST", labelsPath(runner), { labels: [label] }),
		LabelsSchema,
		`add the label ${label} to runner ${runner.id}`,
	);
	if (!after.labels.some((each) => each.name === label))
		throw new RunnerAdoptionError(
			"github_failed",
			`GitHub did not keep the label ${label} on runner ${runner.id}.`,
		);
	const adopted: AdoptableRunner = {
		...runner,
		labels: after.labels.map((each) => each.name),
		adoptedLabel: label,
	};
	return {
		runner: adopted,
		label,
		changed: true,
		advert: adoptedRunnerAdvert(adopted, label, input),
	};
}

export type RunnerRelease = Readonly<{
	runner: AdoptableRunner;
	removed: readonly string[];
}>;

export async function releaseRunner(
	github: RunnerAdoptionGithub,
	input: Readonly<{ repository: string; runnerId: number }>,
): Promise<RunnerRelease> {
	const listing = await listAdoptableRunners(github, input.repository);
	const runner =
		listing.leftOut.find((each) => each.id === input.runnerId) ??
		find(listing, input.runnerId);
	const removed: string[] = [];
	let labels = runner.labels;
	const ownLabel = adoptionLabel(runner.scope, runner.registeredOn, runner.id);
	for (const label of runner.labels.filter(
		(name) => name.toLowerCase() === ownLabel,
	)) {
		const response = await github.request(
			"DELETE",
			`${labelsPath(runner)}/${label}`,
			undefined,
		);
		if (response.status === 404) continue;
		const after = await readJson(
			response,
			LabelsSchema,
			`remove the label ${label} from runner ${runner.id}`,
		);
		labels = after.labels.map((each) => each.name);
		removed.push(label);
	}
	return {
		runner: { ...runner, labels, adoptedLabel: undefined },
		removed,
	};
}

export async function runnerAdopter(
	github: RunnerAdoptionGithub,
	repository?: string,
): Promise<RunnerAdopter> {
	const userResponse = await github.request("GET", "/user", undefined);
	if (
		userResponse.status === 403 &&
		repository &&
		REPOSITORY.test(repository)
	) {
		const repo = await readJson(
			await github.request("GET", `/repos/${repository}`, undefined),
			RepositorySchema,
			`read ${repository} owner`,
		);
		if (repo.owner.id !== undefined) {
			return { id: String(repo.owner.id), login: repo.owner.login };
		}
	}
	const user = await readJson(
		userResponse,
		UserSchema,
		"read the signed-in user",
	);
	return { id: String(user.id), login: user.login };
}
