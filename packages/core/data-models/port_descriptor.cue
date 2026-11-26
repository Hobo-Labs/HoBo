package data_models

#PortKind: "runtime" | "provider" | "port"

#InterfaceStability: "stable" | "preview" | "experimental"

#PortDescriptor: {
	kind:          #PortKind
	name:          string & !=""
	interface_ref: string & =~"^[a-z][a-z0-9-]*:[a-z0-9-]+\\/[a-z0-9-]+(?:@[0-9]+\\.[0-9]+\\.[0-9]+)?$"
	stability:     #InterfaceStability
}
