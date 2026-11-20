import {
	type ComponentFn,
	defineRegistry,
	useBoundProp,
	useFieldValidation,
} from "@json-render/react";
import { shadcnComponents } from "@json-render/shadcn";
import { useState } from "react";
import { z } from "zod";

import { connectCatalog } from "../catalog.js";
import { agentPressAllowed, readAgentConfirm } from "./agent-gate.js";
import { confirmForPressAction } from "./confirm-labels.js";
import { useConnectRuntime } from "./connect-runtime.js";

type ButtonCtx = Parameters<typeof shadcnComponents.Button>[0] & {
	readonly props: { readonly pressAction?: string };
};

function ConnectButton(props: ButtonCtx) {
	const { confirmByAction } = useConnectRuntime();
	const confirm = confirmForPressAction(
		props.props.pressAction,
		confirmByAction,
	);
	return (
		<span
			data-agent-confirm={confirm}
			onClickCapture={(event) => {
				if (event.isTrusted) return;
				const message =
					readAgentConfirm(event.currentTarget) ?? confirm ?? undefined;
				if (!agentPressAllowed(message, false)) {
					event.preventDefault();
					event.stopPropagation();
				}
			}}
		>
			<shadcnComponents.Button {...props} />
		</span>
	);
}

type RadioCtx = Parameters<ComponentFn<typeof connectCatalog, "Radio">>[0];

function ConnectRadio({ props, bindings, emit }: RadioCtx) {
	const options = props.options ?? [];
	const [boundValue, setBoundValue] = useBoundProp(
		props.value,
		bindings?.value,
	);
	const [localValue, setLocalValue] = useState(options[0]?.value ?? "");
	const isBound = bindings?.value !== undefined;
	const value = isBound ? (boundValue ?? "") : localValue;
	const setValue = isBound ? setBoundValue : setLocalValue;
	const validateOn = props.validateOn ?? "change";
	const hasValidation = !!(bindings?.value && props.checks?.length);
	const { errors, validate } = useFieldValidation(
		bindings?.value ?? "",
		hasValidation
			? {
					checks: (props.checks ?? []).map((check) =>
						check.args === undefined
							? { type: check.type, message: check.message }
							: {
									type: check.type,
									message: check.message,
									args: check.args,
								},
					),
					validateOn,
				}
			: undefined,
	);
	return (
		<div className="space-y-2">
			{props.label ? (
				<span className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
					{props.label}
				</span>
			) : null}
			<div aria-label={props.label} className="grid gap-3" role="radiogroup">
				{options.map((option) => (
					<div className="flex items-center space-x-2" key={option.value}>
						<input
							checked={value === option.value}
							id={`${props.name}-${option.value}`}
							name={props.name}
							onChange={() => {
								setValue(option.value);
								if (hasValidation && validateOn === "change") validate();
								emit("change");
							}}
							type="radio"
							value={option.value}
						/>
						<label
							className="cursor-pointer text-sm leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
							htmlFor={`${props.name}-${option.value}`}
						>
							{option.label}
						</label>
					</div>
				))}
			</div>
			{errors.length > 0 && (
				<p className="text-sm text-destructive">{errors[0]}</p>
			)}
		</div>
	);
}

type InputCtx = Parameters<ComponentFn<typeof connectCatalog, "Input">>[0];

const ResolvedInputValueSchema = z.string().nullable().catch(null);

function ConnectInput({ props, ...rest }: InputCtx) {
	return (
		<shadcnComponents.Input
			{...rest}
			props={{
				...props,
				value: ResolvedInputValueSchema.parse(props.value ?? null),
			}}
		/>
	);
}

export const { registry } = defineRegistry(connectCatalog, {
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
		Radio: ConnectRadio,
		Input: ConnectInput,
	},
	actions: {
		"connect.submit": async () => {},
		"connect.chooseStore": async () => {},
		"connect.start": async () => {},
		"connect.cancel": async () => {},
	},
});
