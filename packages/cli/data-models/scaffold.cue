package cli

#TemplateId: "todo" | "api" | "agent" | "fullstack"

#ProjectName: string & !="" & =~"^[^\\\\/:*?\"<>|]+$" & !~"(^|/)\\.\\.($|/)" & !~"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$"

#ScaffoldRequest: {
	name:     #ProjectName
	template: #TemplateId
	force:    bool
}

#ScaffoldResult: {
	project_dir:    string
	created_files: [...string]
	next_steps:    [...string]
	offline:        bool & true
}
