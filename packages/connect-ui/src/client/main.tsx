import { isNonEmptySpec, type Spec } from "@json-render/core";
import { defineRegistry, JSONUIProvider, Renderer } from "@json-render/react";
import { shadcnComponents } from "@json-render/shadcn";
import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";

import { connectCatalog } from "../catalog.js";

const ActionParamsSchema = z.record(z.string(), z.string());
type ActionParams = z.infer<typeof ActionParamsSchema>;

function actionParams(
	params: Parameters<typeof ActionParamsSchema.parse>[0],
): ActionParams {
	return ActionParamsSchema.parse(params ?? {});
}

let dispatchToFlow: (action: string, params: ActionParams) => Promise<void> =
	async () => undefined;

const { registry } = defineRegistry(connectCatalog, {
	actions: {
		"connect.submit": async (params) =>
			dispatchToFlow("connect.submit", actionParams(params)),
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

const DirectiveSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("none") }),
	z.object({ kind: z.literal("navigate"), url: z.string() }),
	z.object({
		kind: z.literal("post"),
		url: z.string(),
		fields: z.record(z.string(), z.string()),
	}),
]);

const ConnectViewSchema = z.object({
	step: z.string(),
	terminal: z.boolean(),
	composedBy: z.enum(["model", "deterministic"]),
	spec: z
		.object({
			root: z.string(),
			elements: z.record(
				z.string(),
				z.object({ type: z.string() }).passthrough(),
			),
		})
		.passthrough(),
	directive: DirectiveSchema,
});

type ParsedConnectView = z.infer<typeof ConnectViewSchema>;

function viewFromParsedConnect(parsed: ParsedConnectView): View {
	if (!isNonEmptySpec(parsed.spec)) {
		throw new Error("invalid connect view spec");
	}
	return {
		step: parsed.step,
		terminal: parsed.terminal,
		composedBy: parsed.composedBy,
		spec: parsed.spec,
		directive: parsed.directive,
	};
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
		setView(viewFromParsedConnect(ConnectViewSchema.parse(await response.json())));
	}, []);

	useEffect(() => {
		load().catch((reason) => setError(String(reason)));
	}, [load]);

	useEffect(() => {
		if (view === null || view.terminal || view.step !== "depositing") return;
		const timer = window.setTimeout(() => {
			load().catch((reason) => setError(String(reason)));
		}, 1000);
		return () => window.clearTimeout(timer);
	}, [view, load]);

	const dispatch = useCallback(async (action: string, params: ActionParams) => {
		try {
			const response = await fetch(`${base}action`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action, params }),
			});
			if (!response.ok) throw new Error(`action failed (${response.status})`);
			const next = viewFromParsedConnect(
				ConnectViewSchema.parse(await response.json()),
			);
			setView(next);
			follow(next.directive);
		} catch (reason) {
			setError(String(reason));
		}
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
				"connect.submit": (params) =>
					dispatch("connect.submit", actionParams(params)),
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
