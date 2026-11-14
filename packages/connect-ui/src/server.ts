import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Experimental_CompositionEvaluator as Evaluator } from "@json-render/core";

import { z } from "zod";

import { composeConnectSpec } from "./compose.js";
import {
	CONNECT_ACTIONS,
	type ConnectActionName,
	type ConnectStep,
	isTerminalStep,
} from "./steps.js";

// The connect page a lifecycle opens (`hobo ci up`, `hobo cd up`): a loopback
// server that renders the current step's composed spec and turns the page's
// actions into flow transitions. The flow is the authority: the page can only
// ask for one of three actions, and only the flow moves the step.
//
// - Bound to 127.0.0.1 on an ephemeral port, under an unguessable per-session
//   path (`/s/<token>/`). A request outside it is a 404.
// - A provider redirect (GitHub's App manifest POST, Vercel's authorize URL)
//   is a *directive* the flow returns; the browser follows it and the provider
//   sends the browser back to `/s/<token>/callback`, which the flow handles.
// - No secret value is ever in a response: steps carry store references only.
// - CSP: scripts and connections are 'self' only. Inline *styles* are allowed
//   because Radix positions some shadcn parts with style attributes; the page
//   renders no untrusted content.

/** What a flow asks the browser to do next, beside the new step. */
// domain-view: narrowed union of BrowserDirectiveRecord in data-models/connect_ui.proto.
export type BrowserDirective =
	| { readonly kind: "none" }
	| { readonly kind: "navigate"; readonly url: string }
	| {
			/** An auto-submitting form POST (GitHub's App manifest flow). */
			readonly kind: "post";
			readonly url: string;
			readonly fields: Readonly<Record<string, string>>;
	  };

export interface FlowTransition {
	readonly step: ConnectStep;
	readonly directive?: BrowserDirective;
}

export interface ConnectFlow {
	readonly initial: ConnectStep;
	/** Decide a page action. Unknown params must be refused by the flow. */
	readonly onAction: (
		action: ConnectActionName,
		params: Readonly<Record<string, string>>,
		current: ConnectStep,
	) => Promise<FlowTransition>;
	/** The provider sent the browser back with these query parameters. */
	readonly onCallback?: (
		query: URLSearchParams,
		current: ConnectStep,
	) => Promise<FlowTransition>;
}

export interface ConnectPageOptions {
	readonly flow: ConnectFlow;
	readonly evaluate?: Evaluator | undefined;
	/** Directory holding `connect.js` and `connect.css` (the built client). */
	readonly assetsDir?: string;
	readonly host?: "127.0.0.1";
	readonly port?: number;
}

export interface ConnectPage {
	/** Open this in the browser. Unguessable; loopback only. */
	readonly url: string;
	/** The base callback URL a provider redirects back to. */
	readonly callbackUrl: string;
	/** Settles with the terminal step (connected or failed). */
	readonly done: Promise<ConnectStep>;
	readonly close: () => Promise<void>;
}

const DEFAULT_ASSETS = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"client",
);

const MAX_BODY_BYTES = 16 * 1024;

function send(
	res: ServerResponse,
	status: number,
	type: string,
	body: string | Buffer,
): void {
	res.writeHead(status, {
		"content-type": type,
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
		"referrer-policy": "no-referrer",
		"content-security-policy":
			"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; form-action https://github.com; frame-ancestors 'none'",
	});
	res.end(body);
}

