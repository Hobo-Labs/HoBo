export interface HealthResponse {
	status: number;
	body: string;
}

export function health(): HealthResponse {
	return {
		status: 200,
		body: "hello-bindle:ok",
	};
}

export function run(): HealthResponse {
	return health();
}
