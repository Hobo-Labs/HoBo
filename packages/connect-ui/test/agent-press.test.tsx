// @vitest-environment jsdom
import { JSONUIProvider, Renderer } from "@json-render/react";
import { fireEvent, render, screen } from "@testing-library/react";
import { type MutableRefObject, type ReactNode, useMemo } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { specWithPressActions } from "../src/client/confirm-labels.js";
import { registry } from "../src/client/connect-registry.js";
import {
	ConnectFormParamsBridge,
	ConnectRuntimeProvider,
} from "../src/client/connect-runtime.js";
import { formInitialState } from "../src/client/form-state.js";
import {
	type ConfigField,
	type ConnectStep,
	DEFAULT_SECRET_STORES,
	deterministicConnectSpec,
} from "../src/index.js";

const APP_STEP: ConnectStep = {
	kind: "create-github-app",
	provider: "github",
	appName: "HoBo CI",
	owner: "octo-org",
	store: "infisical",
};

const CONFIGURE_STEP: ConnectStep = {
	kind: "configure",
	provider: "hobo",
	title: "Choose a provider",
	reason: "A provider is needed.",
	fields: [
		{
			name: "provider:db",
			label: "Provider for db",
			kind: "choice",
			required: true,
			options: [
				{ value: "neon", label: "Neon Postgres" },
				{ value: "supabase", label: "Supabase" },
			],
		},
	] satisfies readonly ConfigField[],
};

type FormCollector = MutableRefObject<
	(includeSecrets: boolean) => Record<string, string>
>;

type Handlers = Record<string, () => void>;

function Harness({
	step,
	confirmByAction,
	handlers,
	collector,
	relabel,
	children,
}: {
	readonly step: ConnectStep;
	readonly confirmByAction: ReadonlyMap<string, string>;
	readonly handlers: Handlers;
	readonly collector: FormCollector;
	readonly relabel?: Readonly<Record<string, string>>;
	readonly children?: ReactNode;
}) {
	const spec = useMemo(() => {
		const composed = specWithPressActions(deterministicConnectSpec(step));
		if (relabel === undefined) return composed;
		const elements = { ...composed.elements };
		for (const [id, label] of Object.entries(relabel)) {
			const element = elements[id];
			if (element === undefined) continue;
			elements[id] = {
				...element,
				props: { ...element.props, label },
			};
		}
		return { ...composed, elements };
	}, [step, relabel]);
	const fields = step.kind === "configure" ? step.fields : [];
	const secretNames = useMemo(
		() =>
			new Set(
				fields
					.filter((field) => field.kind === "secret")
					.map((field) => field.name),
			),
		[fields],
	);
	return (
		<ConnectRuntimeProvider
			confirmByAction={confirmByAction}
			collector={collector}
		>
			<JSONUIProvider
				registry={registry}
				initialState={formInitialState(fields)}
				handlers={handlers}
			>
				<ConnectFormParamsBridge
					secretNames={secretNames}
					collector={collector}
				/>
				<Renderer spec={spec} registry={registry} />
				{children}
			</JSONUIProvider>
		</ConnectRuntimeProvider>
	);
}

function emptyCollector(): FormCollector {
	return { current: () => ({}) };
}

afterEach(() => {
	document.body.innerHTML = "";
});

describe("agent press path through the rendered registry", () => {
	it("refuses an untrusted press on a person-confirmed hand-off", () => {
		const start = vi.fn();
		render(
			<Harness
				step={APP_STEP}
				confirmByAction={
					new Map([["connect.start", "Open GitHub to register the App?"]])
				}
				handlers={{ "connect.start": start }}
				collector={emptyCollector()}
			/>,
		);
		const button = screen.getByRole("button", { name: "Continue on GitHub" });
		fireEvent.click(button);
		expect(start).not.toHaveBeenCalled();
		expect(
			button
				.closest("[data-agent-confirm]")
				?.getAttribute("data-agent-confirm"),
		).toMatch(/GitHub/u);
	});

	it("lets an untrusted press through when no confirm is required", () => {
		const cancel = vi.fn();
		render(
			<Harness
				step={APP_STEP}
				confirmByAction={
					new Map([["connect.start", "Open GitHub to register the App?"]])
				}
				handlers={{ "connect.cancel": cancel }}
				collector={emptyCollector()}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it("gates duplicate labels by their connect action, not by label", () => {
		const chooseStore = vi.fn();
		const cancel = vi.fn();
		render(
			<Harness
				step={{
					kind: "choose-secret-store",
					provider: "github",
					stores: DEFAULT_SECRET_STORES,
				}}
				confirmByAction={
					new Map([
						["connect.chooseStore", "Choose where credentials are stored?"],
					])
				}
				handlers={{
					"connect.chooseStore": chooseStore,
					"connect.cancel": cancel,
				}}
				collector={emptyCollector()}
				relabel={{ "cancel-optional": "Infisical Cloud (recommended)" }}
			/>,
		);
		const buttons = screen.getAllByRole("button", {
			name: "Infisical Cloud (recommended)",
		});
		expect(buttons).toHaveLength(2);
		for (const button of buttons) fireEvent.click(button);
		expect(chooseStore).not.toHaveBeenCalled();
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it("binds a choice field's label for the person and its value for the flow", () => {
		const submit = vi.fn();
		const collector = emptyCollector();
		render(
			<Harness
				step={CONFIGURE_STEP}
				confirmByAction={new Map()}
				handlers={{ "connect.submit": submit }}
				collector={collector}
			/>,
		);
		fireEvent.click(screen.getByLabelText("Neon Postgres"));
		expect(collector.current(true)).toEqual({ "provider:db": "neon" });
		fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
		expect(submit).toHaveBeenCalledTimes(1);
	});
});
