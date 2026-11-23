const entrypoint = () => async () => new Response("isolated");

function application(name: string) {
	return {
		name,
		resources: {
			web: {
				kind: "web",
				name: "web",
				stableId: "web:web",
				declaredAllow: [],
				dependsOn: [],
				annotations: [
					{
						provider: "hobo",
						option: "session-replay",
						config: { enabled: false },
					},
				],
			},
		},
		edges: [],
		requirements: {},
		entrypoint: () => entrypoint,
	};
}

export const firstApplication = application("first");
export const secondApplication = application("second");
