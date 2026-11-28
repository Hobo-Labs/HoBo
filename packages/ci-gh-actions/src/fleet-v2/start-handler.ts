import { createHash, timingSafeEqual } from "node:crypto";
import {
	type ExecutionClaim,
	executionKeyId,
	parseExecutionKey,
	parseStartBindingInput,
	type RunnerSlot,
	type StrictFleetStore,
} from "@hobo/ci/fleet-v2";
import {
	authorizeStartFence,
	type GithubAssignmentLookup,
	type StartFenceBindRequest,
	startFenceRequestSchema,
	type VerifiedGithubAssignment,
} from "./start-fence.js";

const MAX_BODY = 64 * 1024;
async function boundedBody(request: Request): Promise<Uint8Array | undefined> {
	const declared = request.headers.get("content-length");
	if (
		declared !== null &&
		(!/^\d+$/.test(declared) || Number(declared) > MAX_BODY)
	)
		return undefined;
	if (!request.body) return new Uint8Array();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			total += chunk.value.byteLength;
			if (total > MAX_BODY) {
				await reader.cancel();
				return undefined;
			}
			chunks.push(chunk.value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}
type StartFenceResponse =
	| { authorized: false }
	| (Pick<
			StartFenceBindRequest,
			| "slotId"
			| "claimId"
			| "accountId"
			| "profileId"
			| "runnerName"
			| "executionKey"
	  > & { authorized: true });
function answer(status: number, body: StartFenceResponse): Response {
	return Response.json(body, {
		status,
		headers: { "Cache-Control": "no-store" },
	});
}
function sameSecret(secret: string, hash: string): boolean {
	if (!/^[a-f0-9]{64}$/.test(hash)) return false;
	const expected = Buffer.from(hash, "hex");
	const actual = createHash("sha256").update(secret, "utf8").digest();
	return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export function createStartFenceHandler(deps: {
	store: Pick<
		StrictFleetStore,
		"runnerSlot" | "bindStart" | "executionClaimById" | "releaseUnacceptedStart"
	>;
	lookupForSlot: (slot: RunnerSlot) => Promise<GithubAssignmentLookup>;
}): (request: Request) => Promise<Response> {
	return async (request) => {
		if (request.method !== "POST") return answer(405, { authorized: false });
		const bytes = await boundedBody(request).catch(() => undefined);
		if (!bytes) return answer(413, { authorized: false });
		let raw: unknown;
		try {
			raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
		} catch {
			return answer(400, { authorized: false });
		}
		const parsed = startFenceRequestSchema.safeParse(raw);
		if (!parsed.success) return answer(400, { authorized: false });
		const body = parsed.data;
		try {
			const slot = await deps.store.runnerSlot(body.slotId);
			if (
				!slot ||
				slot.accountId !== body.accountId ||
				slot.runnerName !== body.runnerName ||
				slot.profileId !== body.profileId ||
				!sameSecret(body.bindingSecret, slot.bindingSecretHash)
			)
				return answer(403, { authorized: false });
			const lookup = await deps.lookupForSlot(slot);
			const authorized = await authorizeStartFence(body, lookup);
			if (!authorized.ok) return answer(403, { authorized: false });
			const binding = authorized.bindRequest;
			const parsedBinding = parseStartBindingInput({
				slotId: binding.slotId,
				claimId: binding.claimId,
				key: binding.executionKey,
				bindingSecret: binding.bindingSecret,
				assignment: {
					verified: true,
					accountId: binding.accountId,
					runnerName: binding.runnerName,
					profileId: binding.profileId,
				},
			});
			const matchesClaim = (claim: ExecutionClaim | undefined): boolean =>
				claim !== undefined &&
				claim.id === binding.claimId &&
				claim.runnerSlotId === binding.slotId &&
				claim.profileId === binding.profileId &&
				(claim.state === "start-authorized" || claim.state === "running") &&
				executionKeyId(claim.key) === executionKeyId(parsedBinding.key);
			const matchesAssignment = (
				current: VerifiedGithubAssignment | undefined,
			): boolean =>
				current !== undefined &&
				current.runnerName === binding.runnerName &&
				current.accountId === binding.accountId &&
				executionKeyId(
					parseExecutionKey(JSON.stringify(current.executionKey)),
				) === executionKeyId(parsedBinding.key);
			if (!matchesAssignment(await lookup.lookupAssignment(binding.runnerName)))
				return answer(503, { authorized: false });
			const existing = await deps.store.executionClaimById(binding.claimId);
			if (existing && !matchesClaim(existing))
				return answer(503, { authorized: false });
			const result = await deps.store.bindStart(parsedBinding);
			let accepted = false;
			try {
				if (!matchesClaim(result.claim))
					return answer(503, { authorized: false });
				if (
					!matchesAssignment(await lookup.lookupAssignment(binding.runnerName))
				)
					return answer(503, { authorized: false });
				if (!matchesClaim(await deps.store.executionClaimById(binding.claimId)))
					return answer(503, { authorized: false });
				accepted = true;
				return answer(200, {
					authorized: true,
					slotId: binding.slotId,
					claimId: binding.claimId,
					accountId: binding.accountId,
					profileId: binding.profileId,
					runnerName: binding.runnerName,
					executionKey: binding.executionKey,
				});
			} finally {
				if (!accepted && !result.idempotent)
					await deps.store
						.releaseUnacceptedStart({
							claimId: binding.claimId,
							slotId: binding.slotId,
							key: parsedBinding.key,
						})
						.catch(() => false);
			}
		} catch {
			return answer(503, { authorized: false });
		}
	};
}
