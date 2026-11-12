/** Facts captured from GitHub, kept separate from workflow interpretations (#683). */
export type Page<T> = {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  totalCount?: number;
};
export type Comment = {
  body: string;
  url: string;
  author: { login: string } | null;
  createdAt?: string;
  updatedAt?: string;
};
export type Check = {
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string | null;
  state?: string;
  detailsUrl?: string | null;
  targetUrl?: string | null;
};
export type NativeNode = {
  number: number;
  title: string;
  url: string;
  state: string;
  stateReason?: string | null;
  repository: { nameWithOwner: string };
  issueDependenciesSummary: {
    blockedBy: number;
    totalBlockedBy: number;
    blocking: number;
    totalBlocking: number;
  };
};
export type Issue = {
  issueDependenciesSummary?: NativeNode["issueDependenciesSummary"];
  blockedBy?: Page<NativeNode>;
  blocking?: Page<NativeNode>;
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  stateReason?: string | null;
  lastEditedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  labels: Page<{ name: string }>;
  comments: Page<Comment>;
};
export type PullRequest = Issue & {
  headRefOid: string;
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision: string | null;
  mergedAt?: string | null;
  closingIssuesReferences: Page<{ number: number; url: string }>;
  reviewThreads: Page<{
    isResolved: boolean;
    isOutdated: boolean;
    comments: Page<Comment>;
  }>;
  reviews: Page<Comment & { state: string }>;
  commits: {
    nodes: { commit: { statusCheckRollup: { state: string; contexts: Page<Check> } | null } }[];
  };
};
export type Reference = { repository: string; number: number; url: string };
export type Dependency = Reference & {
  available: boolean;
  state?: string;
  stateReason?: string | null;
  mergedAt?: string | null;
  title?: string;
};
export type Snapshot = {
  schemaVersion: 1;
  repository: string;
  startedAt: string;
  fetchedAt: string;
  issues: Issue[];
  pullRequests: PullRequest[];
  dependencies: Dependency[];
  changed: { number: number; title: string; url: string; state: string; updatedAt: string }[];
  since: string | null;
  warnings: string[];
  metrics?: { requestCount: number; durationMs: number };
  rateLimit: { remaining: number; resetAt: string } | null;
};
export type Action = {
  rule: string;
  priority: number;
  target: string;
  title: string;
  reason: string;
  next: string;
  evidence: string[];
  uncertainty: "factual" | "candidate";
};
