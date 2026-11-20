import { defineCatalog } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { shadcnComponentDefinitions as ui } from "@json-render/shadcn/catalog";
import { z } from "zod";

import { SECRET_STORE_IDS } from "./steps.js";

export const RadioOptionSchema = z.object({
	label: z.string(),
	value: z.string(),
});

const BindableValueSchema = z.union([
	z.string().nullable(),
	z.object({ $bindState: z.string() }),
]);

const RadioDefinition = {
	...ui.Radio,
	props: ui.Radio.props.extend({
		options: z.array(RadioOptionSchema),
		value: BindableValueSchema,
	}),
};

const InputDefinition = {
	...ui.Input,
	props: ui.Input.props.extend({ value: BindableValueSchema }),
};

export const connectCatalog = defineCatalog(schema, {
	components: {
		Card: ui.Card,
		Stack: ui.Stack,
		Heading: ui.Heading,
		Text: ui.Text,
		Button: ui.Button,
		Alert: ui.Alert,
		Badge: ui.Badge,
		Link: ui.Link,
		Progress: ui.Progress,
		Separator: ui.Separator,
		Radio: RadioDefinition,
		Input: InputDefinition,
	},
	actions: {
		"connect.submit": {
			params: z.record(z.string(), z.string()),
			description: "Submit configured settings and continue the flow",
		},
		"connect.chooseStore": {
			params: z.object({
				store: z.enum(SECRET_STORE_IDS),
			}),
			description:
				"Choose the third-party secret store the provider's credentials go to",
		},
		"connect.start": {
			params: z.object({}),
			description:
				"Start the provider's consent screen (GitHub App manifest, Vercel authorization)",
		},
		"connect.cancel": {
			params: z.object({}),
			description: "Stop the connection; nothing is created",
		},
	},
});

export type ConnectCatalog = typeof connectCatalog;

export const CONNECT_COMPONENTS = Object.freeze([
	"Card",
	"Stack",
	"Heading",
	"Text",
	"Button",
	"Alert",
	"Badge",
	"Link",
	"Progress",
	"Separator",
	"Radio",
	"Input",
] as const);
