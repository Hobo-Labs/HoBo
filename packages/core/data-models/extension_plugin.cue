package data_models

#DuplicatePolicy: "throw" | "replace"

#ExtensionPointId: string & =~"^hobo\\.[a-z0-9][a-z0-9.-]*\\/v[0-9]+$"

#PluginExtensionDeclaration: {
	point:       #ExtensionPointId
	export_name: string & !=""
	id?:         string & !=""
}

#PluginManifest: {
	schema: "hobo.plugin/v1"
	entry:  string & =~"^\\./.+"
	extensions: [...#PluginExtensionDeclaration] & [_, ...]
}

#PluginPackageManifest: {
	package_name: string & !=""
	plugin:       #PluginManifest
}
