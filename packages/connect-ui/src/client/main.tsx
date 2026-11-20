import { isNonEmptySpec, type Spec } from "@json-render/core";
import { JSONUIProvider, Renderer } from "@json-render/react";
import {
	StrictMode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import type { ConfigField } from "../steps.js";
import { confirmLabelsForSpec } from "./confirm-labels.js";
import { registry } from "./connect-registry.js";
import {
	ConnectFormParamsBridge,
	ConnectRuntimeProvider,
	useConnectFormCollector,
	useConnectRuntime,
} from "./connect-runtime.js";
import { formInitialState } from "./form-state.js";

const ActionParamsSchema = z.record(z.string(), z.string());
type ActionParams = z.infer<typeof ActionParamsSchema>;
type ConnectJsonRenderState = ReturnType<typeof formInitialState>;
type JsonRenderHandlerParams = Parameters<typeof actionParams>[0];

function actionParams(
	params: Parameters<typeof ActionParamsSchema.parse>[0],
): ActionParams {
	return ActionParamsSchema.parse(params ?? {});
}

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
	confirmByAction: ReadonlyMap<string, string>;
	formFields: readonly ConfigField[];
}

const DirectiveSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("none") }),
	z.object({ kind: z.literal("navigate"), url: z.string().url() }),
	z.object({
		kind: z.literal("post"),
		url: z.string().url(),
		fields: z.record(z.string(), z.string()),
	}),
]);

const ConfigFieldSchema = z.object({
	name: z.string(),
	label: z.string(),
	description: z.string().optional(),
	kind: z.enum(["text", "url", "secret", "choice"]),
	required: z.boolean(),
	value: z.string().optional(),
	options: z
		.array(
			z.object({
				value: z.string(),
				label: z.string(),
				description: z.string().optional(),
			}),
		)
		.optional(),
	error: z.string().optional(),
});

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
	view: z
		.object({
			actions: z.array(
				z.object({
					action: z.string(),
					confirm: z.string().optional(),
				}),
			),
			fields: z.array(ConfigFieldSchema).optional(),
		})
		.optional(),
});

type ParsedConnectView = z.infer<typeof ConnectViewSchema>;
type ParsedConfigField = z.infer<typeof ConfigFieldSchema>;

type MutableConfigField = {
	-readonly [K in keyof ConfigField]: ConfigField[K];
};

function toConfigField(field: ParsedConfigField): ConfigField {
	const parsed: MutableConfigField = {
		name: field.name,
		label: field.label,
		kind: field.kind,
		required: field.required,
	};
	if (field.description !== undefined) parsed.description = field.description;
	if (field.value !== undefined) parsed.value = field.value;
	if (field.error !== undefined) parsed.error = field.error;
	if (field.options !== undefined) {
		parsed.options = field.options.map((option) => {
			type ChoiceOption = NonNullable<ConfigField["options"]>[number];
			const row = { value: option.value, label: option.label } satisfies Pick<
				ChoiceOption,
				"value" | "label"
			>;
			if (option.description !== undefined) {
				return {
					...row,
					description: option.description,
				} satisfies ChoiceOption;
			}
			return row satisfies ChoiceOption;
		});
	}
	return parsed;
}

function viewFromParsedConnect(parsed: ParsedConnectView): View {
	if (!isNonEmptySpec(parsed.spec)) {
		throw new Error("invalid connect view spec");
	}
	const confirmByAction = new Map<string, string>();
	for (const entry of parsed.view?.actions ?? []) {
		if (entry.confirm !== undefined)
			confirmByAction.set(entry.action, entry.confirm);
	}
	return {
		step: parsed.step,
		terminal: parsed.terminal,
		composedBy: parsed.composedBy,
		spec: parsed.spec,
		directive: parsed.directive,
		confirmByAction,
		formFields: (parsed.view?.fields ?? []).map(toConfigField),
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

function ConnectStage({
	view,
	initialState,
	dispatch,
	busy,
	collector,
	secretNames,
}: {
	readonly view: View;
	readonly initialState: ConnectJsonRenderState;
	readonly dispatch: (action: string, params: ActionParams) => Promise<void>;
	readonly busy: boolean;
	readonly collector: ReturnType<typeof useConnectFormCollector>["collector"];
	readonly secretNames: ReturnType<
		typeof useConnectFormCollector
	>["secretNames"];
}) {
	const { collectFormParams } = useConnectRuntime();
	const handlers = useMemo(
		() => ({
			"connect.submit": (params: JsonRenderHandlerParams) =>
				dispatch("connect.submit", {
					...collectFormParams(true),
					...actionParams(params),
				}),
			"connect.chooseStore": (params: JsonRenderHandlerParams) =>
				dispatch("connect.chooseStore", actionParams(params)),
			"connect.start": (params: JsonRenderHandlerParams) =>
				dispatch("connect.start", actionParams(params)),
			"connect.cancel": (params: JsonRenderHandlerParams) =>
				dispatch("connect.cancel", actionParams(params)),
		}),
		[collectFormParams, dispatch],
	);
	return (
		<JSONUIProvider
			registry={registry}
			initialState={initialState}
			handlers={handlers}
		>
			<ConnectFormParamsBridge
				secretNames={secretNames}
				collector={collector}
			/>
			<fieldset disabled={busy} className="connect-fieldset">
				<Renderer spec={view.spec} registry={registry} />
			</fieldset>
		</JSONUIProvider>
	);
}

function ConnectPage() {
	const [view, setView] = useState<View | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const busyRef = useRef(false);

	const load = useCallback(async () => {
		const response = await fetch(`${base}view`, { cache: "no-store" });
		if (!response.ok) throw new Error(`view failed (${response.status})`);
		setView(
			viewFromParsedConnect(ConnectViewSchema.parse(await response.json())),
		);
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

	const dispatch = useCallback(
		async (action: string, params: ActionParams) => {
			if (busyRef.current) return;
			const confirm = view?.confirmByAction.get(action);
			if (confirm !== undefined && !window.confirm(confirm)) return;
			busyRef.current = true;
			setBusy(true);
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
			} finally {
				busyRef.current = false;
				setBusy(false);
			}
		},
		[view],
	);
	const initialState = useMemo(
		() => (view === null ? { form: {} } : formInitialState(view.formFields)),
		[view],
	);
	const { collector, secretNames } = useConnectFormCollector(
		view?.formFields ?? [],
	);

	if (error !== null)
		return (
			<p className="hobo-connect-error">
				This page lost its connection: {error}
			</p>
		);
	if (view === null) return <p className="hobo-connect-loading">Loading…</p>;

	const confirmByLabel = confirmLabelsForSpec(view.spec, view.confirmByAction);

	return (
		<ConnectRuntimeProvider
			confirmByLabel={confirmByLabel}
			collector={collector}
		>
			<ConnectStage
				key={`${view.step}-${view.composedBy}-${view.formFields.map((field) => field.name).join(",")}`}
				view={view}
				initialState={initialState}
				dispatch={dispatch}
				busy={busy}
				collector={collector}
				secretNames={secretNames}
			/>
		</ConnectRuntimeProvider>
	);
}

if (rootElement !== null)
	createRoot(rootElement).render(
		<StrictMode>
			<ConnectPage />
		</StrictMode>,
	);
