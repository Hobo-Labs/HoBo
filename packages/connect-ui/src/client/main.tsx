import { createAgent, registerTools } from "@ui-sdk/react/agent";
import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";

import type { StepView, ViewAction } from "../view.js";
import { StepCard } from "./step-card.js";

const ViewSchema = z.object({
	step: z.string(),
	terminal: z.boolean(),
	view: z.custom<StepView>(
		(value) =>
			z
				.object({
					title: z.string(),
					fields: z.array(z.object({ name: z.string(), label: z.string() })),
					actions: z.array(z.object({ action: z.string(), label: z.string() })),
				})
				.safeParse(value).success,
	),
	directive: z.discriminatedUnion("kind", [
		z.object({ kind: z.literal("none") }),
		z.object({ kind: z.literal("navigate"), url: z.string().url() }),
		z.object({
			kind: z.literal("post"),
			url: z.string().url(),
			fields: z.record(z.string(), z.string()),
		}),
	]),
});
type ViewEnvelope = z.infer<typeof ViewSchema>;

const rootElement = document.getElementById("root");
const base = rootElement?.dataset.base ?? "./";

// An agent operates this page through the same components a person uses.
// Anything marked data-agent-confirm (a provider hand-off, giving a secret)
// asks the person first; WebMCP gets the same bridge.
const agent = createAgent({
	allow: (step) => (step.confirm ? window.confirm(step.confirm) : true),
});
registerTools(agent, { allow: () => true });

function follow(directive: ViewEnvelope["directive"]): void {
	if (directive.kind === "navigate") window.location.assign(directive.url);
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
	const [envelope, setEnvelope] = useState<ViewEnvelope | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const load = useCallback(async () => {
		const response = await fetch(`${base}view`, { cache: "no-store" });
		if (!response.ok) throw new Error(`view failed (${response.status})`);
		setEnvelope(ViewSchema.parse(await response.json()));
	}, []);

	useEffect(() => {
		load().catch((reason) => setError(String(reason)));
	}, [load]);

	useEffect(() => {
		if (
			envelope === null ||
			envelope.terminal ||
			envelope.step !== "depositing"
		)
			return;
		const timer = window.setTimeout(() => {
			load().catch((reason) => setError(String(reason)));
		}, 1000);
		return () => window.clearTimeout(timer);
	}, [envelope, load]);

	const onAction = useCallback(
		async (action: ViewAction, values: Record<string, string>) => {
			setBusy(true);
			try {
				const response = await fetch(`${base}action`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						action: action.action,
						params: action.submits ? values : {},
					}),
				});
				if (!response.ok) throw new Error(`action failed (${response.status})`);
				const next = ViewSchema.parse(await response.json());
				setEnvelope(next);
				follow(next.directive);
			} catch (reason) {
				setError(String(reason));
			} finally {
				setBusy(false);
			}
		},
		[],
	);

	if (error !== null)
		return <p className="hobo-error">This page lost its connection: {error}</p>;
	if (envelope === null) return <p className="hobo-loading">Loading…</p>;
	return <StepCard view={envelope.view} onAction={onAction} busy={busy} />;
}

if (rootElement !== null)
	createRoot(rootElement).render(
		<StrictMode>
			<ConnectPage />
		</StrictMode>,
	);
