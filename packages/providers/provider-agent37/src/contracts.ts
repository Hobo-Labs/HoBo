import { z } from "zod";

export const agent37InstanceTypeSchema = z.enum([
	"default",
	"vm",
	"performance",
]);
export const agent37RegionSchema = z.enum(["us", "eu", "ap-south"]);
export const agent37InstanceStatusSchema = z.enum([
	"provisioning",
	"running",
	"stopping",
	"stopped",
	"starting",
	"restarting",
	"updating",
	"sleeping",
	"waking",
	"failed",
	"deleting",
	"deleted",
]);

const boundedText = z.string().min(1).max(4096);
const resourcesSchema = z
	.object({
		cpu: z.number().int().positive().max(128),
		memory: z.number().int().positive().max(1024),
		disk: z.number().int().positive().max(1024),
	})
	.strict();
const networkSchema = z.union([
	z.literal("allow-all"),
	z.literal("deny-all"),
	z.object({ allow: z.array(boundedText).max(100) }).strict(),
]);
const publicPortSchema = z.object({
	port: z.number().int().min(1).max(65_535),
	url: z.url().optional(),
	domain_urls: z.array(z.url()).max(100).optional(),
	prefix: z.string().nullable().optional(),
	label: z.string().nullable().optional(),
	created: z.number().int().optional(),
});

export const agent37InstanceSchema = z.object({
	id: boundedText,
	status: agent37InstanceStatusSchema,
	status_reason: z.unknown().nullable().optional(),
	template: boundedText,
	template_revision: z.number().int().nullable().optional(),
	image_ref: z.string().nullable().optional(),
	image_digest: z.string().nullable().optional(),
	type: agent37InstanceTypeSchema,
	region: agent37RegionSchema,
	mount_path: z.string().nullable().optional(),
	resources: resourcesSchema,
	url: z.url().optional(),
	domain_urls: z.array(z.url()).optional(),
	public_ports: z.array(z.union([z.number().int(), publicPortSchema])),
	name: z.string().nullable().optional(),
	metadata: z.record(z.string(), z.string()).nullable().optional(),
	auto_sleep: z.boolean(),
	idle_timeout_seconds: z.number().int().min(300).max(86_400),
	network: networkSchema,
	sleeping: z.number().int().nullable().optional(),
	past_due: z.boolean().optional(),
	created: z.number().int().optional(),
	created_at: z.string().optional(),
	updated_at: z.string().optional(),
});

export const agent37CreateInstanceInputSchema = z
	.object({
		template: boundedText.optional(),
		resources: resourcesSchema.optional(),
		type: agent37InstanceTypeSchema.optional(),
		region: agent37RegionSchema.optional(),
		name: z.string().max(256).optional(),
		metadata: z.record(z.string().max(256), z.string().max(4096)).optional(),
		env: z.record(z.string().max(256), z.string().max(65_536)).optional(),
		budget: z
			.object({
				monthly_cap_micros: z.number().int().nonnegative().safe(),
				credit_micros: z.number().int().nonnegative().safe(),
			})
			.strict()
			.optional(),
		auto_sleep: z.boolean().optional(),
		idle_timeout_seconds: z.number().int().min(300).max(86_400).optional(),
		public_ports: z
			.array(
				z
					.object({
						port: z.number().int().min(1).max(65_535),
						prefix: z.string().max(256).optional(),
						label: z.string().max(256).optional(),
					})
					.strict(),
			)
			.max(100)
			.optional(),
		network: networkSchema.optional(),
		mount_path: z.string().max(4096).optional(),
	})
	.strict();

export const agent37InstanceListSchema = z
	.union([
		z.object({ data: z.array(agent37InstanceSchema) }),
		z.object({ instances: z.array(agent37InstanceSchema) }),
	])
	.transform((value) => ("data" in value ? value.data : value.instances));

export const agent37ExecInputSchema = z
	.object({
		command: z.string().min(1).max(1_048_576),
		user: z.literal("root").optional(),
		background: z.boolean().optional(),
		name: z.string().min(1).max(128).optional(),
	})
	.strict();

