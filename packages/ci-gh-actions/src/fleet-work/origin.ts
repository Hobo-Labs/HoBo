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
