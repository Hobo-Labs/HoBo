import { createHash } from "node:crypto";
import { create, fromJson, toBinary, toJson } from "@bufbuild/protobuf";
import type { EventEnvelope } from "@hobo/core";
import {
	CoordinationMode,
	ReceiptStatus,
	SandboxTier,
	type SignedEnvelope,
	SignedEnvelopeSchema,
	type WorkStatus,
	WorkStatusSchema,
	type WorkSubmissionRequest,
	WorkSubmissionRequestSchema,
	WorkSubmissionSchema,
} from "../_generated/fleet_pb.js";
import { WORK_SUBMISSION_CONTEXT } from "../contexts.js";
import type { FleetId } from "../ids.js";
import { signEnvelope } from "../keys/index.js";
import type { Outcome, VerifiedToken } from "../ports.js";
import type { FleetIndex } from "./journal.js";
import { fleetIdOf, isDnsName, isSha256 } from "./policy.js";
import {
	type Account,
	actorOf,
	append,
	type FleetDeps,
	governed,
	isJsonObject,
	iso,
	logEvent,
	ok,
	type Person,
	pbJson,
	principalKey,
	refuse,
	subjectOf,
	textOf,
} from "./support.js";

const OCI_COMMAND_KIND = "oci-command";
const WORK_STREAM = "fleet-work-";
const DEFAULT_TTL_SECONDS = 3_600;
const MAX_TTL_SECONDS = 86_400;
const MAX_ROUNDS = 16;

function invalid<T>(message: string): Outcome<T> {
	return refuse("invalid-request", message);
}

