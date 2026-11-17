import { remoteInfeasible } from "./remote-reach.js";

/**
 * What an owner who is not at this box can do next with what a run showed
 * them. They have a browser on their own device and the agent's chat (with
 * the host's structured asks); they cannot reach the box's 127.0.0.1, open
 * its terminal or run anything on it. The one classifier the ceremony's
 * specs, its transcript audit and its spec model all use.
 */

export type OwnerAction =
	| { readonly kind: "store-choice" }
	| {
			readonly kind: "sign-in";
			readonly url: URL;
			readonly capture: string;
	  }
	| { readonly kind: "credential"; readonly host: string }
	/** HoBo MCP App secret forms, one per value the waiting run named. */
	| { readonly kind: "capture"; readonly names: readonly string[] }
	| { readonly kind: "device"; readonly line: string }
	| { readonly kind: "bitwarden-approve"; readonly line: string }
	/** The agent runs the ceremony through the HoBo MCP server instead. */
	| { readonly kind: "use-mcp" }
	/** Nothing for the owner to do: the agent runs again (a transient refusal). */
	| { readonly kind: "run-again" };

export type OwnerStep =
	| { readonly kind: "ready" }
	| { readonly kind: "act"; readonly action: OwnerAction }
	| {
			readonly kind: "dead-end";
			readonly reason: string;
			readonly lines: readonly string[];
	  };

const SIGN_IN = /HOBO_OWNER_SIGN_IN url=(\S+) capture=(\S+)/u;
const CREDENTIAL = /^HOBO_OWNER_CREDENTIAL host=(\S+)/u;
const CAPTURE = /^HOBO_OWNER_CAPTURE name=(\S+) guide=(\S+)/u;
const STORE_CHOICE = /^HOBO_C[ID]_STORE_CHOICE$|HOBO_OWNER_STORE_CHOICE/u;
const DEVICE = /^HOBO_OWNER_DEVICE\b/u;
const BITWARDEN_APPROVE = /^HOBO_OWNER_BITWARDEN_APPROVE\b/u;
const PUBLIC_STAND_IN = "https://provider.example";
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/u;

/** What a remote owner can do next with what the run showed. */
export function readOwnerTurn(
	ready: boolean,
	shown: readonly string[],
	/** Test servers standing in for a provider's public site (its https origin). */
	publicOrigins: readonly string[] = [],
): OwnerStep {
	const lines = shown.map((line) =>
		publicOrigins.reduce(
			(text, origin) => text.split(origin).join(PUBLIC_STAND_IN),
			line,
		),
	);
	const infeasible = remoteInfeasible(lines);
	if (infeasible.length > 0)
		return {
			kind: "dead-end",
			reason:
				"The run told a remote owner to do something only possible at the box.",
			lines: infeasible,
		};
	if (ready) return { kind: "ready" };
	const captures: string[] = [];
	for (const line of lines) {
		const capture = CAPTURE.exec(line);
		if (capture === null) continue;
		const guide = new URL(capture[2] ?? "");
		if (guide.protocol !== "https:" || LOOPBACK.test(guide.hostname))
			return {
				kind: "dead-end",
				reason: "A guide page the owner's browser cannot open.",
				lines: [line],
			};
		captures.push(capture[1] ?? "");
	}
	if (captures.length > 0)
		return { kind: "act", action: { kind: "capture", names: captures } };
	for (const line of lines) {
		const signIn = SIGN_IN.exec(line);
		if (signIn !== null) {
			const url = new URL(signIn[1] ?? "");
			if (url.protocol !== "https:" || LOOPBACK.test(url.hostname))
				return {
					kind: "dead-end",
					reason: "A sign-in link the owner's browser cannot open.",
					lines: [line],
				};
			return {
				kind: "act",
				action: { kind: "sign-in", url, capture: signIn[2] ?? "" },
			};
		}
		const credential = CREDENTIAL.exec(line);
		if (credential !== null)
			return {
				kind: "act",
				action: { kind: "credential", host: credential[1] ?? "" },
			};
		if (STORE_CHOICE.test(line))
			return { kind: "act", action: { kind: "store-choice" } };
		if (DEVICE.test(line))
			return { kind: "act", action: { kind: "device", line } };
		if (BITWARDEN_APPROVE.test(line))
			return { kind: "act", action: { kind: "bitwarden-approve", line } };
	}
	if (lines.some((line) => /through the HoBo MCP server/u.test(line)))
		return { kind: "act", action: { kind: "use-mcp" } };
	// A form the owner declined or closed: the agent asks again.
	if (
		lines.some((line) => /\b(Ask again with|call) capture_secret\b/u.test(line))
	)
		return { kind: "act", action: { kind: "run-again" } };
	// "Run again", or "Run hobo cd up --hand-off again": the agent's own step.
	if (
		lines.some((line) =>
			/^Run (hobo [\w-]+ [\w-]+( --hand-off)? )?again\b/u.test(line),
		)
	)
		return { kind: "act", action: { kind: "run-again" } };
	return {
		kind: "dead-end",
		reason: "The run refused with nothing a remote owner can act on.",
		lines,
	};
}
