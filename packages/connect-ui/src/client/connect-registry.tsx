import { defineRegistry } from "@json-render/react";
import { shadcnComponents } from "@json-render/shadcn";

import { connectCatalog } from "../catalog.js";
import { agentPressAllowed, readAgentConfirm } from "./agent-gate.js";
import { useConnectRuntime } from "./connect-runtime.js";

function ConnectButton(props: Parameters<typeof shadcnComponents.Button>[0]) {
	const { confirmByLabel } = useConnectRuntime();
	const confirm = confirmByLabel.get(props.props.label);
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
