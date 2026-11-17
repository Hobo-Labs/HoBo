import { describe, expect, it } from "vitest";

import {
	ceremonyProperties,
	check,
	eventsFromWire,
	REACHES_FRONTIER,
	type WireMessage,
} from "../../src/index.js";

// SPEC: the ceremony's derived properties catch every failure this
// conversation's owner actually hit, replayed as the wire their host saw,
// and each names the step that broke it. A property that only ever passes
// proves nothing; these must fail on the bad traces and hold on the good one.

/** A JSON-RPC message's fields, as the wire carries them. */
type Rpc =
	| string
	| number
	| boolean
	| null
	| readonly Rpc[]
	| { readonly [key: string]: Rpc };
type RpcFields = { readonly [key: string]: Rpc };

let next = 0;
const toServer = (message: RpcFields): WireMessage => ({
	to: "server",
	message: JSON.stringify({ jsonrpc: "2.0", ...message }),
});
const toHost = (message: RpcFields): WireMessage => ({
	to: "host",
	message: JSON.stringify({ jsonrpc: "2.0", ...message }),
});
const call = (tool: string, args: RpcFields = {}) => {
	next += 1;
	const id = next;
	return {
		id,
		wire: toServer({
			id,
			method: "tools/call",
			params: { name: tool, arguments: args },
		}),
	};
};
const refused = (
	id: number,
	code: string,
	remediation: string[],
	message = "x",
) =>
	toHost({
		id,
		result: {
			content: [
				{
					type: "text",
					text: JSON.stringify({ ok: false, code, message, remediation }),
				},
			],
			isError: true,
		},
	});
const form = (requestId: string, message: string, links: string[] = []) =>
	toHost({
		id: requestId,
		method: "elicitation/create",
		params: {
			message,
			requestedSchema: {
				type: "object",
				properties: Object.fromEntries(
					links.map((url, at) => [
						`link${at}`,
						{ type: "string", format: "uri", default: url },
					]),
				),
			},
		},
	});
const answer = (requestId: string, action: string) =>
	toServer({ id: requestId, result: { action } });

const SIGN_IN = "https://app.infisical.com/login?callback_port=39863";
const SIGN_IN_LINE = `HOBO_OWNER_SIGN_IN url=${SIGN_IN} capture=INFISICAL_CLI_SESSION`;

function verdicts(wire: readonly WireMessage[], secrets: string[] = []) {
	const events = eventsFromWire(wire);
	return Object.fromEntries(
		[...ceremonyProperties({ secrets }), REACHES_FRONTIER].map((property) => {
			const verdict = check(property, events);
			return [verdict.property, verdict];
		}),
	);
}

