import type { DiscordAuthor, FeedbackInput } from "../types/feedback.js";

/**
 * Texte saisi sur Discord, rendu inoffensif sur GitHub : une mention `@quelqu'un` ou `@org/équipe`
 * notifierait de vraies personnes, et `#123` relierait l'issue à une autre. Un caractère invisible
 * (U+200B) casse le lien sans changer ce qu'on lit.
 */
export function neutralize(text: string): string {
  return text.replace(/@(?=[A-Za-z0-9])/g, "@\u200b").replace(/(^|[^\w&])#(?=\d)/g, "$1#\u200b");
}

export function formatIssueTitle(input: Pick<FeedbackInput, "kind" | "title">): string {
  const prefix = input.kind === "bug" ? "Bug" : "Suggestion";
  return `[${prefix}] ${neutralize(input.title.trim())}`;
}

export function formatIssueBody(input: FeedbackInput, author: DiscordAuthor): string {
  const section = input.kind === "bug" ? "Étapes et description" : "Description de l'amélioration";
  const context = neutralize(input.context?.trim() || "Non fourni");

  return [
    `## ${section}`,
    "",
    neutralize(input.description.trim()),
    "",
    "## Contexte",
    "",
    context,
    "",
    "## Auteur Discord",
    "",
    `- Utilisateur : ${neutralize(author.username)}`,
    `- Identifiant : \`${author.id}\``,
    `- Profil : <@${author.id}>`,
    `- Avatar : ${author.avatarUrl}`,
    "",
    "_Issue créée automatiquement par Helm Community Bot._",
  ].join("\n");
}
