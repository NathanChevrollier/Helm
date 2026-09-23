export type FeedbackKind = "bug" | "suggestion";

export interface FeedbackInput {
  kind: FeedbackKind;
  title: string;
  description: string;
  context?: string;
}

export interface DiscordAuthor {
  id: string;
  username: string;
  avatarUrl: string;
}

export interface CreatedIssue {
  number: number;
  url: string;
}
