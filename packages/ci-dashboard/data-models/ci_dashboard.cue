package ci_dashboard

#Repository: =~"^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$"
#View:       "runners" | "router" | "history" | "performance" | "signals"
#StepKey:    "fleet" | "machine" | "github" | "blacksmith" | "depot" | "namespace" | "warpbuild" | "ubicloud" | "boat"

#DashboardRunRef: {
	repository: #Repository
	id:         int & >0 & <=9007199254740991
	attempt:    int & >=1 & <=1000
}

#DashboardLocation: {
	view:        #View
	repository?: #Repository
	run?:        #DashboardRunRef
	if run != _|_ {
		view: "history"
	}
}

#WhatIfLabels: {
	key:    #StepKey
	labels: string
}

#WhatIfQuestion: {
	repository: #Repository
	labels: [...#WhatIfLabels]
	public:      bool
	fork:        bool
	startedBy:   "" | =~"^[0-9]{1,20}$"
	fleetTaking: bool
	unhealthy: [...#StepKey]
	minutesUsedPercent?: number & >=0 & <=100
}
