/** Flux/Orbit evidence. Orbit is Git UX over FluxCloud. Checked 2026-08-14. */
export const FLUX_PIN = {
	orbit: "https://orbit.runonflux.com/",
	docs: "https://docs.runonflux.com/fluxcloud/register-new-app/deploy-with-git/introduction/",
	webhookApi:
		"https://docs.runonflux.com/fluxcloud/register-new-app/deploy-with-git/api/webhook-api",
	checkedAt: "2026-08-14",
	notes: [
		"WEBHOOK_SECRET is optional in vendor schema; unsigned POST /webhook can deploy.",
		"/status and /health are public unless API_KEY is set. Official HTTP /logs is not documented.",
		"Shared DB: MySQL fully supported; Postgres/Mongo in progress.",
		"ArcaneOS SAS is proprietary, closed-source, and obfuscated.",
		"Orbit dollar figures are ranking input only; tag COST_SOURCE, never billing.",
		"Do not pin runonflux/orbit:latest — digest was not inspectable this session.",
	],
} as const;