async function readBody(req: IncomingMessage): Promise<string> {
	let size = 0;
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		const buffer = Buffer.from(chunk);
		size += buffer.length;
		if (size > MAX_BODY_BYTES) throw new RangeError("request body too large");
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

/** The only body `POST /action` accepts: a known action and string params. */
const ActionBodySchema = z.object({
	action: z.enum(CONNECT_ACTIONS),
	params: z.record(z.string(), z.string()).default({}),
});

type ActionBody = z.infer<typeof ActionBodySchema>;

function parseActionBody(text: string): ActionBody | undefined {
	let json: z.core.util.JSONType;
	try {
		json = JSON.parse(text);
	} catch {
		return undefined;
	}
	const parsed = ActionBodySchema.safeParse(json);
	return parsed.success ? parsed.data : undefined;
}

function shell(base: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HoBo · Connect</title>
<link rel="stylesheet" href="${base}connect.css">
</head>
<body>
<main id="root" data-base="${base}"><noscript>This page needs JavaScript to show the connection step.</noscript></main>
<script type="module" src="${base}connect.js"></script>
</body>
</html>`;
}

/** Start the connect page. Close it once `done` settles. */
export async function startConnectPage(
	options: ConnectPageOptions,
): Promise<ConnectPage> {
	const token = randomBytes(24).toString("base64url");
	const base = `/s/${token}/`;
	const assetsDir = options.assetsDir ?? DEFAULT_ASSETS;
	let step: ConnectStep = options.flow.initial;
	let directive: BrowserDirective = { kind: "none" };
	let settle: (step: ConnectStep) => void = () => undefined;
	const done = new Promise<ConnectStep>((resolve) => {
		settle = resolve;
	});
	// One transition at a time: a double click cannot run two provider calls.
	let queue: Promise<void> = Promise.resolve();
	const transition = (run: () => Promise<FlowTransition>) => {
		const next = queue.then(async () => {
			if (isTerminalStep(step)) return;
			try {
				const result = await run();
				step = result.step;
				directive = result.directive ?? { kind: "none" };
			} catch (error) {
				step = {
					kind: "failed",
					provider: step.provider,
					message: error instanceof Error ? error.message : String(error),
					remediation: [
						"Run the command again; nothing was left half-created.",
					],
				};
				directive = { kind: "none" };
			}
			if (isTerminalStep(step)) settle(step);
		});
		queue = next.catch(() => undefined);
		return next;
	};

	const view = async () => {
		const composed = await composeConnectSpec(step, {
			evaluate: options.evaluate,
		});
		return JSON.stringify({
			step: step.kind,
			terminal: isTerminalStep(step),
			composedBy: composed.composedBy,
			spec: composed.spec,
			directive,
		});
	};

	const server = createServer((req, res) => {
		void (async () => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			if (!url.pathname.startsWith(base))
				return send(res, 404, "text/plain", "not found");
			const route = url.pathname.slice(base.length);
			if (req.method === "GET" && route === "")
				return send(res, 200, "text/html; charset=utf-8", shell(base));
			if (
				req.method === "GET" &&
				(route === "connect.js" || route === "connect.css")
			)
				return send(
					res,
					200,
					route.endsWith(".js") ? "text/javascript" : "text/css",
					await readFile(path.join(assetsDir, route)),
				);
			if (req.method === "GET" && route === "view")
				return send(res, 200, "application/json", await view());
			if (req.method === "POST" && route === "action") {
				const parsed = parseActionBody(await readBody(req));
				if (parsed === undefined)
					return send(
						res,
						400,
						"application/json",
						'{"error":"invalid action"}',
					);
				await transition(() =>
					options.flow.onAction(parsed.action, parsed.params, step),
				);
				return send(res, 200, "application/json", await view());
			}
			if (req.method === "GET" && route === "callback") {
				const onCallback = options.flow.onCallback;
				if (onCallback !== undefined)
					await transition(() => onCallback(url.searchParams, step));
				// Back to the page, which renders the step the callback produced.
				res.writeHead(303, { location: base, "cache-control": "no-store" });
				return res.end();
			}
			return send(res, 404, "text/plain", "not found");
		})().catch(() => {
			if (!res.headersSent) send(res, 500, "text/plain", "internal error");
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () =>
			resolve(),
		);
	});
	// SAFETY: listen() on a TCP host and port always reports an AddressInfo;
	// only a pipe or socket path reports a string, and none is used here.
	const { port } = server.address() as AddressInfo;
	const origin = `http://127.0.0.1:${port}`;
	return {
		url: `${origin}${base}`,
		callbackUrl: `${origin}${base}callback`,
		done,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}
