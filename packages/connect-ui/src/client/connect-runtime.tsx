import { useStateStore } from "@json-render/react";
import {
	createContext,
	type MutableRefObject,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useRef,
} from "react";
import { z } from "zod";

import type { ConfigField } from "../steps.js";

const FormValuesSchema = z.record(z.string(), z.string());

export interface ConnectRuntimeValue {
	readonly confirmByLabel: ReadonlyMap<string, string>;
	readonly collectFormParams: (
		includeSecrets: boolean,
	) => Record<string, string>;
}

const ConnectRuntimeContext = createContext<ConnectRuntimeValue | null>(null);

export function useConnectRuntime(): ConnectRuntimeValue {
	const value = useContext(ConnectRuntimeContext);
	if (value === null) throw new Error("ConnectRuntimeProvider is required");
	return value;
}

export function parseFormValues(get: ReturnType<typeof useStateStore>["get"]) {
	const direct = FormValuesSchema.safeParse(get("/form"));
	if (direct.success) return direct.data;
	const wrapped = z.object({ form: FormValuesSchema }).safeParse(get("/form"));
	return wrapped.success ? wrapped.data.form : {};
}

export function formParamsForAgent(
	values: Record<string, string>,
	secretNames: ReadonlySet<string>,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(values).filter(([name]) => !secretNames.has(name)),
	);
}

export function ConnectFormParamsBridge({
	secretNames,
	collector,
}: {
	readonly secretNames: ReadonlySet<string>;
	readonly collector: MutableRefObject<
		(includeSecrets: boolean) => Record<string, string>
	>;
}) {
	const { get } = useStateStore();
	useEffect(() => {
		collector.current = (includeSecrets) => {
			const parsed = parseFormValues(get);
			if (includeSecrets) return parsed;
			return formParamsForAgent(parsed, secretNames);
		};
	}, [collector, get, secretNames]);
	return null;
}

export function ConnectRuntimeProvider({
	confirmByLabel,
	collector,
	children,
}: {
	readonly confirmByLabel: ReadonlyMap<string, string>;
	readonly collector: MutableRefObject<
		(includeSecrets: boolean) => Record<string, string>
	>;
	readonly children: ReactNode;
}) {
	const value = useMemo(
		(): ConnectRuntimeValue => ({
			confirmByLabel,
			collectFormParams: (includeSecrets) => collector.current(includeSecrets),
		}),
		[confirmByLabel, collector],
	);
	return (
		<ConnectRuntimeContext.Provider value={value}>
			{children}
		</ConnectRuntimeContext.Provider>
	);
}

export function useConnectFormCollector(fields: readonly ConfigField[]) {
	const collector = useRef<(includeSecrets: boolean) => Record<string, string>>(
		() => ({}),
	);
	const secretNames = useMemo(
		() =>
			new Set(
				fields
					.filter((field) => field.kind === "secret")
					.map((field) => field.name),
			),
		[fields],
	);
	return { collector, secretNames };
}
