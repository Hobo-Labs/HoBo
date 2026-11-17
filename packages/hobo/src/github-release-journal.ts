/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof -- SAFETY: this module parses untrusted GitHub JSON and validates each field before using a checkpoint. */
import { readBoundedJsonResponse } from "./bounded-json-response.js";
import { validRepository } from "./ci-repository.js";
import type {
	ReleaseCheckpoint,
	ReleaseJournal,
} from "./release-controller.js";

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const RELEASE_ENVIRONMENT = "hobo-ci-release-checkpoint";
interface GithubJournalCoordinates {
	readonly repository: string;
	readonly token: string;
	readonly commit: string;
	readonly fetch?: typeof fetch;
	readonly deadline?: number;
}

function requestTimeout(deadline: number | undefined): number {
	const remaining =
		deadline === undefined ? 20_000 : Math.min(20_000, deadline - Date.now());
	if (!Number.isSafeInteger(remaining) || remaining <= 0)
		throw new Error("The release checkpoint deadline expired.");
	return remaining;
}

function githubRequest(input: GithubJournalCoordinates) {
	if (
		!validRepository(input.repository) ||
		!/^[!-~]{8,4096}$/u.test(input.token) ||
		!/^[0-9a-f]{40}$/u.test(input.commit)
	)
		throw new TypeError("Invalid GitHub release journal coordinates.");
	const http = input.fetch ?? fetch;
	const base = `https://api.github.com/repos/${input.repository}/deployments`;
	return async (
		method: "GET" | "POST",
		path: string,
		body?: string,
	): Promise<Response> => {
		try {
			const response = await http(`${base}${path}`, {
				method,
				headers: {
					Authorization: `Bearer ${input.token}`,
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
					...(body !== undefined
						? { "Content-Type": "application/json" }
						: undefined),
				},
				...(body !== undefined ? { body } : undefined),
				redirect: "error",
				signal: AbortSignal.timeout(requestTimeout(input.deadline)),
			});
			if (!response.ok) {
				await response.body?.cancel().catch(() => {});
				throw new Error("request refused");
			}
			return response;
		} catch {
			throw new Error("GitHub release journal operation failed.");
		}
	};
}

function checkpoint(
	value: unknown,
	deploymentId: string,
	commit: string,
): ReleaseCheckpoint | undefined {
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return undefined;
		}
	}
	if (
		!object(value) ||
		value.schema !== "hobo.release-checkpoint/v1" ||
		value.deploymentId !== deploymentId ||
		value.commit !== commit ||
		typeof value.previousDeploymentId !== "string" ||
		!/^dpl_[A-Za-z0-9]+$/u.test(value.previousDeploymentId) ||
		value.previousDeploymentId === deploymentId
	)
		return undefined;
	return {
		deploymentId,
		previousDeploymentId: value.previousDeploymentId,
		commit,
		state: "reserved",
	};
}

