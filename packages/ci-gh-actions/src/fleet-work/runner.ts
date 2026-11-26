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

export const GITHUB_RUNNER_IMAGE = `ghcr.io/actions/actions-runner:${RUNNER_VERSION}`;

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

const TAIL_BYTES = 64 * 1024;

// domain-view: what the start script's marker lines say about one run.
export type Verdict = Readonly<{
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

export function settleVerdict(verdict: Verdict, aborted: boolean): Settled {
	if (aborted) return { status: ReceiptStatus.CANCELLED, reason: "" };
	switch (verdict.fence) {
		case "refuse":
			return { status: ReceiptStatus.REFUSED, reason: "assignment-mismatch" };
		case "conflict":
			return { status: ReceiptStatus.REFUSED, reason: "conflict" };
		case "unreachable":
			return { status: ReceiptStatus.ABANDONED, reason: "unavailable" };
	}
	switch (verdict.result?.toLowerCase()) {
		case "succeeded":
			return { status: ReceiptStatus.SUCCEEDED, reason: "" };
		case "failed":
			return { status: ReceiptStatus.FAILED, reason: "" };
		case "canceled":
		case "cancelled":
			return { status: ReceiptStatus.CANCELLED, reason: "" };
		default:
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
			const { status, reason } = settleVerdict(verdict, signal.aborted);
			return {
				status,
				reason,
				outputDigest: `sha256:${hash.digest("hex")}`,
				observedWorkKey: verdict.observedWorkKey,
			};
		},
	};
}
