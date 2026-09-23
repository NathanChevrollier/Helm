import { Octokit } from "@octokit/rest";
import type { CreatedIssue, FeedbackKind } from "../types/feedback.js";

export interface RoadmapIssue {
  number: number;
  title: string;
  url: string;
  assignees: string[];
  state: "open" | "closed";
}

export class GitHubService {
  private readonly client: Octokit;

  public constructor(
    private readonly owner: string,
    private readonly repo: string,
    token: string,
    private readonly labels: Record<FeedbackKind, string>,
  ) {
    this.client = new Octokit({ auth: token, userAgent: "helm-discord-bot" });
  }

  public async createIssue(title: string, body: string, kind: FeedbackKind): Promise<CreatedIssue> {
    const label = this.labels[kind];
    await this.ensureLabel(label, kind === "bug" ? "d73a4a" : "a2eeef");

    try {
      const response = await this.client.rest.issues.create({
        owner: this.owner,
        repo: this.repo,
        title,
        body,
        labels: [label],
      });
      return { number: response.data.number, url: response.data.html_url };
    } catch (error) {
      throw new Error(`GitHub n'a pas pu créer l'issue: ${describeGitHubError(error)}`);
    }
  }

  public async getLatestRelease(): Promise<{ tagName: string; url: string } | null> {
    try {
      const response = await this.client.rest.repos.getLatestRelease({ owner: this.owner, repo: this.repo });
      return { tagName: response.data.tag_name, url: response.data.html_url };
    } catch (error) {
      if (getStatus(error) === 404) return null;
      throw new Error(`GitHub n'a pas pu lire la dernière release: ${describeGitHubError(error)}`);
    }
  }

  public async getRoadmapIssues(labels: { brainstorming: string; inProgress: string; test: string; done: string }): Promise<{
    brainstorming: RoadmapIssue[];
    inProgress: RoadmapIssue[];
    test: RoadmapIssue[];
    done: RoadmapIssue[];
  }> {
    const [brainstorming, inProgress, test, done] = await Promise.all([
      this.getIssuesByLabel(labels.brainstorming),
      this.getIssuesByLabel(labels.inProgress),
      this.getIssuesByLabel(labels.test),
      this.getIssuesByLabel(labels.done),
    ]);
    const seen = new Set<number>();
    const unique = (issues: RoadmapIssue[]) => issues.filter((issue) => !seen.has(issue.number) && seen.add(issue.number));
    return {
      brainstorming: unique(brainstorming),
      inProgress: unique(inProgress),
      test: unique(test),
      done: unique(done),
    };
  }

  public async getProjectRoadmapIssues(projectNumber: number): Promise<{
    brainstorming: RoadmapIssue[];
    inProgress: RoadmapIssue[];
    test: RoadmapIssue[];
    done: RoadmapIssue[];
  }> {
    try {
      const response = await this.client.graphql<{
        repository: {
          projectV2: {
            items: {
              nodes: Array<{
                content: {
                  number?: number;
                  title?: string;
                  url?: string;
                  state?: "OPEN" | "CLOSED";
                  assignees?: { nodes: Array<{ login: string }> };
                } | null;
                fieldValues: {
                  nodes: Array<{
                    name?: string | null;
                    field?: { name?: string | null } | null;
                  } | null>;
                };
              }>;
            };
          } | null;
        };
      }>(
        `query Roadmap($owner: String!, $repo: String!, $number: Int!) {
          repository(owner: $owner, name: $repo) {
            projectV2(number: $number) {
              items(first: 100) {
                nodes {
                  content {
                    ... on Issue {
                      number
                      title
                      url
                      state
                      assignees(first: 10) { nodes { login } }
                    }
                  }
                  fieldValues(first: 20) {
                    nodes {
                      ... on ProjectV2ItemFieldSingleSelectValue {
                        name
                        field { ... on ProjectV2SingleSelectField { name } }
                      }
                    }
                  }
                }
              }
            }
          }
        }`,
        { owner: this.owner, repo: this.repo, number: projectNumber },
      );
      if (!response.repository.projectV2) throw new Error(`Projet GitHub #${projectNumber} introuvable`);

      const columns = { brainstorming: [], inProgress: [], test: [], done: [] } as Record<"brainstorming" | "inProgress" | "test" | "done", RoadmapIssue[]>;
      for (const item of response.repository.projectV2.items.nodes) {
        if (!item.content || typeof item.content.number !== "number" || !item.content.title || !item.content.url || !item.content.state) continue;
        const status = item.fieldValues.nodes.find((field) => field?.field?.name?.toLowerCase() === "status")?.name?.toLowerCase();
        const key = status === "brainstorming" ? "brainstorming" : status === "in progress" ? "inProgress" : status === "test" ? "test" : status === "done" ? "done" : undefined;
        if (!key) continue;
        columns[key].push({
          number: item.content.number,
          title: item.content.title,
          url: item.content.url,
          assignees: (item.content.assignees?.nodes ?? []).map((assignee) => assignee.login),
          state: item.content.state === "CLOSED" ? "closed" : "open",
        });
      }
      return columns;
    } catch (error) {
      throw new Error(`GitHub n'a pas pu lire le Project #${projectNumber}: ${describeGitHubError(error)}`);
    }
  }

  private async getIssuesByLabel(label: string): Promise<RoadmapIssue[]> {
    try {
      const response = await this.client.paginate(this.client.rest.issues.listForRepo, {
        owner: this.owner,
        repo: this.repo,
        state: "all",
        labels: label,
        per_page: 100,
        sort: "updated",
        direction: "desc",
      });
      return response
        .filter((issue) => !issue.pull_request)
        .map((issue) => ({
          number: issue.number,
          title: issue.title,
          url: issue.html_url,
          assignees: (issue.assignees ?? []).map((assignee) => assignee.login),
          state: issue.state === "closed" ? "closed" : "open",
        }));
    } catch (error) {
      throw new Error(`GitHub n'a pas pu lire les issues « ${label} »: ${describeGitHubError(error)}`);
    }
  }

  private async ensureLabel(name: string, color: string): Promise<void> {
    try {
      await this.client.rest.issues.getLabel({ owner: this.owner, repo: this.repo, name });
    } catch (error) {
      if (getStatus(error) !== 404) {
        throw new Error(`GitHub n'a pas pu vérifier le label « ${name} »: ${describeGitHubError(error)}`);
      }
      try {
        await this.client.rest.issues.createLabel({ owner: this.owner, repo: this.repo, name, color });
      } catch (createError) {
        // Deux instances démarrées ensemble peuvent créer le même label: relire dans ce cas.
        if (getStatus(createError) !== 422) {
          throw new Error(`GitHub n'a pas pu créer le label « ${name} »: ${describeGitHubError(createError)}`);
        }
      }
    }
  }
}

function getStatus(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "status" in error && typeof error.status === "number") {
    return error.status;
  }
  return undefined;
}

function describeGitHubError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "erreur inconnue";
}
