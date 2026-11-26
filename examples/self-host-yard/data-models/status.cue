package data_models

#Health: "HEALTH_UNSPECIFIED" | "HEALTH_OPERATIONAL" | "HEALTH_DEGRADED" |
	"HEALTH_DOWN"

#ComponentStatus: {
	component: string & !=""
	health:    #Health
	note:      string
}

#StatusPage: {
	components: [...#ComponentStatus]
}

#IncidentReport: {
	component: string & !=""
	note:      string & !=""
}

#IncidentAck: {
	incidentId: string & !=""
	component:  string & !=""
	note:       string & !=""
}
