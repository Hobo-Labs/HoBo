declare module "@hobo/sdk" {
	export interface HoboOptions {
		name: string;
		template: "todo" | "api" | "agent" | "fullstack";
	}

	export interface HoboRequest {
		path: string;
	}

	export interface HoboResponse {
		status: number;
		body: Record<string, unknown>;
	}

	export interface HoboResource<TStore> {
		name: string;
		store: TStore;
	}

	export interface HoboHandler {
		route: string;
		run(request: HoboRequest): Promise<HoboResponse>;
	}

	export interface Hobo {
		resource<TStore>(name: string, store: TStore): HoboResource<TStore>;
		api(
			route: string,
			handler: (request: HoboRequest) => Promise<HoboResponse>,
		): HoboHandler;
	}

	export function createHobo(options: HoboOptions): Hobo;
}
