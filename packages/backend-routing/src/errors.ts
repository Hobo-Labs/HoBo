export const BACKEND_FLEET_ERROR_CODES = [
	"FLEET_CONFIGURATION_INVALID",
	"FLEET_RECORD_INVALID",
] as const;

export type BackendFleetErrorCode = (typeof BACKEND_FLEET_ERROR_CODES)[number];

export type BackendFleetErrorDetail = Readonly<
	Record<string, string | number | boolean>
>;

export class BackendFleetError extends Error {
	readonly code: BackendFleetErrorCode;
	readonly detail: BackendFleetErrorDetail;

	constructor(
		code: BackendFleetErrorCode,
		message: string,
		options: { readonly detail?: BackendFleetErrorDetail } = {},
	) {
		super(message);
		this.name = "BackendFleetError";
		this.code = code;
		this.detail = Object.freeze(options.detail ?? {});
	}
}

export function isBackendFleetError(
	value: BackendFleetError | Error | null | undefined,
): value is BackendFleetError {
	return value instanceof BackendFleetError;
}
