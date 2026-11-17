export const CONFIG_SENSITIVITY = ["public", "internal", "sensitive"] as const;
export type ConfigSensitivity = (typeof CONFIG_SENSITIVITY)[number];

export function sensitivityForField(field: {
	readonly sensitive?: boolean;
	readonly sensitivity?: ConfigSensitivity;
}): ConfigSensitivity {
	if (field.sensitive !== undefined && field.sensitive !== false)
		return "sensitive";
	if (field.sensitivity === undefined) return "public";
	if (CONFIG_SENSITIVITY.includes(field.sensitivity)) return field.sensitivity;
	return "sensitive";
}
