const apply = Reflect.apply;
const NativeResponse = Response;
const responseJson = NativeResponse.json;
const responseStatus = Object.getOwnPropertyDescriptor(
	NativeResponse.prototype,
	"status",
)?.get;
const defineResponse = Object.defineProperty;
const topicFallback = new NativeResponse(null, { status: 503 });
defineResponse(topicFallback, "then", { value: undefined });
Object.freeze(topicFallback);

/** Return a failure status even if application code changes built-in prototypes. */
export function rivetTopicUnavailable(reason: string): Response {
	try {
		// SAFETY: the captured native constructor returns an ordinary Response.
		const response = apply(responseJson, NativeResponse, [
			{ status: "topic-unavailable", reason },
			{ status: 503 },
		]) as Response;
		if (!responseStatus || apply(responseStatus, response, []) !== 503)
			return topicFallback;
		defineResponse(response, "then", { value: undefined });
		return response;
	} catch {
		return topicFallback;
	}
}
