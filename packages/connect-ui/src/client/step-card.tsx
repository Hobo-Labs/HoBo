import { Button } from "@ui-sdk/react/button";
import {
	Field,
	FieldDescription,
	FieldError,
	FieldLabel,
} from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import {
	PasswordInput,
	PasswordInputControl,
	PasswordInputToggle,
} from "@ui-sdk/react/password-input";
import {
	Progress,
	ProgressIndicator,
	ProgressLabel,
	ProgressTrack,
	ProgressValue,
} from "@ui-sdk/react/progress";
import { Radio, RadioGroup, RadioIndicator } from "@ui-sdk/react/radio";
import { useEffect, useRef, useState } from "react";

import type { ConfigField } from "../steps.js";
import type { StepView, ViewAction } from "../view.js";

// One step's generated component (view.ts), rendered with vercel-labs/ui
// parts: every control is named by its Field label, so a person and an
// agent (createAgent, WebMCP) find the same controls.

function initialValues(fields: readonly ConfigField[]): Record<string, string> {
	return Object.fromEntries(
		fields.map((field) => [
			field.name,
			field.kind === "secret" ? "" : (field.value ?? ""),
		]),
	);
}

function StepField({
	field,
	value,
	onChange,
}: {
	readonly field: ConfigField;
	readonly value: string;
	readonly onChange: (value: string) => void;
}) {
	if (field.kind === "choice")
		return (
			<Field name={field.name} invalid={field.error !== undefined}>
				<FieldLabel>{field.label}</FieldLabel>
				<RadioGroup
					value={value || null}
					onValueChange={(next) => onChange(next ?? "")}
				>
					{(field.options ?? []).map((option) => (
						<label key={option.value} className="hobo-choice">
							<Radio value={option.value}>
								<RadioIndicator />
							</Radio>
							<span>
								<strong>{option.label}</strong>
								{option.description !== undefined ? (
									<small>{option.description}</small>
								) : null}
							</span>
						</label>
					))}
				</RadioGroup>
				{field.description !== undefined ? (
					<FieldDescription>{field.description}</FieldDescription>
				) : null}
				<FieldError>{field.error}</FieldError>
			</Field>
		);
	// A password field is already secret to the agent bridge: it may fill
	// it, never read it.
	if (field.kind === "secret")
		return (
			<Field name={field.name} invalid={field.error !== undefined}>
				<FieldLabel>{field.label}</FieldLabel>
				<PasswordInput
					required={field.required}
					value={value}
					onValueChange={onChange}
				>
					<PasswordInputControl />
					<PasswordInputToggle aria-label={`Show ${field.label}`} />
				</PasswordInput>
				<FieldDescription>
					{field.description ??
						"Written straight to your secret store; never kept here."}
				</FieldDescription>
				<FieldError>{field.error}</FieldError>
			</Field>
		);
	return (
		<Field name={field.name} invalid={field.error !== undefined}>
			<FieldLabel>{field.label}</FieldLabel>
			<Input
				type={field.kind === "url" ? "url" : "text"}
				required={field.required}
				value={value}
				onValueChange={onChange}
			/>
			{field.description !== undefined ? (
				<FieldDescription>{field.description}</FieldDescription>
			) : null}
			<FieldError>{field.error}</FieldError>
		</Field>
	);
}

export function StepCard({
	view,
	onAction,
	busy,
}: {
	readonly view: StepView;
	readonly onAction: (
		action: ViewAction,
		values: Record<string, string>,
	) => void;
	readonly busy: boolean;
}) {
	const [values, setValues] = useState(() => initialValues(view.fields));
	// An agent sets a value and presses in one batch, before React re-renders:
	// actions read the latest values from here, not from the last render.
	const latest = useRef(values);
	const change = (name: string, next: string) => {
		latest.current = { ...latest.current, [name]: next };
		setValues(latest.current);
	};
	useEffect(() => {
		latest.current = initialValues(view.fields);
		setValues(latest.current);
	}, [view]);
	return (
		<section
			className="hobo-card"
			data-tone={view.tone}
			aria-labelledby="step-title"
		>
			<header>
				<h1 id="step-title">{view.title}</h1>
				<p className="hobo-muted">{view.description}</p>
			</header>
			{view.explanation.map((line) => (
				<p key={line}>{line}</p>
			))}
			{view.fields.length > 0 ? (
				<form
					className="hobo-fields"
					onSubmit={(event) => {
						event.preventDefault();
						const primary = view.actions.find((action) => action.submits);
						if (primary !== undefined) onAction(primary, latest.current);
					}}
				>
					{view.fields.map((field) => (
						<StepField
							key={field.name}
							field={field}
							value={values[field.name] ?? ""}
							onChange={(next) => change(field.name, next)}
						/>
					))}
				</form>
			) : null}
			{view.progress !== undefined ? (
				<Progress value={view.progress.value} max={view.progress.max}>
					<ProgressLabel>{view.progress.label}</ProgressLabel>
					<ProgressValue />
					<ProgressTrack>
						<ProgressIndicator />
					</ProgressTrack>
				</Progress>
			) : null}
			{view.references.length > 0 ? (
				<ul className="hobo-refs" aria-label="Stored credential references">
					{view.references.map((reference) => (
						<li key={reference}>
							<code>{reference}</code>
						</li>
					))}
				</ul>
			) : null}
			{view.link !== undefined ? (
				<a href={view.link.href}>{view.link.label}</a>
			) : null}
			{view.actions.length > 0 ? (
				<div className="hobo-actions">
					{view.actions.map((action) => (
						<Button
							key={action.action}
							data-variant={action.variant}
							disabled={busy}
							{...(action.confirm !== undefined
								? { "data-agent-confirm": action.confirm }
								: {})}
							onClick={() => onAction(action, latest.current)}
						>
							{action.label}
						</Button>
					))}
				</div>
			) : null}
		</section>
	);
}
