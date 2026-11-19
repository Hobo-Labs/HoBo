import {
	ProviderHandlerStore,
	parseInterfaceId,
	parseWireVersion,
} from "@hobo/core";
import {
	createInProcessTransport,
	createWrpcLinkLayer,
} from "../../dist/index.js";

const interfaceId = parseInterfaceId("wasi:keyvalue/store@0.2.0");
const pin = {
	interfaceId,
	stability: "stable",
	versions: [parseWireVersion("0.2.0")],
};
const store = new ProviderHandlerStore();
const link = createWrpcLinkLayer({
	transport: createInProcessTransport({ store }),
	compatibilityFloor: "0.2.0",
	store,
});
link.registerComponent({ id: "api", imports: [pin] });
link.registerProvider({
	id: "kv",
	exports: [pin],
	handlers: { [interfaceId]: { get: () => new Promise(() => {}) } },
});
link.establishLink({
	componentId: "api",
	importInterface: interfaceId,
	providerId: "kv",
	exportInterface: interfaceId,
});
const deadline = new Date(Date.now() + 150).toISOString();
void link.callImport("api", interfaceId, "get", {}, { deadline }).then(
	() => {
		process.stderr.write("unexpected success\n");
		process.exitCode = 1;
	},
	(error) => {
		process.stdout.write(error.code);
	},
);