export const agent37ExecResultSchema = z.union([
	z.object({ pid: z.number().int().positive() }),
	z.object({
		id: z.string().optional(),
		instance_id: z.string().optional(),
		background: z.boolean().optional(),
		status: z.string().optional(),
		exit_code: z.number().int().nullable(),
		stdout: z.string(),
		stderr: z.string(),
		truncated: z.boolean().optional(),
		created_at: z.string().optional(),
		finished_at: z.string().nullable().optional(),
	}),
]);

export const agent37WebhookSchema = z.object({
	id: boundedText,
	url: z.url(),
	last_failure: z.unknown().nullable().optional(),
	created: z.number().int().optional(),
	created_at: z.string().optional(),
});
export const agent37RegisteredWebhookSchema = agent37WebhookSchema.extend({
	secret: z.string().min(1).max(4096),
});
export const agent37WebhookListSchema = z
	.union([
		z.object({ data: z.array(agent37WebhookSchema) }),
		z.object({ webhooks: z.array(agent37WebhookSchema) }),
	])
	.transform((value) => ("data" in value ? value.data : value.webhooks));

export const agent37DeletedSchema = z.object({
	id: boundedText,
	deleted: z.literal(true),
});

const microsSchema = z.number().int().nonnegative().safe();
const usageTotalsSchema = z.object({
	total_micros: microsSchema,
	compute_micros: microsSchema,
	llm_micros: microsSchema,
	brave_micros: microsSchema,
	composio_micros: microsSchema,
	perflo_micros: microsSchema,
	llm_calls: microsSchema,
	input_tokens: microsSchema,
	output_tokens: microsSchema,
	awake_minutes: microsSchema,
});
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);

export const agent37UsageSchema = z.object({
	from: dateSchema,
	to: dateSchema,
	total_micros: microsSchema,
	by_integration: z.object({
		compute: z.object({
			cost_micros: microsSchema,
			awake_minutes: microsSchema,
		}),
		llm: z.object({
			cost_micros: microsSchema,
			calls: microsSchema,
			input_tokens: microsSchema,
			output_tokens: microsSchema,
		}),
		brave: z.object({ cost_micros: microsSchema }),
		composio: z.object({ cost_micros: microsSchema }),
		perflo: z.object({ cost_micros: microsSchema }),
	}),
	by_model: z.array(
		z.object({
			model: z.string(),
			cost_micros: microsSchema,
			calls: microsSchema,
			input_tokens: microsSchema,
			output_tokens: microsSchema,
		}),
	),
	days: z.array(usageTotalsSchema.extend({ date: dateSchema })),
	instances: z.array(usageTotalsSchema.extend({ id: z.string() })),
});

export const agent37UsageQuerySchema = z
	.object({ from: dateSchema.optional(), to: dateSchema.optional() })
	.strict();

export const agent37ErrorEnvelopeSchema = z.union([
	z.object({ error: z.string() }).transform(({ error }) => ({ code: error })),
	z
		.object({
			error: z.object({ code: z.string(), message: z.string().optional() }),
		})
		.transform(({ error }) => error),
]);

export const agent37WebhookUrlSchema = z.url().refine(
	(value) => {
		const url = new URL(value);
		const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
		return url.protocol === "https:" || (url.protocol === "http:" && loopback);
	},
	{ message: "Agent37 webhooks require HTTPS or loopback HTTP" },
);

export type Agent37Instance = z.infer<typeof agent37InstanceSchema>;
export type Agent37CreateInstanceInput = z.infer<
	typeof agent37CreateInstanceInputSchema
>;
export type Agent37ExecInput = z.infer<typeof agent37ExecInputSchema>;
export type Agent37ExecResult = z.infer<typeof agent37ExecResultSchema>;
export type Agent37Webhook = z.infer<typeof agent37WebhookSchema>;
export type Agent37RegisteredWebhook = z.infer<
	typeof agent37RegisteredWebhookSchema
>;
export type Agent37Usage = z.infer<typeof agent37UsageSchema>;
export type Agent37UsageQuery = z.infer<typeof agent37UsageQuerySchema>;
