import {
	type AnyActorDefinition,
	actor,
	isStaticActorDefinition,
} from "rivetkit";

/** Bindle entrypoints are application code; the returned HTTP shape is checked at runtime. */
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof -- SAFETY: application entrypoints cross the adapter's runtime boundary. */
export type RivetHttpEntrypoint = () => unknown;

export interface RivetRequestContext {
	readonly name: string;
	readonly key: readonly string[];
}

export interface RivetHttpBinding<Entrypoint extends RivetHttpEntrypoint> {
	readonly actor: AnyActorDefinition;
	readonly actorName: string;
	readonly entrypoint: Entrypoint;
	readonly handle: (
		context: RivetRequestContext,
		request: Request,
	) => Promise<Response>;
}

const bindings = new WeakSet<object>();

function name(value: string): boolean {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 200 &&
		value.trim() === value &&
		!/[\p{Cc}]/u.test(value)
	);
}

/** Create an actual RivetKit actor around the exact Bindle HTTP entrypoint. */
export function createRivetHttpActor<
	Entrypoint extends RivetHttpEntrypoint,
>(options: {
	readonly actorName: string;
	readonly entrypoint: Entrypoint;
	/** Host-owned authorization for the observed actor key and HTTP request. */
	readonly authorize: (input: {
		readonly actorName: string;
		readonly actorKey: readonly string[];
		readonly request: Request;
	}) => boolean | Promise<boolean>;
}): RivetHttpBinding<Entrypoint> {
	if (
		!name(options.actorName) ||
		typeof options.entrypoint !== "function" ||
		typeof options.authorize !== "function"
	)
		throw new TypeError(
			"a named Rivet actor, application entrypoint and host authorization are required",
		);
	const { actorName, entrypoint, authorize } = options;
	const handle = async (
		context: RivetRequestContext,
		request: Request,
	): Promise<Response> => {
		if (
			context.name !== actorName ||
			!Array.isArray(context.key) ||
			context.key.length === 0 ||
			context.key.length > 16 ||
			!context.key.every(name)
		)
			return new Response("Forbidden", { status: 403 });
		let allowed: boolean;
		try {
			allowed = await authorize({
				actorName,
				actorKey: Object.freeze([...context.key]),
				request: request.clone(),
			});
		} catch {
			return new Response("Forbidden", { status: 403 });
		}
		if (allowed !== true) return new Response("Forbidden", { status: 403 });
		const application = entrypoint();
		let response: unknown;
		if (typeof application === "function")
			response = await application(request);
		else if (
			typeof application === "object" &&
			application !== null &&
			"fetch" in application &&
			typeof application.fetch === "function"
		)
			response = await application.fetch(request);
		else
			throw new TypeError(
				"Rivet application entrypoint must produce an HTTP handler",
			);
		if (!(response instanceof Response))
			throw new TypeError("Rivet application handler must return a Response");
		return response;
	};
	const binding: RivetHttpBinding<Entrypoint> = Object.freeze({
		actor: actor({ onRequest: handle }),
		actorName,
		entrypoint,
		handle,
	});
	bindings.add(binding);
	return binding;
}

/** Only accept a genuine binding constructed by this runtime module. */
export function isRivetHttpBinding(
	value: RivetHttpBinding<RivetHttpEntrypoint>,
): boolean {
	return (
		bindings.has(value) &&
		isStaticActorDefinition(value.actor) &&
		value.actor.config.onRequest === value.handle &&
		Object.keys(value.actor.config.actions ?? {}).length === 0
	);
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof */
