// Attach the relay's Marketplace bindings, idempotently (ADR-0179 phase 6).
//
// The relay's Yard names, for each binding the Vercel Marketplace attaches,
// the integration's slug and one resource name per team. Before a deploy,
// `hobo ci deploy --provision` makes sure that resource exists and is
// connected to the project, with the Vercel CLI and the deploy token, and
// nothing else:
//
// 1. `vercel integration list <project> --integration <slug> --json`: when the
//    resource is listed for the project, it is connected; nothing to do.
// 2. `vercel integration list --all --integration <slug> --json`: when the team
//    has the resource but the project does not, connect it for the target's
//    environment (`vercel integration resource connect … --yes`).
// 3. Otherwise provision it, connected to the project for the target's
//    environment (`vercel integration add <slug> --name <resource> -e <target>
//    --no-env-pull --non-interactive`).
//
// The CLI reads the token from `VERCEL_TOKEN` and the team and project from
// `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` in its environment; none is on a
// command line. Its output is parsed for resource names and never printed.
//
// What it cannot do: accept an integration's terms for the team. Vercel's
// `vercel integration accept-terms` needs a person at a terminal, so the first
// install of an integration on the team is a one-time owner step
// (`packages/ci-vercel/CONFIG-SERVICE.md`). Until then step 3 fails, the
// attachment reports `failed`, and the deploy goes ahead: the relay reports a
// missing cache on `/readyz`.
//
// HONEST SCOPE: exercised against a fake CLI only. The JSON shape of
// `vercel integration list --json` is read defensively (any object with the
// resource's `name`), not from a published schema.

import type { MarketplaceAttachment, RelayTarget } from "./ci-relay-yard.js";
import { isJsonArray, isJsonObject, type JsonValue } from "./json.js";

// One CLI invocation: its arguments, after the executable.
export type VercelCliArgs = readonly string[];

export interface VercelCliResult {
	readonly code: number;
	readonly stdout: string;
}

// Runs the Vercel CLI with these arguments and the environment the caller
// gives (the token among it). Injected in tests.
export type VercelCliRunner = (args: VercelCliArgs) => Promise<VercelCliResult>;

export type AttachmentOutcome = "present" | "connected" | "created" | "failed";

export interface AttachmentResult {
	readonly attachment: MarketplaceAttachment;
	readonly outcome: AttachmentOutcome;
	// Why it failed, in fixed words; never the CLI's output.
	readonly reason?: string;
}

// The commands a provisioning run may send, in order, as a dry run lists
// them. Each after the first is sent only on the condition it states.
export function planRelayProvisioning(
	attachments: readonly MarketplaceAttachment[],
	project: string,
	target: RelayTarget,
): readonly { readonly args: VercelCliArgs; readonly when: string }[] {
	return attachments.flatMap((attachment) => [
		{
			args: listArgs(attachment, project),
			when: `always: is ${attachment.resource} connected to ${project}`,
		},
		{
			args: listAllArgs(attachment),
			when: `if not: does the team have ${attachment.resource}`,
		},
		{
			args: connectArgs(attachment, project, target),
			when: `if the team has it: connect it to ${project} for ${target}`,
		},
		{
			args: addArgs(attachment, target),
			when: `if the team has none: provision it, connected to ${project} for ${target}`,
		},
	]);
}

function listArgs(attachment: MarketplaceAttachment, project: string) {
	return [
		"integration",
		"list",
		project,
		"--integration",
		integrationOf(attachment),
		"--json",
	];
}

function listAllArgs(attachment: MarketplaceAttachment) {
	return [
		"integration",
		"list",
		"--all",
		"--integration",
		integrationOf(attachment),
		"--json",
	];
}

function connectArgs(
	attachment: MarketplaceAttachment,
	project: string,
	target: RelayTarget,
) {
	return [
		"integration",
		"resource",
		"connect",
		attachment.resource,
		project,
		"--environment",
		target,
		"--yes",
		"--json",
	];
}

function addArgs(attachment: MarketplaceAttachment, target: RelayTarget) {
	return [
		"integration",
		"add",
		attachment.integration,
		"--name",
		attachment.resource,
		"--environment",
		target,
		"--no-env-pull",
		"--non-interactive",
		"--json",
	];
}

// `upstash/upstash-kv` is a product of the `upstash` integration; listing
// filters by the integration.
function integrationOf(attachment: MarketplaceAttachment): string {
	return attachment.integration.split("/")[0] ?? attachment.integration;
}

// Whether a `--json` listing names the resource anywhere.
function listsResource(stdout: string, resource: string): boolean | undefined {
	let parsed: JsonValue;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return undefined;
	}
	const seen = (value: JsonValue): boolean => {
		if (isJsonArray(value)) return value.some(seen);
		if (!isJsonObject(value)) return false;
		if (value.name === resource) return true;
		return Object.values(value).some(seen);
	};
	return seen(parsed);
}

// Attach each binding; one that fails does not stop the others.
export async function provisionRelayAttachments(input: {
	readonly attachments: readonly MarketplaceAttachment[];
	readonly project: string;
	readonly target: RelayTarget;
	readonly run: VercelCliRunner;
}): Promise<readonly AttachmentResult[]> {
	const results: AttachmentResult[] = [];
	for (const attachment of input.attachments) {
		results.push(await provisionOne(attachment, input));
	}
	return results;
}

async function provisionOne(
	attachment: MarketplaceAttachment,
	input: {
		readonly project: string;
		readonly target: RelayTarget;
		readonly run: VercelCliRunner;
	},
): Promise<AttachmentResult> {
	const failed = (reason: string): AttachmentResult => ({
		attachment,
		outcome: "failed",
		reason,
	});
	try {
		const listed = await input.run(listArgs(attachment, input.project));
		if (listed.code !== 0)
			return failed("the Vercel CLI could not list the project's resources");
		const connected = listsResource(listed.stdout, attachment.resource);
		if (connected === undefined)
			return failed("the Vercel CLI listing was not JSON");
		if (connected) return { attachment, outcome: "present" };

		const team = await input.run(listAllArgs(attachment));
		if (team.code !== 0)
			return failed("the Vercel CLI could not list the team's resources");
		const exists = listsResource(team.stdout, attachment.resource);
		if (exists === undefined)
			return failed("the Vercel CLI listing was not JSON");
		if (exists) {
			const connect = await input.run(
				connectArgs(attachment, input.project, input.target),
			);
			return connect.code === 0
				? { attachment, outcome: "connected" }
				: failed("the Vercel CLI could not connect the resource");
		}
		const add = await input.run(addArgs(attachment, input.target));
		return add.code === 0
			? { attachment, outcome: "created" }
			: failed(
					"the Vercel CLI could not provision the resource (has the owner accepted the integration's terms for the team?)",
				);
	} catch {
		return failed("the Vercel CLI did not run");
	}
}

// `upstash/upstash-kv:hobo-ci-cache=created`, comma-joined: names only.
export function describeAttachments(
	results: readonly AttachmentResult[],
): string {
	return results
		.map(
			(result) =>
				`${result.attachment.integration}:${result.attachment.resource}=${result.outcome}`,
		)
		.join(",");
}
