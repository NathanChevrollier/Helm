import { Octokit } from "@octokit/rest";
import type { CreatedIssue, FeedbackKind } from "../types/feedback.js";

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
