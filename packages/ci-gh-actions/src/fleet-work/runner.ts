/**
 * The executor half of `github-actions-job` (design §6.9 table and step 7):
 * in the order's fresh sandbox, writes the runner registration with
 * `Sandbox.writeSecret`, installs the pre-job hook that posts GitHub's job
 * context to the sandbox's control endpoint, and runs one just-in-time
 * runner for one job. The receipt status comes from the runner's own result
 * line and the hook's verdict. Private to L16.
 */
import { createHash } from "node:crypto";
import type { JsonValue } from "@hobo/core";
import { ReceiptStatus, type WorkRunner } from "@hobo/fleet";
import { z } from "zod";
import { RUNNER_VERSION } from "../bootstrap.js";
import {
	INSTALL_HOOK_ARGV,
	MARKER,
	preJobHookScript,
	REGISTRATION_PATH,
	START_ARGV,
	START_ENV,
} from "./hook.js";
import { GITHUB_ACTIONS_JOB } from "./kind.js";

/** GitHub's own runner image at the pinned runner version (`bootstrap.ts`). */
// public-contract: the image every github-actions-job order names in parameters.image.
export const GITHUB_RUNNER_IMAGE = `ghcr.io/actions/actions-runner:${RUNNER_VERSION}`;

/**
 * The hosts a just-in-time runner talks to (GitHub's documented self-hosted
 * runner communication list, exact names only); the fleet's own allowlist is
 * added by the egress proxy.
 */
// public-contract: exact egress hosts every github-actions-job order allows.
export const GITHUB_EGRESS: readonly string[] = [
	"github.com",
	"api.github.com",
	"codeload.github.com",
	"objects.githubusercontent.com",
	"raw.githubusercontent.com",
	"pkg.actions.githubusercontent.com",
	"broker.actions.githubusercontent.com",
	"pipelines.actions.githubusercontent.com",
	"results-receiver.actions.githubusercontent.com",
	"token.actions.githubusercontent.com",
	"vstoken.actions.githubusercontent.com",
	...Array.from(
		{ length: 20 },
		(_, index) => `productionresultssa${index}.blob.core.windows.net`,
	),
];

/** How much of the runner's console is kept to read its result line and the markers. */
const TAIL_BYTES = 64 * 1024;

type Verdict = Readonly<{
	fence: string | undefined;
	observedWorkKey: string;
	result: string | undefined;
	exit: number | undefined;
}>;

function lastMatch(text: string, pattern: RegExp): string | undefined {
	let found: string | undefined;
	for (const match of text.matchAll(pattern)) found = match[1];
	return found;
}

const Observed = z.object({ workKey: z.string() });

function workKeyOf(json: string | undefined): string {
	if (json === undefined || json === "") return "";
	try {
		const value: JsonValue = JSON.parse(json);
		const parsed = Observed.safeParse(value);
		return parsed.success ? parsed.data.workKey : "";
	} catch {
		return "";
	}
}

/** Reads the start script's `@@hobo-fleet` lines and the runner's "Job … completed with result: …" line. */
export function readVerdict(output: string): Verdict {
	const exit = lastMatch(output, new RegExp(`^${MARKER} exit (\\d+)$`, "gmu"));
	return {
		fence: lastMatch(output, new RegExp(`^${MARKER} fence (\\w+)$`, "gmu")),
		observedWorkKey: workKeyOf(
			lastMatch(output, new RegExp(`^${MARKER} observed (.*)$`, "gmu")),
		),
		result: lastMatch(
			output,
			/^.*\bJob .* completed with result: (\w+)\s*$/gmu,
		),
		exit: exit === undefined ? undefined : Number(exit),
	};
}

/** domain-view: the two receipt fields a run's outcome decides. */
type Settled = Readonly<{ status: ReceiptStatus; reason: string }>;

function statusOf(verdict: Verdict, aborted: boolean): Settled {
	if (aborted) return { status: ReceiptStatus.CANCELLED, reason: "" };
	if (verdict.fence === "refuse")
		return { status: ReceiptStatus.REFUSED, reason: "assignment-mismatch" };
	switch (verdict.result?.toLowerCase()) {
		case "succeeded":
			return { status: ReceiptStatus.SUCCEEDED, reason: "" };
		case "failed":
			return { status: ReceiptStatus.FAILED, reason: "" };
		case "canceled":
		case "cancelled":
			return { status: ReceiptStatus.CANCELLED, reason: "" };
		default:
			// No job ran: the runner never started, or GitHub gave it nothing.
			return { status: ReceiptStatus.ABANDONED, reason: "unavailable" };
	}
}

export function githubActionsRunner(): WorkRunner {
	return {
		kind: GITHUB_ACTIONS_JOB,
		async run(input) {
			const { sandbox, signal } = input;
			const nothing = (status: ReceiptStatus, reason: string) => ({
				status,
				reason,
				outputDigest: "",
				observedWorkKey: "",
			});
			if (signal.aborted) return nothing(ReceiptStatus.CANCELLED, "");
			if (input.secret.length === 0)
				return nothing(ReceiptStatus.REFUSED, "order-invalid");
			await sandbox.writeSecret(REGISTRATION_PATH, input.secret);
			const installed = await sandbox.exec({
				argv: INSTALL_HOOK_ARGV,
				env: {},
				stdin: new TextEncoder().encode(preJobHookScript(sandbox.controlUrl)),
				signal,
				onOutput: () => undefined,
			});
			if (installed.exitCode !== 0)
				return signal.aborted
					? nothing(ReceiptStatus.CANCELLED, "")
					: nothing(ReceiptStatus.ABANDONED, "unavailable");
			const hash = createHash("sha256");
			const decoder = new TextDecoder();
			let tail = "";
			await sandbox.exec({
				argv: START_ARGV,
				env: START_ENV,
				signal,
				onOutput(chunk) {
					hash.update(chunk);
					tail = (tail + decoder.decode(chunk, { stream: true })).slice(
						-TAIL_BYTES,
					);
					input.onLog(chunk);
				},
			});
			tail += decoder.decode();
			const verdict = readVerdict(tail);
			const { status, reason } = statusOf(verdict, signal.aborted);
			return {
				status,
				reason,
				outputDigest: `sha256:${hash.digest("hex")}`,
				observedWorkKey: verdict.observedWorkKey,
			};
		},
	};
}
