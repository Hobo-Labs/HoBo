
import type { MarketplaceAttachment, RelayTarget } from "./ci-relay-yard.js";
import { isJsonArray, isJsonObject, type JsonValue } from "./json.js";

export type VercelCliArgs = readonly string[];

export interface VercelCliResult {
	readonly code: number;
	readonly stdout: string;
}

export type VercelCliRunner = (args: VercelCliArgs) => Promise<VercelCliResult>;

export type AttachmentOutcome = "present" | "connected" | "created" | "failed";

export interface AttachmentResult {
	readonly attachment: MarketplaceAttachment;
	readonly outcome: AttachmentOutcome;
	readonly reason?: string;
}

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

function integrationOf(attachment: MarketplaceAttachment): string {
	return attachment.integration.split("/")[0] ?? attachment.integration;
}

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
