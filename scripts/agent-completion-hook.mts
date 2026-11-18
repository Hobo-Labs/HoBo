import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const completionReview = `Before ending, review the latest human request and its current scope. This reminder is not a new user request.

For an action request, compare the actual result and evidence with the requested outcome. If essential work remains and a concrete, safe, authorized action can advance it, take that action now. A merged change, passing subtask, failed approach, or description of the remaining work does not by itself complete the request. Consider available alternatives and independent work before reporting a blocker; do not repeat futile attempts, weaken protections, or ask again for permission already granted.

Honor an explicit stop, pause, cancellation, change of scope, or request only for an answer. Do not resume superseded work, invent unnecessary work, or proceed past a real approval, safety, or access boundary. If the active request is complete, or no useful authorized action is available, finish with an accurate response.`;

type Event = {
	conversation_id?: unknown;
	loop_count?: unknown;
	status?: unknown;
	stop_hook_active?: unknown;
};

type CursorState = {
	read: (conversation: string) => number | undefined;
	write: (conversation: string, count: number) => void;
};

export function reviewStop(
	event: Event,
	mode: "shared" | "cursor",
	state: CursorState,
): Record<string, string> {
	if (
		event.stop_hook_active === true ||
		event.status === "aborted" ||
		event.status === "error"
	) {
		return {};
	}
	if (mode === "shared") {
		if (
			typeof event.conversation_id === "string" ||
			event.stop_hook_active !== false
		) {
			return {};
		}
		return { decision: "block", reason: completionReview };
	}
	if (
		event.status !== "completed" ||
		typeof event.conversation_id !== "string" ||
		event.conversation_id.length === 0 ||
		typeof event.loop_count !== "number" ||
		!Number.isSafeInteger(event.loop_count) ||
		event.loop_count < 0
	) {
		return {};
	}
	const previous = state.read(event.conversation_id);
	state.write(event.conversation_id, event.loop_count);
	return (previous === undefined && event.loop_count > 0) ||
		(previous !== undefined && event.loop_count > previous)
		? {}
		: { followup_message: completionReview };
}

function cursorState(): CursorState {
	const uid = typeof process.getuid === "function" ? process.getuid() : "user";
	const directory = join(tmpdir(), `hobo-agent-completion-${uid}`);
	const prepare = () => {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const info = lstatSync(directory);
		if (!info.isDirectory()) throw new Error("Invalid completion state directory");
		if (typeof uid === "number" && (info.uid !== uid || (info.mode & 0o077) !== 0)) {
			throw new Error("Insecure completion state directory");
		}
	};
	const path = (conversation: string) =>
		join(directory, createHash("sha256").update(conversation).digest("hex"));
	return {
		read(conversation) {
			prepare();
			try {
				const value = readFileSync(path(conversation), "utf8");
				if (!/^\d+$/.test(value)) return undefined;
				const count = Number(value);
				return Number.isSafeInteger(count) ? count : undefined;
			} catch {
				return undefined;
			}
		},
		write(conversation, count) {
			prepare();
			writeFileSync(path(conversation), String(count), { mode: 0o600 });
		},
	};
}

function main(): void {
	try {
		const parsed: unknown = JSON.parse(readFileSync(0, "utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			process.stdout.write("{}\n");
			return;
		}
		const mode = process.argv[2] === "cursor" ? "cursor" : "shared";
		const output = reviewStop(parsed, mode, cursorState());
		process.stdout.write(`${JSON.stringify(output)}\n`);
	} catch {
		process.stdout.write("{}\n");
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
