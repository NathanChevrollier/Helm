import { describe, expect, it } from "vitest";
import { roadmapColumn } from "../src/services/githubService.js";
import { formatIssueTable } from "../src/services/roadmapService.js";

describe("roadmap", () => {
  it("range les cartes selon leur statut, en français comme en anglais", () => {
    expect(roadmapColumn("Todo")).toBe("brainstorming");
    expect(roadmapColumn("💡 Idées")).toBe("brainstorming");
    expect(roadmapColumn(undefined)).toBe("brainstorming");
    expect(roadmapColumn("In Progress")).toBe("inProgress");
    expect(roadmapColumn("🔵 En cours")).toBe("inProgress");
    expect(roadmapColumn("En test")).toBe("test");
    expect(roadmapColumn("In review")).toBe("test");
    expect(roadmapColumn("Done")).toBe("done");
    expect(roadmapColumn("✅ Terminé")).toBe("done");
  });

  it("affiche un brouillon du projet sans lien ni numéro", () => {
    expect(formatIssueTable([{ title: "Refonte *graphique*", assignees: [], state: "open" }])).toBe("• Refonte \\*graphique\\*");
  });
});
