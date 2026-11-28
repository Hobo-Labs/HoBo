const apply = Reflect.apply;
const create = Object.create;
const freeze = Object.freeze;
const NativeResponse = Response;
const responseJson = NativeResponse.json;
const responseStatus = Object.getOwnPropertyDescriptor(
	NativeResponse.prototype,
	"status",
)?.get;
const defineResponse = Object.defineProperty;
const nonThenable: PropertyDescriptor = create(null);
nonThenable.value = undefined;
nonThenable.writable = false;
nonThenable.enumerable = false;
nonThenable.configurable = false;
freeze(nonThenable);
const topicFallback = new NativeResponse(null, { status: 503 });
defineResponse(topicFallback, "then", nonThenable);
freeze(topicFallback);

export function rivetTopicUnavailable(reason: string): Response {
	try {
		// SAFETY: the captured native constructor returns an ordinary Response.
		const response = apply(responseJson, NativeResponse, [
			{ status: "topic-unavailable", reason },
			{ status: 503 },
		]) as Response;
		if (!responseStatus || apply(responseStatus, response, []) !== 503)
			return topicFallback;
		defineResponse(response, "then", nonThenable);
		return response;
	} catch {
		return topicFallback;
	}
}
