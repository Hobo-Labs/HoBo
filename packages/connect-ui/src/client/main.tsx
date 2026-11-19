import type { Spec } from "@json-render/core";
import { defineRegistry, JSONUIProvider, Renderer } from "@json-render/react";
import { shadcnComponents } from "@json-render/shadcn";
import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";

import { connectCatalog } from "../catalog.js";

// The connect page in the browser: fetch the step's composed spec, render it
// with json-render's shadcn preset, and send every action to the flow on the
// loopback server. The page holds no state of its own beyond the last view.

/** Action params as the flow accepts them: string values only. */
const ActionParamsSchema = z.record(z.string(), z.string());
type ActionParams = z.infer<typeof ActionParamsSchema>;

/** Parse what the renderer hands an action into the flow's params. */
function actionParams(
	params: Parameters<typeof ActionParamsSchema.parse>[0],
): ActionParams {
	return ActionParamsSchema.parse(params ?? {});
}

// Set by the mounted page; every catalog action goes to the loopback flow.
let dispatchToFlow: (action: string, params: ActionParams) => Promise<void> =
	async () => undefined;

const { registry } = defineRegistry(connectCatalog, {
	actions: {
		"connect.chooseStore": async (params) =>
			dispatchToFlow("connect.chooseStore", actionParams(params)),
		"connect.start": async (params) =>
			dispatchToFlow("connect.start", actionParams(params)),
		"connect.cancel": async (params) =>
			dispatchToFlow("connect.cancel", actionParams(params)),
	},
	components: {
		Card: shadcnComponents.Card,
		Stack: shadcnComponents.Stack,
		Heading: shadcnComponents.Heading,
		Text: shadcnComponents.Text,
		Button: shadcnComponents.Button,
		Alert: shadcnComponents.Alert,
		Badge: shadcnComponents.Badge,
		Link: shadcnComponents.Link,
		Progress: shadcnComponents.Progress,
		Separator: shadcnComponents.Separator,
		Radio: shadcnComponents.Radio,
	},
});

type Directive =
	| { kind: "none" }
	| { kind: "navigate"; url: string }
	| { kind: "post"; url: string; fields: Record<string, string> };

interface View {
	step: string;
	terminal: boolean;
	composedBy: "model" | "deterministic";
	spec: Spec;
	directive: Directive;
}

const rootElement = document.getElementById("root");
const base = rootElement?.dataset.base ?? "./";

function follow(directive: Directive): void {
	if (directive.kind === "navigate") {
		window.location.assign(directive.url);
		return;
	}
	if (directive.kind === "post") {
		const form = document.createElement("form");
		form.method = "post";
		form.action = directive.url;
		for (const [name, value] of Object.entries(directive.fields)) {
			const input = document.createElement("input");
			input.type = "hidden";
			input.name = name;
			input.value = value;
			form.append(input);
		}
		document.body.append(form);
		form.submit();
	}
}

function ConnectPage() {
	const [view, setView] = useState<View | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		const response = await fetch(`${base}view`, { cache: "no-store" });
		if (!response.ok) throw new Error(`view failed (${response.status})`);
		// SAFETY: the loopback server builds this body from a step it just
		// composed and validated (compose.ts isRenderableConnectSpec).
		setView((await response.json()) as View);
	}, []);

	useEffect(() => {
		load().catch((reason) => setError(String(reason)));
	}, [load]);

	// While a deposit is in flight the server moves the step on its own.
	useEffect(() => {
		if (view === null || view.terminal || view.step !== "depositing") return;
		const timer = window.setTimeout(() => {
			load().catch((reason) => setError(String(reason)));
		}, 1000);
		return () => window.clearTimeout(timer);
	}, [view, load]);

	const dispatch = useCallback(async (action: string, params: ActionParams) => {
		const response = await fetch(`${base}action`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action, params }),
		});
		if (!response.ok) throw new Error(`action failed (${response.status})`);
		// SAFETY: as above, the server's own validated view.
		const next = (await response.json()) as View;
		setView(next);
		follow(next.directive);
	}, []);
	dispatchToFlow = dispatch;

	if (error !== null)
		return (
			<p className="hobo-connect-error">
				This page lost its connection: {error}
			</p>
		);
	if (view === null) return <p className="hobo-connect-loading">Loading…</p>;
	return (
		<JSONUIProvider
			registry={registry}
			handlers={{
				"connect.chooseStore": (params) =>
					dispatch("connect.chooseStore", actionParams(params)),
				"connect.start": (params) =>
					dispatch("connect.start", actionParams(params)),
				"connect.cancel": (params) =>
					dispatch("connect.cancel", actionParams(params)),
			}}
		>
			<Renderer spec={view.spec} registry={registry} />
		</JSONUIProvider>
	);
}

if (rootElement !== null)
	createRoot(rootElement).render(
		<StrictMode>
			<ConnectPage />
		</StrictMode>,
	);
