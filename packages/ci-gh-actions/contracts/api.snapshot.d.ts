export declare function createGithubActionsWorkSource(options: GithubWorkOptions): WorkSource;
export declare function createGithubActionsWorkRunner(): WorkRunner;
export type GithubWorkOptions = Readonly<{
    poller: GithubJobPollerOptions;
    mintRegistration(input: Readonly<{
        repository: string;
        labels: readonly string[];
        runnerName: string;
    }>): Promise<Outcome<Uint8Array>>;
    now: Clock;
    log: FleetLog;
}>;
