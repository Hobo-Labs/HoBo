import {
  createCdktfImportOnlyProvider,
  importCdktfState,
  type CdktfDriftReport,
  type CdktfImportReport,
  type CdktfImportedResource,
} from "../src/cdktf-import-only.js";

const provider = createCdktfImportOnlyProvider();
const driftReportPromise: Promise<CdktfDriftReport> = provider.refresh({
  state: { version: 4, resources: [] },
});

const report: CdktfImportReport = importCdktfState({ version: 4, resources: [] });
const resources: CdktfImportedResource[] = report.resources;

void driftReportPromise;
void resources;
