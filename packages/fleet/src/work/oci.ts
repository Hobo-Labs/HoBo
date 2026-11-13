/**
 * The `oci-command` work kind (design §6.9 table): the dispatcher half reads
 * the authority-signed submissions of its fleets from `FLEET_SUBMISSIONS` and
 * offers them; the executor half runs the submitted command in the sandbox,
 * which the executor created from the submission's image, publishing its
 * output as log chunks and its SHA-256 as the output digest. Private to L04.
 */
import { createHash } from "node:crypto";
import { create, fromBinary } from "@bufbuild/protobuf";
import type { JsonValue } from "@hobo/core";
import {
	type FleetRecord,
	ReceiptStatus,
	type SignedEnvelope,
	WorkNeedsSchema,
	WorkOrigin,
	type WorkSubmission,
	WorkSubmissionSchema,
} from "../_generated/fleet_pb.js";
import { parseFleetId } from "../ids.js";
import type {
	FleetBus,
	Subscription,
	UpstreamWork,
	WorkRunner,
	WorkSource,
} from "../ports.js";
import { OCI_COMMAND } from "./checks.js";
import { authoritySigned } from "./signed.js";

type Pending = Readonly<{
	submission: WorkSubmission;
	envelope: SignedEnvelope;
}>;

function decodeSubmission(
	envelope: SignedEnvelope,
): WorkSubmission | undefined {
	try {
		return fromBinary(WorkSubmissionSchema, envelope.payload);
	} catch {
		return undefined;
	}
}

function isText(value: JsonValue | undefined): value is string {
	return Object.prototype.toString.call(value) === "[object String]";
}

function parseJson(text: string | undefined): JsonValue | undefined {
	if (text === undefined) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** The `argv` parameter: a JSON array of strings. */
function parseList(text: string | undefined): readonly string[] | undefined {
	const value = parseJson(text);
	if (!Array.isArray(value)) return undefined;
	const out: string[] = [];
	for (const entry of value) {
		if (!isText(entry)) return undefined;
		out.push(entry);
	}
	return out;
}

/** The `env` parameter: a JSON object of strings; anything else is left out. */
function parseEnv(text: string | undefined) {
	const value = parseJson(text);
	const pairs: [string, string][] = [];
	if (
		value !== undefined &&
		value !== null &&
		Object.prototype.toString.call(value) === "[object Object]" &&
		!Array.isArray(value) &&
		!isText(value)
	)
		for (const [key, entry] of Object.entries(value))
			if (isText(entry)) pairs.push([key, entry]);
	return Object.fromEntries(pairs);
}

export function ociSource(bus: FleetBus): WorkSource {
	const pending = new Map<string, Pending>();
	const taken = new Set<string>();
	const subscriptions = new Map<string, Subscription>();

	const live = (submission: WorkSubmission) =>
		Date.parse(submission.expiresAt) > Date.now();

	return {
		kind: OCI_COMMAND,
		async poll(fleet: FleetRecord): Promise<readonly UpstreamWork[]> {
			const id = parseFleetId(fleet.fleetId);
			if (!subscriptions.has(id))
				subscriptions.set(
					id,
					bus.submissions.subscribe([id], "start", async (envelope) => {
						const submission = decodeSubmission(envelope);
						if (
							submission === undefined ||
							submission.fleet !== id ||
							!authoritySigned(envelope, bus.registry.trust()) ||
							taken.has(submission.submissionId)
						)
							return;
						pending.set(submission.submissionId, { submission, envelope });
					}),
				);
			const works: UpstreamWork[] = [];
			for (const [key, entry] of pending) {
				if (!live(entry.submission)) {
					pending.delete(key);
					continue;
				}
				if (entry.submission.fleet !== id) continue;
				const submittedAt = Date.parse(entry.submission.submittedAt);
				works.push({
					workKey: entry.submission.submissionId,
					label: entry.submission.needs?.labels[0] ?? "",
					needs: entry.submission.needs ?? create(WorkNeedsSchema),
					author: entry.submission.author,
					// The authority authenticated the submitter; it is not fork work.
					origin: WorkOrigin.INTERNAL,
					repository: "",
					ref: "",
					workflowDigest: "",
					queuedAtMs: Number.isFinite(submittedAt) ? submittedAt : Date.now(),
					submission: entry.envelope,
				});
			}
			return works;
		},
		async prepare(offer) {
			const entry = pending.get(offer.workKey);
			if (entry === undefined || !live(entry.submission))
				return {
					ok: false,
					error: { code: "work-unknown", message: "the submission is gone" },
				};
			taken.add(offer.workKey);
			pending.delete(offer.workKey);
			const { submission } = entry;
			return {
				ok: true,
				value: {
					parameters: {
						image: submission.imageDigest
							? `${submission.image}@${submission.imageDigest}`
							: submission.image,
						argv: JSON.stringify(submission.argv),
						env: JSON.stringify(submission.env),
					},
					// Submitted work carries no secret: its environment is non-secret (§7.1).
					secret: new Uint8Array(),
					egressAllow: [...submission.egressAllow],
				},
			};
		},
		async stillWanted(offer) {
			const entry = pending.get(offer.workKey);
			return entry !== undefined && live(entry.submission);
		},
	};
}

export function ociRunner(): WorkRunner {
	return {
		kind: OCI_COMMAND,
		async run(input) {
			const argv = parseList(input.order.parameters.argv);
			if (argv === undefined || argv.length === 0)
				return {
					status: ReceiptStatus.REFUSED,
					reason: "invalid-request",
					outputDigest: "",
					observedWorkKey: "",
				};
			const hash = createHash("sha256");
			const { exitCode } = await input.sandbox.exec({
				argv,
				env: parseEnv(input.order.parameters.env),
				signal: input.signal,
				onOutput(chunk) {
					hash.update(chunk);
					input.onLog(chunk);
				},
			});
			const outputDigest = `sha256:${hash.digest("hex")}`;
			if (input.signal.aborted)
				return {
					status: ReceiptStatus.CANCELLED,
					reason: "",
					outputDigest,
					observedWorkKey: "",
				};
			return {
				status: exitCode === 0 ? ReceiptStatus.SUCCEEDED : ReceiptStatus.FAILED,
				reason: "",
				outputDigest,
				observedWorkKey: "",
			};
		},
	};
}