describe("SPEC ceremony model: the derived properties catch the real failures", () => {
	it("holds on the ceremony done right: one cd call, every step a form with its link as a field", () => {
		const cd = call("cd");
		const result = verdicts([
			cd.wire,
			// The run asks for the sign-in itself: the link a field of the form.
			form(
				"hobo-1",
				"Sign in to Infisical. When it says Unable to reach CLI, click Copy to clipboard. — Paste what Infisical copied after you signed in.",
				[SIGN_IN],
			),
			answer("hobo-1", "accept"),
			// Vercel's approval: its link a field, submitted when done.
			form("hobo-2", "Approve HoBo CD on Vercel (code AB-12), then submit.", [
				"https://vercel.com/oauth/device?user_code=AB-12",
			]),
			answer("hobo-2", "accept"),
			refused(cd.id, "HOBO_PLAN_REJECTED", ["cd-config: no provider"]),
		]);
		for (const verdict of Object.values(result))
			expect(verdict).toMatchObject({ holds: true });
	});

	it("catches a link only in a form's text (the owner could neither click nor copy it)", () => {
		const cd = call("cd");
		const result = verdicts([
			cd.wire,
			form(
				"hobo-1",
				`Sign in to Infisical. ${SIGN_IN} — Paste what Infisical copied after you signed in.`,
			),
		]);
		expect(
			result["a form's links are fields the owner can open or copy"],
		).toMatchObject({ holds: false, at: 1 });
	});

	it("catches the live run's failure: a link the agent had to relay in chat", () => {
		const cd = call("cd");
		const result = verdicts([
			cd.wire,
			refused(cd.id, "HOBO_CD_INFISICAL_SIGN_IN", [
				SIGN_IN_LINE,
				"Then run again.",
			]),
		]);
		expect(result["owner links reach the owner in the host"]).toMatchObject({
			holds: false,
			at: 1,
		});
	});

	it("catches a device link sent only as a link prompt the host may not show, then refused to the agent", () => {
		const cd = call("cd");
		const result = verdicts([
			cd.wire,
			refused(cd.id, "HOBO_CD_VERCEL_AWAITING_APPROVAL", [
				"HOBO_OWNER_DEVICE https://vercel.com/oauth/device?user_code=AB-12 code=AB-12",
			]),
		]);
		expect(result["owner links reach the owner in the host"]).toMatchObject({
			holds: false,
		});
	});

	it("catches the paste form shown before the sign-in link (the owner had nothing to paste)", () => {
		const capture = call("capture_secret", { name: "INFISICAL_CLI_SESSION" });
		const result = verdicts([
			capture.wire,
			form("hobo-9", "Paste what Infisical copied after you signed in."),
		]);
		expect(result["link before form: INFISICAL_CLI_SESSION"]).toMatchObject({
			holds: false,
			at: 1,
			event: { kind: "form" },
		});
	});

	it("catches a run waiting on Vercel's approval whose link the host never showed", () => {
		const cd = call("cd");
		const result = verdicts([
			cd.wire,
			refused(cd.id, "HOBO_CD_VERCEL_AWAITING_APPROVAL", [
				"HOBO_OWNER_DEVICE https://vercel.com/oauth/device code=AB",
			]),
		]);
		expect(
			result["link before waiting: HOBO_CD_VERCEL_AWAITING_APPROVAL"],
		).toMatchObject({
			holds: false,
			at: 1,
		});
	});

	it("catches the 'omit --json' dead end through MCP", () => {
		const cd = call("cd");
		const result = verdicts([
			cd.wire,
			refused(
				cd.id,
				"HOBO_CD_HANDOFF_SILENT",
				["Run hobo cd up --hand-off without --json or -q."],
				"The owner hand-off needs progress output. Omit --json and -q, then retry.",
			),
		]);
		expect(result["never: silent-through-mcp"]).toMatchObject({
			holds: false,
			at: 1,
		});
	});

	it("catches telling a remote owner to use their own machine", () => {
		const cd = call("cd");
		const result = verdicts([
			cd.wire,
			refused(cd.id, "HOBO_CD_INFISICAL_SIGN_IN", [
				"Infisical's browser sign-in returns to the machine you sign in from: run hobo cd up on your own machine once.",
			]),
		]);
		expect(result["never: remote-infeasible"]).toMatchObject({
			holds: false,
			at: 1,
		});
	});

	it("catches a refusal that leaves the owner nothing to do", () => {
		const cd = call("cd");
		const result = verdicts([
			cd.wire,
			refused(cd.id, "HOBO_CD_STORE_UNAVAILABLE", [
				"infisical did not answer this run.",
			]),
		]);
		expect(result["no dead end"]).toMatchObject({ holds: false, at: 1 });
	});

	it("catches a secret the run handled reaching the host", () => {
		const capture = call("capture_secret", { name: "INFISICAL_CLI_SESSION" });
		const result = verdicts(
			[
				capture.wire,
				toHost({
					id: capture.id,
					result: { content: [{ type: "text", text: "stored eyJsession" }] },
				}),
			],
			["eyJsession"],
		);
		expect(result["no secret to the host"]).toMatchObject({
			holds: false,
			at: 1,
		});
	});

	it("catches a completion for a link the host was never shown", () => {
		const result = verdicts([
			toHost({
				method: "notifications/elicitation/complete",
				params: { elicitationId: "ghost" },
			}),
		]);
		expect(result["completion follows its link"]).toMatchObject({
			holds: false,
			at: 0,
		});
	});

	it("liveness: a run that never gets past asking the owner does not reach the frontier", () => {
		const cd = call("cd");
		const result = verdicts([
			cd.wire,
			refused(cd.id, "HOBO_CD_INFISICAL_SIGN_IN", [SIGN_IN_LINE]),
		]);
		expect(result["eventually: nothing more asked of the owner"]).toMatchObject(
			{
				holds: false,
			},
		);
	});
});