function sha256Hex(...parts: readonly string[]): string {
	return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

function digestOf(workKey: string): string {
	return sha256Hex(OCI_COMMAND_KIND, workKey).slice(0, 32);
}

function callerOf(
	deps: FleetDeps,
	caller: VerifiedToken | undefined,
): Outcome<Person | Account> {
	if (
		caller === undefined ||
		(caller.kind !== "person" && caller.kind !== "account")
	)
		return refuse(
			"unauthenticated",
			"submitting work needs a person or an account credential",
		);
	if (caller.tenant !== deps.tenant)
		return refuse("forbidden", "the credential is for another tenant");
	return ok(caller);
}

function checkRequest(request: WorkSubmissionRequest): Outcome<number> {
	if (request.image.length === 0) return invalid("image is required");
	if (!isSha256(request.imageDigest))
		return invalid("image_digest is sha256:<64 hex>");
	if (request.ttlSeconds > MAX_TTL_SECONDS)
		return invalid("submitted work lives at most 86400 seconds");
	for (const host of request.egressAllow)
		if (!isDnsName(host))
			return invalid(`egress host ${host} is not a lower-case DNS name`);
	const tier = request.needs?.minSandbox ?? SandboxTier.UNSPECIFIED;
	if (!Number.isInteger(tier) || tier < 0 || tier > SandboxTier.S3_MICROVM)
		return invalid("needs.min_sandbox is not a sandbox tier");
	if (Object.keys(request.env).some((name) => name.length === 0))
		return invalid("env names are non-empty");
	return ok(
		request.ttlSeconds === 0 ? DEFAULT_TTL_SECONDS : request.ttlSeconds,
	);
}

function canonical(request: WorkSubmissionRequest): Uint8Array {
	const env: Record<string, string> = {};
	for (const name of Object.keys(request.env).sort())
		env[name] = request.env[name] ?? "";
	return toBinary(
		WorkSubmissionRequestSchema,
		create(WorkSubmissionRequestSchema, { ...request, env }),
	);
}

type Journalled = Readonly<{
	envelope: SignedEnvelope;
	submittedAt: string;
	expiresAtMs: number;
}>;

async function journalledSubmission(
	deps: FleetDeps,
	stream: string,
): Promise<Readonly<{ seq: number; found: Journalled | undefined }>> {
	let seq = 0;
	let found: Journalled | undefined;
	for await (const event of deps.store.read(stream)) {
		seq = event.seq;
		if (event.type === "fleet.WorkSubmitted") found = parse(event);
	}
	return { seq, found };
}

function parse(event: EventEnvelope): Journalled | undefined {
	const data = isJsonObject(event.data) ? event.data : undefined;
	const envelope = data?.envelope;
	if (data === undefined || !isJsonObject(envelope)) return undefined;
	const expiresAtMs = Date.parse(textOf(data, "expiresAt"));
	return {
		envelope: fromJson(SignedEnvelopeSchema, envelope, {
			ignoreUnknownFields: true,
		}),
		submittedAt: textOf(data, "submittedAt"),
		expiresAtMs: Number.isNaN(expiresAtMs) ? 0 : expiresAtMs,
	};
}

function statusOf(
	submissionId: string,
	digest: string,
	updatedAt: string,
): WorkStatus {
	return create(WorkStatusSchema, {
		submissionId,
		workDigest: digest,
		memberId: "",
		status: ReceiptStatus.UNSPECIFIED,
		updatedAt,
	});
}

export function createSubmitter(
	deps: FleetDeps,
	fleets: () => Promise<FleetIndex>,
): (
	request: WorkSubmissionRequest,
	caller: VerifiedToken | undefined,
) => Promise<Outcome<WorkStatus>> {
	const unpublished = new Set<string>();

	const publish = async (
		envelope: SignedEnvelope,
		fleet: FleetId,
		submissionId: string,
	): Promise<boolean> => {
		try {
			await deps.bus.submissions.publish(envelope, fleet);
			unpublished.delete(submissionId);
			return true;
		} catch {
			unpublished.add(submissionId);
			return false;
		}
	};

	return async (request, token) => {
		const caller = callerOf(deps, token);
		if (!caller.ok) return caller;
		const id = fleetIdOf(request.fleet, "fleet");
		if (!id.ok) return id;
		const ttl = checkRequest(request);
		if (!ttl.ok) return ttl;
		const fleet = (await fleets()).get(id.value);
		if (fleet === undefined || fleet.record.tenant !== deps.tenant)
			return refuse("fleet-unknown", `no fleet ${request.fleet}`, {
				fleet: request.fleet,
			});
		const policy = fleet.record.policy;
		if (fleet.record.coordination !== CoordinationMode.MANY_ACTIVE)
			return refuse("fleet-policy", "only many-active fleets take work", {
				rule: "coordination",
			});
		if (!(policy?.workKinds ?? []).includes(OCI_COMMAND_KIND))
			return refuse(
				"fleet-policy",
				"the fleet does not take oci-command work",
				{
					rule: "work-kind",
				},
			);
		const allowed = new Set(policy?.egressAllow ?? []);
		const outside = request.egressAllow.find((host) => !allowed.has(host));
		if (outside !== undefined)
			return refuse("fleet-policy", `egress to ${outside} is not allowed`, {
				rule: "egress",
			});
		const decision = await governed(
			deps,
			subjectOf(caller.value),
			"fleet.work.submit",
			{ kind: "fleet", id: id.value, fleet: id.value },
		);
		if (!decision.ok) return decision;

		const author = principalKey(caller.value.principal);
		const base = createHash("sha256")
			.update(`${deps.tenant}\u0000${author}\u0000`)
			.update(canonical(request))
			.digest("hex");
		let generation = 0;
		for (let round = 0; round < MAX_ROUNDS; round += 1) {
			const submissionId = sha256Hex(base, String(generation)).slice(0, 32);
			const digest = digestOf(submissionId);
			const stream = `${WORK_STREAM}${digest}`;
			const nowMs = deps.now();
			const earlier = await journalledSubmission(deps, stream);
			if (earlier.found !== undefined) {
				if (earlier.found.expiresAtMs <= nowMs) {
					generation += 1;
					continue;
				}
				if (
					unpublished.has(submissionId) &&
					!(await publish(earlier.found.envelope, id.value, submissionId))
				)
					return refuse("unavailable", "the submission could not be published");
				return ok(statusOf(submissionId, digest, earlier.found.submittedAt));
			}
			if (earlier.seq > 0) {
				generation += 1;
				continue;
			}
			const submission = create(WorkSubmissionSchema, {
				submissionId,
				tenant: deps.tenant,
				fleet: id.value,
				author,
				image: request.image,
				imageDigest: request.imageDigest,
				argv: [...request.argv],
				env: { ...request.env },
				needs: request.needs,
				egressAllow: [...request.egressAllow],
				submittedAt: iso(nowMs),
				expiresAt: iso(nowMs + ttl.value * 1_000),
			});
			const envelope = await signEnvelope(
				deps.recordSigner,
				WORK_SUBMISSION_CONTEXT,
				toBinary(WorkSubmissionSchema, submission),
			);
			const appended = await append(
				deps,
				stream,
				0,
				[
					{
						type: "fleet.WorkSubmitted",
						data: {
							subject: stream,
							subjectSequence: 0,
							submissionId,
							workDigest: digest,
							fleet: id.value,
							kind: OCI_COMMAND_KIND,
							workKey: submissionId,
							author,
							submittedAt: submission.submittedAt,
							expiresAt: submission.expiresAt,
							submission: pbJson(toJson(WorkSubmissionSchema, submission)),
							envelope: pbJson(toJson(SignedEnvelopeSchema, envelope)),
						},
					},
				],
				actorOf(caller.value),
			);
			if (appended === "conflict") continue;
			logEvent(deps, "fleet.WorkSubmitted", stream);
			if (!(await publish(envelope, id.value, submissionId)))
				return refuse("unavailable", "the submission could not be published");
			return ok(statusOf(submissionId, digest, submission.submittedAt));
		}
		return refuse(
			"conflict",
			"another writer kept winning the compare-and-set",
		);
	};
}
