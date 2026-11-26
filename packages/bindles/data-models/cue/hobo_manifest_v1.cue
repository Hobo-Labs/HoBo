package manifest_v1

import (
	"regexp"
	"strings"
	"struct"
)

#ResourceId: string & =~"^[A-Za-z][A-Za-z0-9_-]*$"

#ResourceType: "data.v1" | "component.v1" | "website.v1"

#RuntimeKind: "wasm" | "container"

#TriggerKind: "topic-subscribe" | "schedule-cron" | "blob-event"

#TriggerExportInterface:
	"hobo:trigger/topic-subscriber" |
	"hobo:trigger/scheduled-run" |
	"hobo:trigger/blob-event"

#ComponentHost: {
	kind:    string & !=""
	version: string & !=""
}

#Link: {
	import: string & !=""
	to:     string & !=""
}

#Resource: {
	type: ResourceType
	port?: string & !=""
	paradigm?:          string
	allow?:             [...string]
	connectionString?:  string
	image?:             string
	runtime?:           #RuntimeKind
	exports?:           [...string]
	links?:             [...#Link]
	endpoints?:         {...}
	env?:               [string]: string
	annotations?:       {...}
	bind?:              [...#ResourceId]

	if type == "data.v1" {
		port: string & !=""
	}
}

#TriggerEdge: {
	id:               string & !=""
	kind:             #TriggerKind
	resourceId:       string & #ResourceId
	exportInterface:  #TriggerExportInterface
	event?:           string
}

#Manifest: close({
	schema:         "hobo.manifest/v1"
	componentHost:  #ComponentHost
	resources: {
		[string & #ResourceId]: #Resource
	} & struct.MinFields(1)
	triggerEdges?: [...#TriggerEdge]
	policy?: {...}

	for rid, resource in resources if resource.links != _|_ {
		for i, link in resource.links {
			"link_import_\(rid)_\(i)": resources[link.to].port & link.import
		}
	}

	for rid, resource in resources if resource.bind != _|_ {
		for i, target in resource.bind {
			"bind_target_\(rid)_\(i)": resources[target].type
		}
	}

	for rid, resource in resources if resource.env != _|_ {
		for key, value in resource.env if strings.HasPrefix(value, "{") {
			let token = strings.TrimSuffix(strings.TrimPrefix(value, "{"), "}")
			let resourceId = strings.SplitN(token, ".", 2)[0]
			"lazy_ref_\(rid)_\(key)": resources[resourceId].type
		}
		for key, value in resource.env if strings.HasPrefix(value, "${resources.") {
			let match = regexp.FindSubmatch("^\\$\\{resources\\.[^#]+#([A-Za-z][A-Za-z0-9_-]*)\\.outputs\\..+\\}$", value)
			"placeholder_ref_\(rid)_\(key)": resources[match[1]].type
		}
	}
})

// Architecture-guard pairing for protobuf messages in manifest.proto
ComponentHost: #ComponentHost
Link:          #Link
Resource:      #Resource
TriggerEdge:   #TriggerEdge
Manifest:      #Manifest
ResourceType:  #ResourceType
RuntimeKind:   #RuntimeKind
TriggerKind:   #TriggerKind
