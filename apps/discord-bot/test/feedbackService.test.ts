import { describe, expect, it } from "vitest";
import { formatIssueBody, formatIssueTitle } from "../src/services/feedbackService.js";

describe("feedbackService", () => {
  const author = { id: "123", username: "Natha#0001", avatarUrl: "https://cdn.discordapp.com/avatar.png" };

  it("formats a bug issue with the Discord author", () => {
    const input = { kind: "bug" as const, title: " Le terminal plante ", description: "Étape de reproduction", context: "Windows 11" };
    expect(formatIssueTitle(input)).toBe("[Bug] Le terminal plante");
    expect(formatIssueBody(input, author)).toContain("- Identifiant : `123`");
    expect(formatIssueBody(input, author)).toContain("Windows 11");
  });

  it("uses a fallback when context is absent", () => {
    const input = { kind: "suggestion" as const, title: "Exports CSV", description: "Ajouter un export CSV" };
    expect(formatIssueTitle(input)).toBe("[Suggestion] Exports CSV");
    expect(formatIssueBody(input, author)).toContain("Non fourni");
  });
});
