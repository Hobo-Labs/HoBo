export interface TrailStep {
	readonly id: string;
	readonly kind: "schema" | "data" | "identity.continuous";
	readonly description: string;
}

export const {{name}}Trail: readonly TrailStep[] = [
	{
		id: "{{name}}.expand",
		kind: "schema",
		description: "Expand {{name}} schema without breaking readers",
	},
	{
		id: "{{name}}.backfill",
		kind: "data",
		description: "Backfill {{name}} rows behind the expanded schema",
	},
];
