/**
 * Where a GitHub run came from, by the same rule on both sides of the start
 * fence: the work source applies it to the run GitHub's REST API describes,
 * and the pre-job hook (`hook.ts`) applies it, in shell, to the job context
 * GitHub hands the runner. Private to L16.
 *
 * - Events only a repository's own writers can cause are `INTERNAL`.
 * - Pull-request events are `INTERNAL` when the head repository is the
 *   repository itself, `FORK` when it is another, and `UNKNOWN` when GitHub
 *   names none (a deleted fork).
 * - Every other event is `UNKNOWN`, which derives `UNTRUSTED` (§6.11).
 */
import { WorkOrigin } from "@hobo/fleet";

// public-contract: events whose runs only the repository's writers start (shared with the pre-job hook).
export const INTERNAL_EVENTS: readonly string[] = [
	"push",
	"schedule",
	"workflow_dispatch",
	"merge_group",
	"repository_dispatch",
	"release",
];

// public-contract: pull-request events whose head repository decides the origin (shared with the pre-job hook).
export const PULL_REQUEST_EVENTS: readonly string[] = [
	"pull_request",
	"pull_request_target",
	"pull_request_review",
	"pull_request_review_comment",
];

export function originOf(
	event: string,
	repository: string,
	headRepository: string | undefined,
): WorkOrigin {
	if (INTERNAL_EVENTS.includes(event)) return WorkOrigin.INTERNAL;
	if (!PULL_REQUEST_EVENTS.includes(event)) return WorkOrigin.UNKNOWN;
	if (headRepository === undefined || headRepository === "")
		return WorkOrigin.UNKNOWN;
	return headRepository.toLowerCase() === repository.toLowerCase()
		? WorkOrigin.INTERNAL
		: WorkOrigin.FORK;
}
