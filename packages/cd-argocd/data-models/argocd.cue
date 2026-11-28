package data_models

#HttpsUrl: string & =~"^https://[^/@?#\\s]+(/[^?#\\s]*)?$"
#K8sName: string & =~"^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$"

#ArgocdControlRecord: {
	api_base_url:  #HttpsUrl
	application:   #K8sName
	app_namespace: #K8sName
	token_ref:     string & !=""
}