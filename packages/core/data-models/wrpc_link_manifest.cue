package wrpc_link_manifest

#Semver: =~#"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$"#
#InterfaceId: string & !="" & =~#"^[a-z][a-z0-9-]*:[a-z0-9-]+/[a-z0-9-]+@[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$"#

#WrpcLinkManifestWire: {
	interfaceId: #InterfaceId
	version:     #Semver
	minor:       string & =~#"^[0-9]+\.[0-9]+$"#
	stability:   "stable" | "preview" | "experimental"
	floor:       #Semver
}

#WrpcLinkManifestEntry: {
	componentId:     string & !=""
	importInterface: #InterfaceId
	providerId:      string & !=""
	exportInterface: #InterfaceId
	wire:            #WrpcLinkManifestWire
}

#WrpcLinkManifest: {
	schema: "hobo.manifest.wrpc-links/v1"
	links: [...#WrpcLinkManifestEntry]
}
