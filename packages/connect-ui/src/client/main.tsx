import { isNonEmptySpec, type Spec } from "@json-render/core";
import {
	defineRegistry,
	JSONUIProvider,
	Renderer,
	useStateStore,
} from "@json-render/react";
import { shadcnComponents } from "@json-render/shadcn";
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
import { connectCatalog } from "../catalog.js";
import { confirmLabelsForSpec } from "./confirm-labels.js";
import { formInitialState } from "./form-state.js";

const ActionParamsSchema = z.record(z.string(), z.string());
type ActionParams = z.infer<typeof ActionParamsSchema>;

function actionParams(
	params: Parameters<typeof ActionParamsSchema.parse>[0],
): ActionParams {
	return ActionParamsSchema.parse(params ?? {});
}

const FormValuesSchema = z.record(z.string(), z.string());

function FormParamsBridge() {
	const { get } = useStateStore();
	useEffect(() => {
		formParamsRef.current = () => {
			const direct = FormValuesSchema.safeParse(get("/form"));
			if (direct.success) return direct.data;
			const wrapped = z.object({ form: FormValuesSchema }).safeParse(get("/form"));
			return wrapped.success ? wrapped.data.form : {};
		};
	});
	return null;
}

const formParamsRef = { current: (): Record<string, string> => ({}) };

const confirmByLabelRef = { current: new Map<string, string>() };

function ConnectButton(
	props: Parameters<typeof shadcnComponents.Button>[0],
) {
	const confirm = confirmByLabelRef.current.get(props.props.label);
	return (
		<span data-agent-confirm={confirm}>
			<shadcnComponents.Button {...props} />
		</span>
	);
}

const { registry } = defineRegistry(connectCatalog, {
	components: {
		Card: shadcnComponents.Card,
		Stack: shadcnComponents.Stack,
		Heading: shadcnComponents.Heading,
		Text: shadcnComponents.Text,
		Button: ConnectButton,
		Alert: shadcnComponents.Alert,
		Badge: shadcnComponents.Badge,
		Link: shadcnComponents.Link,
		Progress: shadcnComponents.Progress,
		Separator: shadcnComponents.Separator,
		Radio: shadcnComponents.Radio,
		Input: shadcnComponents.Input,
	},
	actions: {
		"connect.submit": async () => {},
		"connect.chooseStore": async () => {},
		"connect.start": async () => {},
		"connect.cancel": async () => {},
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
	confirmByAction: ReadonlyMap<string, string>;
	formFields: readonly ConfigField[];
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
				return { ...row, description: option.description } satisfies ChoiceOption;
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
		() =>
			view === null
				? {}
				: formInitialState(view.spec, view.formFields),
		[view],
	);

	useEffect(() => {
		if (view === null) return;
		confirmByLabelRef.current = new Map(
			confirmLabelsForSpec(view.spec, view.confirmByAction),
		);
	}, [view]);

	if (error !== null)
		return (
			<p className="hobo-connect-error">
				This page lost its connection: {error}
			</p>
		);
	if (view === null) return <p className="hobo-connect-loading">Loading…</p>;
	return (
		<JSONUIProvider
			key={`${view.step}-${view.composedBy}-${view.formFields.map((field) => field.name).join(",")}`}
			registry={registry}
			initialState={initialState}
			handlers={{
				"connect.submit": (params) =>
					dispatch("connect.submit", {
						...formParamsRef.current(),
						...actionParams(params),
					}),
				"connect.chooseStore": (params) =>
					dispatch("connect.chooseStore", actionParams(params)),
				"connect.start": (params) =>
					dispatch("connect.start", actionParams(params)),
				"connect.cancel": (params) =>
					dispatch("connect.cancel", actionParams(params)),
			}}
		>
			<FormParamsBridge />
			<fieldset disabled={busy} className="connect-fieldset">
				<Renderer spec={view.spec} registry={registry} />
			</fieldset>
		</JSONUIProvider>
	);
}

if (rootElement !== null)
	createRoot(rootElement).render(
		<StrictMode>
			<ConnectPage />
		</StrictMode>,
	);