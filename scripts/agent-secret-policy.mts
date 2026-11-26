import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import * as z from "zod";
import {
	gitSessionContext,
	sessionPolicyRefusal,
} from "./agent-session-policy.mts";
import {
	isSecretFile,
	OWNER_STORE_PATH,
	storingCommandIn,
} from "./check-secret-storage.mts";

export type HookFormat = "claude" | "codex" | "cursor" | "copilot";

const CREDENTIAL_STORING_TOOLS =
	/(?:^|__)(?:request_credential|create_project_env|edit_project_env|create_edge_function_secret)$|1password/iu;
const PATCHED_FILE = /^\*\*\* (?:Add|Update|Move to|Delete) File: (.+)$/gmu;

const ToolInput = z
	.object({
		command: z.union([z.string(), z.array(z.string())]).optional(),
		cmd: z.union([z.string(), z.array(z.string())]).optional(),
		file_path: z.string().optional(),
		path: z.string().optional(),
		target_file: z.string().optional(),
		notebook_path: z.string().optional(),
		patch: z.string().optional(),
		input: z.string().optional(),
		head: z.string().optional(),
	})
	.loose();

export const HookEvent = z
	.object({
		tool_name: z.string().optional(),
		toolName: z.string().optional(),
		tool_input: z.union([ToolInput, z.string()]).optional(),
		toolArgs: z.union([ToolInput, z.string()]).optional(),
		command: z.string().optional(),
		cwd: z.string().optional(),
	})
	.loose();

function toolInput(
	raw: z.infer<typeof ToolInput> | string | undefined,
): z.infer<typeof ToolInput> {
	if (raw === undefined) return {};
	const structured = ToolInput.safeParse(raw);
	if (structured.success) return structured.data;
	const text = String(raw);
	try {
		const fromJson = ToolInput.safeParse(JSON.parse(text));
		if (fromJson.success) return fromJson.data;
	} catch {
		return { command: text };
	}
	return { command: text };
}

function joined(value: string | readonly string[] | undefined): string[] {
	return value === undefined ? [] : [[value].flat().join(" ")];
}

export type HookEvent = z.infer<typeof HookEvent>;
export type HookResponse = Readonly<{
	stdout: string;
	stderr: string;
	exitCode: number;
}>;

export function secretPolicyRefusal(event: HookEvent): string | undefined {
	const tool = event.tool_name ?? event.toolName ?? "";
	if (CREDENTIAL_STORING_TOOLS.test(tool))
		return `${tool} stores a credential outside HoBo's owner store. ${OWNER_STORE_PATH}`;
	const input = toolInput(event.tool_input ?? event.toolArgs);
	const commands = [
		...joined(event.command),
		...joined(input.command),
		...joined(input.cmd),
	];
	for (const command of commands) {
		const what = storingCommandIn(command);
		if (what !== undefined) return `This command ${what}. ${OWNER_STORE_PATH}`;
	}
	const patches = [input.patch, input.input, ...commands].filter(
		(text) => text !== undefined,
	);
	const files = [
		input.file_path,
		input.path,
		input.target_file,
		input.notebook_path,
		...patches.flatMap((text) =>
			[...text.matchAll(PATCHED_FILE)].map((match) => match[1]?.trim()),
		),
	].filter((file) => file !== undefined && file !== "");
	for (const file of files)
		if (file !== undefined && isSecretFile(file.replaceAll("\\", "/")))
			return `${file} is a secret or credential file, which agents never create or edit. ${OWNER_STORE_PATH}`;
	return sessionPolicyRefusal(tool, input.head, commands, () =>
		gitSessionContext(event.cwd ?? process.cwd()),
	);
}

export function respond(
	format: HookFormat,
	refusal: string | undefined,
): HookResponse {
	if (refusal === undefined) return { stdout: "", stderr: "", exitCode: 0 };
	if (format === "cursor")
		return {
			stdout: JSON.stringify({
				permission: "deny",
				user_message: refusal,
				agent_message: refusal,
			}),
			stderr: refusal,
			exitCode: 2,
		};
	if (format === "copilot")
		return {
			stdout: JSON.stringify({
				permissionDecision: "deny",
				permissionDecisionReason: refusal,
			}),
			stderr: "",
			exitCode: 0,
		};
	return { stdout: "", stderr: `${refusal}\n`, exitCode: 2 };
}

function main(args: readonly string[]): number {
	const format = z
		.enum(["claude", "codex", "cursor", "copilot"])
		.catch("claude")
		.parse(
			args
				.find((arg) => arg.startsWith("--format="))
				?.slice("--format=".length),
		);
	let text: string;
	try {
		text = readFileSync(0, "utf8");
	} catch {
		return 0;
	}
	const event = HookEvent.safeParse(
		z
			.string()
			.transform((raw, context) => {
				try {
					return JSON.parse(raw);
				} catch {
					context.addIssue({ code: "custom", message: "not JSON" });
					return z.NEVER;
				}
			})
			.safeParse(text).data,
	);
	if (!event.success) return 0;
	const response = respond(format, secretPolicyRefusal(event.data));
	process.stdout.write(response.stdout);
	process.stderr.write(response.stderr);
	return response.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	process.exitCode = main(process.argv.slice(2));