export async function findPendingGithubRelease(
	input: GithubJournalCoordinates,
): Promise<ReleaseCheckpoint | undefined> {
	githubRequest(input);
	const http = input.fetch ?? fetch;
	const [owner, name] = input.repository.split("/");
	const query = `query($owner: String!, $name: String!, $after: String) {
		repository(owner: $owner, name: $name) {
			deployments(first: 100, after: $after, environments: ["hobo-ci-release-checkpoint"], orderBy: {field: CREATED_AT, direction: DESC}) {
				nodes { databaseId commitOid environment payload latestStatus { state } }
				pageInfo { hasNextPage endCursor }
			}
		}
	}`;
	const pending: ReleaseCheckpoint[] = [];
	let after: string | null = null;
	for (let page = 0; page < 100; page++) {
		let response: Response;
		try {
			response = await http("https://api.github.com/graphql", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${input.token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ query, variables: { owner, name, after } }),
				redirect: "error",
				signal: AbortSignal.timeout(requestTimeout(input.deadline)),
			});
		} catch {
			throw new Error("GitHub release journal operation failed.");
		}
		if (!response.ok) {
			await response.body?.cancel().catch(() => {});
			throw new Error("GitHub release journal operation failed.");
		}
		const result = await readBoundedJsonResponse(response);
		if (
			!object(result) ||
			result.errors !== undefined ||
			!object(result.data) ||
			!object(result.data.repository) ||
			!object(result.data.repository.deployments) ||
			!Array.isArray(result.data.repository.deployments.nodes) ||
			!object(result.data.repository.deployments.pageInfo)
		)
			throw new Error("Invalid GitHub release checkpoint listing.");
		const listing = result.data.repository.deployments;
		const nodes = listing.nodes;
		if (!Array.isArray(nodes))
			throw new Error("Invalid GitHub release checkpoint listing.");
		for (const record of nodes) {
			if (
				!object(record) ||
				typeof record.commitOid !== "string" ||
				!/^[0-9a-f]{40}$/u.test(record.commitOid) ||
				record.environment !== RELEASE_ENVIRONMENT ||
				typeof record.databaseId !== "number" ||
				!Number.isSafeInteger(record.databaseId) ||
				record.databaseId <= 0
			)
				throw new Error("Invalid GitHub release checkpoint.");
			let payload: unknown = record.payload;
			if (typeof payload === "string") {
				try {
					payload = JSON.parse(payload);
				} catch {
					throw new Error("Invalid GitHub release checkpoint.");
				}
			}
			if (
				!object(payload) ||
				typeof payload.deploymentId !== "string" ||
				!/^dpl_[A-Za-z0-9]+$/u.test(payload.deploymentId)
			)
				throw new Error("Invalid GitHub release checkpoint.");
			const value = checkpoint(payload, payload.deploymentId, record.commitOid);
			if (!value) throw new Error("Invalid GitHub release checkpoint.");
			if (
				record.latestStatus === null ||
				(object(record.latestStatus) &&
					typeof record.latestStatus.state === "string" &&
					["PENDING", "QUEUED", "IN_PROGRESS", "WAITING"].includes(
						record.latestStatus.state,
					))
			)
				pending.push(value);
			else if (
				!object(record.latestStatus) ||
				(record.latestStatus.state !== "SUCCESS" &&
					record.latestStatus.state !== "INACTIVE")
			)
				throw new Error("Unexpected GitHub release status.");
		}
		if (pending.length > 1)
			throw new Error("Multiple unfinished GitHub releases need inspection.");
		const info = listing.pageInfo;
		if (!object(info) || typeof info.hasNextPage !== "boolean")
			throw new Error("Invalid GitHub release pagination.");
		if (!info.hasNextPage) return pending[0];
		if (
			typeof info.endCursor !== "string" ||
			info.endCursor === "" ||
			info.endCursor === after
		)
			throw new Error("Invalid GitHub release pagination.");
		after = info.endCursor;
	}
	throw new Error("GitHub release checkpoint history exceeds its safe limit.");
}

