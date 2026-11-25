package data_models

#ComponentizeScaffoldRecord: {
  package_name: string & =~"^@hobo/"
  owner_issue:  string & !=""
}
