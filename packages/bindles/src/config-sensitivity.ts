/**
 * Config classification (ADR-0142).
 * public → may surface as values to app/agents when policy allows
 * internal → app runtime only; never agents/events as raw values
 * sensitive → refs + delegated resolve; host-mediated material only
 */

export const CONFIG_SENSITIVITY = ["public", "internal", "sensitive"] as const;
export type ConfigSensitivity = (typeof CONFIG_SENSITIVITY)[number];

/** Map legacy sensitive:boolean + optional explicit sensitivity. */
export function sensitivityForField(field: {
	readonly sensitive?: boolean;
	readonly sensitivity?: ConfigSensitivity;
}): ConfigSensitivity {
	if (field.sensitivity) return field.sensitivity;
	return field.sensitive === true ? "sensitive" : "public";
}
