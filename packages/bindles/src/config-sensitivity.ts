
export const CONFIG_SENSITIVITY = ["public", "internal", "sensitive"] as const;
export type ConfigSensitivity = (typeof CONFIG_SENSITIVITY)[number];

export function sensitivityForField(field: {
	readonly sensitive?: boolean;
	readonly sensitivity?: ConfigSensitivity;
}): ConfigSensitivity {
	if (field.sensitivity) return field.sensitivity;
	return field.sensitive === true ? "sensitive" : "public";
}
