import type { DiscordAuthor, FeedbackInput } from "../types/feedback.js";

export function formatIssueTitle(input: Pick<FeedbackInput, "kind" | "title">): string {
  const prefix = input.kind === "bug" ? "Bug" : "Suggestion";
  return `[${prefix}] ${input.title.trim()}`;
}

export function formatIssueBody(input: FeedbackInput, author: DiscordAuthor): string {
  const section = input.kind === "bug" ? "Étapes et description" : "Description de l'amélioration";
  const context = input.context?.trim() || "Non fourni";

  return [
    `## ${section}`,
    "",
    input.description.trim(),
    "",
    "## Contexte",
    "",
    context,
    "",
    "## Auteur Discord",
    "",
    `- Utilisateur : ${author.username}`,
    `- Identifiant : \`${author.id}\``,
    `- Profil : <@${author.id}>`,
    `- Avatar : ${author.avatarUrl}`,
    "",
    "_Issue créée automatiquement par Helm Community Bot._",
  ].join("\n");
}
