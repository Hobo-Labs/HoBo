/**
 * Shared management result envelope used by CLI, MCP, and control API.
 */
// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- SAFETY: existing boundary or test contract.
export type ManagementResult<T = Record<string, unknown>> = Readonly<{
	ok: boolean;
	code: string;
	message: string;
	status?: string;
	remediation?: readonly string[];
	data?: T;
}>;

export function okResult<T>(
	message: string,
	data: T,
	opts?: { code?: string; status?: string },
): ManagementResult<T> {
	return Object.freeze({
		ok: true,
		code: opts?.code ?? "HOBO_OK",
		message,
		// oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- SAFETY: existing boundary or test contract.
		...(opts?.status !== undefined ? { status: opts.status } : {}),
		data,
	});
}

export function errResult(
	message: string,
	opts?: {
		code?: string;
		status?: string;
		remediation?: readonly string[];
		// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- SAFETY: existing boundary or test contract.
		data?: Record<string, unknown>;
	},
): ManagementResult {
	return Object.freeze({
		ok: false,
		code: opts?.code ?? "HOBO_ERR",
		message,
		// oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- SAFETY: existing boundary or test contract.
		...(opts?.status !== undefined ? { status: opts.status } : {}),
		// oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- SAFETY: existing boundary or test contract.
		...(opts?.remediation !== undefined
			? { remediation: opts.remediation }
			: {}),
		// oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- SAFETY: existing boundary or test contract.
		...(opts?.data !== undefined ? { data: opts.data } : {}),
	});
}
/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/no-conditional-empty-object-spread -- SAFETY: the result envelope is an intentionally open cross-surface payload. */
