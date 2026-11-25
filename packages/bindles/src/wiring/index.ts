export { addContainer } from "./add-container.js";
export {
	BindReferenceError,
	compileBindleManifest,
	createComponentHandle,
	data,
	normalizeBindMap,
	service,
	validateLazyReferences,
	validateLinks,
} from "./bind-reference.js";
export { bindingTypesFor } from "./binding-types.js";
export type { ComponentHandle, Handle, ResourceHandle } from "./errors.js";
export type {
	BindingMeta,
	ManifestLink,
	ManifestResource,
	WiringManifest,
} from "./types.js";
export {
	LAZY_TOKEN_PATTERN,
	MANIFEST_SCHEMA,
	RESOURCE_ID_PATTERN,
} from "./types.js";
