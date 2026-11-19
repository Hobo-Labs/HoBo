package data_models


#BindleEventType: "bindle.ResourcesCollected" | "bindle.ManifestProduced"
#BindleId: string & =~"^[A-Za-z][A-Za-z0-9_-]*$"
#ManifestHash: string & =~"^sha256:[0-9a-f]{64}$"

#BindleResourcesCollected: {
	id:        string & !=""
	type:      "bindle.ResourcesCollected"
	seq:       1
	source:    string & !=""
	bindle_id: #BindleId
	resources: [...string]
	binds: [...string]
}

#BindleManifestProduced: {
	id:            string & !=""
	type:          "bindle.ManifestProduced"
	seq:           2
	source:        string & !=""
	bindle_id:     #BindleId
	manifest_hash: #ManifestHash
}
