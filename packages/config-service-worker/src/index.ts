/**
 * `@hobo/config-service-worker` — HoBo's config-service Worker (ADR-0179
 * amendment "Secret store chosen at deploy, provisioned by claim", Worker
 * addendum): the relay's config and secrets in a Durable Object on a
 * Cloudflare account the owner claims.
 *
 * The Worker's own modules are `src/worker/*` (uploaded as compiled); this
 * entry is the Node side: the upload's modules, the deploy-time binding,
 * the bootstrap credential and the client.
 */
export type {
	ConfigAuditEntry,
	ConfigFolderRead,
	ConfigFolderWritten,
	ConfigServiceOwnerAccess,
	ConfigServiceSeed,
	ConfigServiceWorkerBinding,
} from "./_generated/config_service_worker_pb.js";
export {
	ConfigFolderReadSchema,
	ConfigServiceWorkerBindingSchema,
} from "./_generated/config_service_worker_pb.js";
export {
	type BootstrapCredential,
	ConfigServiceBindingError,
	formatOwnerAccess,
	formatWorkerBinding,
	githubAudienceFor,
	newBootstrapCredential,
	newStoreId,
	type OwnerAccess,
	parseConfigServiceWorkerBinding,
	type WorkerBinding,
	type WorkerBindingInput,
} from "./binding.js";
export {
	type ConfigServiceClient,
	ConfigServiceClientError,
	type ConfigServiceClientErrorCode,
	type ConfigServiceCredential,
	createConfigServiceClient,
	parseConfigServiceOrigin,
	type TokenSource,
} from "./client.js";
export {
	CONFIG_BINDING_VAR,
	CONFIG_SERVICE_COMPATIBILITY_DATE,
	CONFIG_SERVICE_MAIN_MODULE,
	CONFIG_STORE_BINDING,
	CONFIG_STORE_CLASS,
	CONFIG_STORE_MIGRATION_TAG,
	configServiceWorkerModules,
	OWNER_ACCESS_VAR,
	type WorkerModule,
} from "./module.js";
export {
	createInMemoryConfigService,
	type InMemoryConfigService,
} from "./stand-in.js";
export { ERROR_CODES, type ErrorCode } from "./worker/http.js";
export {
	BOOTSTRAP_SCHEME,
	CONFIG_SERVICE_NAME,
	type ConfigServiceEnv,
	createConfigServiceHandler,
	type StoreNamespace,
	type StoreObjectId,
} from "./worker/handler.js";
export { FOLDERS, type Folder, LIMITS } from "./worker/records.js";
export {
	ConfigStore,
	createConfigStoreCore,
	type DurableObjectStateLike,
	type StoragePort,
} from "./worker/store.js";
