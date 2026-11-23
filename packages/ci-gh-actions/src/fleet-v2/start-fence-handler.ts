import { createHash, timingSafeEqual } from "node:crypto";
import {
	FleetRejection,
	parseStartBindingInput,
	type StrictFleetStore,
} from "@hobo/ci/fleet-v2";
import type { GithubTransport } from "../github.js";
import { createGithubAssignmentLookup } from "./github-assignment.js";
import { authorizeStartFence, parseStartFenceRequest } from "./start-fence.js";

export type StartFencePolicy = Readonly<{
	accountId: string;
	engineId: string;
	installationId: number;
	profileId: string;
	runnerGroupId: number;
	requiredLabels: readonly string[];
	repositories: readonly Readonly<{ id: number; name: string }>[];
}>;

const MAX_BODY_BYTES = 16384;

function response(status: number, body: { error: string }): Response {
	return Response.json(body, {
		status,
		headers: { "cache-control": "no-store" },
	});
}

async function readBody(request: Request): Promise<string | undefined> {
	const length = request.headers.get("content-length");
	if (
		length !== null &&
		(!/^\d+$/u.test(length) || Number(length) > MAX_BODY_BYTES)
	)
		return undefined;
	if (!request.body) return "";
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			size += chunk.value.byteLength;
			if (size > MAX_BODY_BYTES) {
				await reader.cancel();
				return undefined;
			}
			chunks.push(chunk.value);
		}
	} finally {
		reader.releaseLock();
	}
	return new TextDecoder("utf-8", { fatal: true }).decode(
		Buffer.concat(chunks),
	);
}

function bindingSecretMatches(expectedHash: string, secret: string): boolean {
	const expected = Buffer.from(expectedHash, "hex");
	const actual = createHash("sha256").update(secret, "utf8").digest();
	return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function createStartFenceHandler(options: {
	store: StrictFleetStore;
	github: GithubTransport;
	policies: readonly StartFencePolicy[];
}): (request: Request) => Promise<Response | undefined> {
	return async (request) => {
		const url = new URL(request.url);
		if (url.pathname !== "/v1/fleet/start-fence") return undefined;
		if (url.protocol !== "https:" || url.search || url.hash)
			return response(403, { error: "request rejected" });
		if (request.method !== "POST")
			return response(405, { error: "method not allowed" });
		if (
			request.headers
				.get("content-type")
				?.split(";")[0]
				?.trim()
				.toLowerCase() !== "application/json"
		) {
			return response(415, { error: "JSON required" });
		}

		let raw: string | undefined;
		let input: unknown;
		try {
			raw = await readBody(request);
			if (raw === undefined)
				return response(413, { error: "request too large" });
			input = JSON.parse(raw);
		} catch {
			return response(400, { error: "invalid request" });
		}
		const parsed = parseStartFenceRequest(input);
		if (!parsed.success) return response(400, { error: "invalid request" });
		const body = parsed.data;

		try {
			const slot = await options.store.runnerSlot(body.slotId);
			if (
				!slot ||
				!bindingSecretMatches(slot.bindingSecretHash, body.bindingSecret)
			) {
				return response(403, { error: "request rejected" });
			}
			const runnerId = Number(slot.externalRunnerId);
			const job = body.executionKey.githubJob;
			if (
				!/^[1-9]\d*$/u.test(slot.externalRunnerId) ||
				!Number.isSafeInteger(runnerId) ||
				slot.accountId !== body.accountId ||
				slot.runnerName !== body.runnerName ||
				slot.profileId !== body.profileId ||
				job.accountId !== slot.accountId ||
				(slot.state !== "registered" && slot.state !== "bound")
			)
				return response(403, { error: "request rejected" });

			const policies = options.policies.filter(
				(policy) =>
					policy.accountId === slot.accountId &&
					policy.profileId === slot.profileId &&
					policy.engineId === job.engineId &&
					String(policy.installationId) === job.installationId &&
					policy.repositories.some(
						(repository) => String(repository.id) === job.repositoryId,
					),
			);
			if (policies.length !== 1)
				return response(403, { error: "request rejected" });
			const policy = policies[0];
			const repositories = policy?.repositories.filter(
				(entry) => String(entry.id) === job.repositoryId,
			);
			const repository = repositories?.[0];
			const runId = Number(job.runId);
			if (
				!policy ||
				!repository ||
				repositories.length !== 1 ||
				!/^[1-9]\d*$/u.test(job.runId) ||
				!Number.isSafeInteger(runId)
			) {
				return response(403, { error: "request rejected" });
			}
			const lookup = createGithubAssignmentLookup(options.github, {
				accountId: slot.accountId,
				engineId: policy.engineId,
				installationId: policy.installationId,
				repository: repository.name,
				repositoryId: repository.id,
				runId,
				runAttempt: job.runAttempt,
				runnerId,
				runnerGroupId: policy.runnerGroupId,
				requiredLabels: policy.requiredLabels,
			});
			const authorized = await authorizeStartFence(body, lookup);
			if (!authorized.ok) return response(403, { error: "request rejected" });
			const verified = authorized.bindRequest;
			const binding = parseStartBindingInput({
				slotId: verified.slotId,
				claimId: verified.claimId,
				key: verified.executionKey,
				bindingSecret: verified.bindingSecret,
				assignment: {
					verified: true,
					accountId: verified.accountId,
					runnerName: verified.runnerName,
					profileId: verified.profileId,
				},
			});
			await options.store.bindStart(binding);
			return Response.json(
				{
					authorized: true,
					slotId: verified.slotId,
					claimId: verified.claimId,
					runnerName: verified.runnerName,
					executionKey: verified.executionKey,
				},
				{ headers: { "cache-control": "no-store" } },
			);
		} catch (error) {
			if (error instanceof FleetRejection)
				return response(409, { error: "request rejected" });
			return response(503, { error: "authorization unavailable" });
		}
	};
}
