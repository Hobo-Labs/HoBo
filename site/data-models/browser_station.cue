package data_models

#BrowserStationRequest: {
	exampleId:  string & =~"^[a-z0-9]+(?:-[a-z0-9]+)*$"
	stationId: string & =~"^station:browser:"
	method:    "GET" | "POST" | "PATCH" | "DELETE"
	path:      string & =~"^/"
	bodyJson:  string
}

#BrowserStationResponse: {
	status:   uint32 & >=100 & <=599
	bodyJson: string
}
