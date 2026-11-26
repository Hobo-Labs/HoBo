package data_models

// CUE constraints for the run-to-collect facts (one definition per proto
// message). Every collection run produces exactly these two events in order.

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
