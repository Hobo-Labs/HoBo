import type { OwnerChannel } from "@hobo/hobo-ci";
import { type ParsedSecretCaptureSpec, secretCaptureSpec } from "@hobo/mcp";

/**
 * The owner channel of a ceremony run through the HoBo MCP server (an agent
 * on a remote dev box). The server lives across the agent's tool calls, so a
 * run that needs the owner refuses with what to do (the link to open, the
 * value to hand over), the agent shows the owner the link and the secret
 * capture form, and the value the owner submits waits here, in this
 * process's memory, until the next run takes it. It never reaches the agent,
 * chat, a file or a log, and each value is taken once.
 */
export interface McpOwnerChannel extends OwnerChannel {
	/** Hold a value the owner submitted through the capture form. */
	deposit(name: string, value: string): void;
}

export function createMcpOwnerChannel(): McpOwnerChannel {
	const held = new Map<string, string>();
	return {
		// The link travels in the run's refusal; nothing else is shown here.
		openUrl: async () => undefined,
		async captureSecret({ name }) {
			const value = held.get(name);
			held.delete(name);
			return value;
		},
		deposit(name, value) {
			held.set(name, value);
		},
	};
}

// public-contract: the capture name of Infisical's copied CLI session.
export const INFISICAL_CLI_SESSION = "INFISICAL_CLI_SESSION";

/** What the owner can hand to a waiting ceremony (never to a store). */
export const OWNER_HANDOFF_SPECS: readonly ParsedSecretCaptureSpec[] =
	Object.freeze([
		secretCaptureSpec({
			name: INFISICAL_CLI_SESSION,
			target: "handoff",
			label: "Infisical sign-in (what “Copy to clipboard” copies)",
			purpose:
				'After you sign in, Infisical says "Unable to reach CLI": its Copy to clipboard button copies your session for this run. HoBo uses it once to set up its own access and keeps nothing.',
			minBytes: 20,
			maxBytes: 16384,
			charset: "printable-line",
			pattern: "^[A-Za-z0-9+/=]+$",
		}),
	]);