export function createGithubReleaseJournal(
	input: GithubJournalCoordinates & {
		readonly deploymentId: string;
	},
): ReleaseJournal {
	if (!/^dpl_[A-Za-z0-9]+$/u.test(input.deploymentId))
		throw new TypeError("Invalid GitHub release journal coordinates.");
	const request = githubRequest(input);
	const environment = RELEASE_ENVIRONMENT;
	async function find(): Promise<
		{ id: number; value: ReleaseCheckpoint } | undefined
	> {
		const query = new URLSearchParams({
			sha: input.commit,
			environment,
			per_page: "100",
		});
		const matching: Record<string, unknown>[] = [];
		let complete = false;
		for (let page = 1; page <= 100; page++) {
			query.set("page", String(page));
			const data = await readBoundedJsonResponse(
				await request("GET", `?${query}`),
			);
			if (!Array.isArray(data) || data.length > 100)
				throw new Error("GitHub release checkpoints are ambiguous.");
			for (const entry of data)
				if (
					object(entry) &&
					checkpoint(entry.payload, input.deploymentId, input.commit) !==
						undefined
				)
					matching.push(entry);
			if (matching.length > 1)
				throw new Error("GitHub release checkpoints are ambiguous.");
			if (data.length < 100) {
				complete = true;
				break;
			}
		}
		if (!complete)
			throw new Error(
				"GitHub release checkpoint history exceeds its safe limit.",
			);
		if (matching.length === 0) return undefined;
		if (matching.length !== 1 || !object(matching[0]))
			throw new Error("GitHub release checkpoints are ambiguous.");
		const record = matching[0];
		if (
			typeof record.id !== "number" ||
			!Number.isSafeInteger(record.id) ||
			record.id <= 0 ||
			record.sha !== input.commit ||
			record.environment !== environment
		)
			throw new Error("Invalid GitHub release checkpoint.");
		const value = checkpoint(record.payload, input.deploymentId, input.commit);
		if (!value) throw new Error("Invalid GitHub release checkpoint.");
		const statuses = await readBoundedJsonResponse(
			await request("GET", `/${record.id}/statuses?per_page=1`),
		);
		if (!Array.isArray(statuses) || statuses.length > 1)
			throw new Error("Invalid GitHub release status.");
		if (statuses.length === 0) return { id: record.id, value };
		const last = statuses[0];
		if (!object(last) || typeof last.state !== "string")
			throw new Error("Unexpected GitHub release status.");
		if (["pending", "queued", "in_progress", "waiting"].includes(last.state))
			return { id: record.id, value };
		if (last.state !== "success" && last.state !== "inactive")
			throw new Error("Unexpected GitHub release status.");
		return {
			id: record.id,
			value: {
				...value,
				state: last.state === "success" ? "verified" : "rolled-back",
			},
		};
	}
	return {
		async load() {
			return (await find())?.value;
		},
		async reserve(value) {
			if (
				value.deploymentId !== input.deploymentId ||
				value.commit !== input.commit ||
				!/^dpl_[A-Za-z0-9]+$/u.test(value.previousDeploymentId) ||
				value.previousDeploymentId === value.deploymentId ||
				value.state !== "reserved"
			)
				throw new Error("Invalid GitHub release reservation.");
			const existing = await find();
			if (existing) return existing.value;
			const body = JSON.stringify({
				ref: input.commit,
				environment,
				auto_merge: false,
				required_contexts: [],
				transient_environment: true,
				production_environment: false,
				payload: {
					schema: "hobo.release-checkpoint/v1",
					deploymentId: value.deploymentId,
					previousDeploymentId: value.previousDeploymentId,
					commit: value.commit,
				},
			});
			await readBoundedJsonResponse(await request("POST", "", body));
			const saved = await find();
			if (
				!saved ||
				saved.value.previousDeploymentId !== value.previousDeploymentId
			)
				throw new Error("The GitHub release reservation was not confirmed.");
			return saved.value;
		},
		async save(value) {
			const saved = await find();
			if (
				!saved ||
				saved.value.deploymentId !== value.deploymentId ||
				saved.value.previousDeploymentId !== value.previousDeploymentId ||
				saved.value.commit !== value.commit ||
				(saved.value.state !== "reserved" &&
					saved.value.state !== value.state) ||
				value.state === "reserved"
			)
				throw new Error(
					"The GitHub release checkpoint does not match the reservation.",
				);
			if (saved.value.state === value.state) return;
			const state = value.state === "verified" ? "success" : "inactive";
			await readBoundedJsonResponse(
				await request(
					"POST",
					`/${saved.id}/statuses`,
					JSON.stringify({
						state,
						auto_inactive: false,
						description:
							value.state === "verified"
								? "HoBo CD verified production"
								: "HoBo CD rolled back production",
					}),
				),
			);
			const confirmed = await find();
			if (!confirmed || confirmed.value.state !== value.state)
				throw new Error("The GitHub release status was not confirmed.");
		},
	};
}
