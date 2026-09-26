import { describe, expect, it } from "vitest";
import { humanSchedule, isValidSchedule, replaceJob } from "./crontab";

describe("crontab", () => {
  it("décrit les formes courantes", () => {
    expect(humanSchedule("0 3 * * *")).toBe("chaque jour à 03:00");
    expect(humanSchedule("*/5 * * * *")).toBe("toutes les 5 minutes");
    expect(humanSchedule("30 2 * * 1")).toBe("chaque lundi à 02:30");
    expect(humanSchedule("0 4 1 * *")).toBe("le 1er de chaque mois à 04:00");
    expect(humanSchedule("@reboot")).toBe("au démarrage du serveur");
    expect(humanSchedule("1-59/7 */3 * 2 *")).toBeNull();
  });

  it("valide la syntaxe", () => {
    expect(isValidSchedule("0 3 * * *")).toBe(true);
    expect(isValidSchedule("@daily")).toBe(true);
    expect(isValidSchedule("0 3 * *")).toBe(false);
    expect(isValidSchedule("0 3 * * * ;rm")).toBe(false);
  });

  it("modifie, retire et ajoute une ligne en gardant le reste", () => {
    const raw = "# sauvegardes\nMAILTO=\"\"\n0 3 * * * /opt/backup.sh\n*/5 * * * *   curl -s https://x\n";
    expect(replaceJob(raw, { schedule: "0 3 * * *", command: "/opt/backup.sh" }, "0 4 * * * /opt/backup.sh")).toBe(
      "# sauvegardes\nMAILTO=\"\"\n0 4 * * * /opt/backup.sh\n*/5 * * * *   curl -s https://x\n",
    );
    expect(replaceJob(raw, { schedule: "*/5 * * * *", command: "curl -s https://x" }, null)).toBe("# sauvegardes\nMAILTO=\"\"\n0 3 * * * /opt/backup.sh\n");
    expect(replaceJob("", null, "@reboot /opt/start.sh")).toBe("@reboot /opt/start.sh\n");
  });
});
