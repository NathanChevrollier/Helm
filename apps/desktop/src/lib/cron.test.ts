import { describe, expect, it } from "vitest";
import { describeCron } from "./cron";

describe("describeCron", () => {
  it("reconnaît le renouvellement des certificats", () => {
    const d = describeCron("test -x /usr/bin/certbot && certbot -q renew --no-random-sleep-on-renew");
    expect(d).toContain("Let's Encrypt");
  });

  it("décrit un script maison, son journal et sa surveillance", () => {
    const d = describeCron("HC_URL=https://hc-ping.com/1dfc /usr/local/bin/backup-vps.sh >> /var/log/backup-vps.log 2>&1")!;
    expect(d).toContain("/usr/local/bin/backup-vps.sh");
    expect(d).toContain("Healthchecks");
    expect(d).toContain("/var/log/backup-vps.log");
  });

  it("prévient quand la sortie est jetée", () => {
    expect(describeCron("/usr/local/bin/check.sh > /dev/null 2>&1")).toContain("rien ne sera visible");
  });

  it("explique les dossiers cron.daily et anacron", () => {
    const d = describeCron("test -x /usr/sbin/anacron || { cd / && run-parts --report /etc/cron.daily; }")!;
    expect(d).toContain("/etc/cron.daily");
    expect(d).toContain("anacron");
  });

  it("nomme le service redémarré", () => {
    expect(describeCron("systemctl restart nginx")).toContain("nginx");
  });

  it("ne décrit pas ce qu'il ne reconnaît pas", () => {
    expect(describeCron("/opt/truc/machin --bidule")).toBeNull();
  });
});
