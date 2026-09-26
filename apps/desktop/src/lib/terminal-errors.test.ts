import { describe, expect, it } from "vitest";
import { diagnosePrompt, findLastFailure } from "./terminal-errors";

describe("détection d'un échec au terminal", () => {
  it("retrouve la commande et sa sortie", () => {
    const lines = [
      "alice@vps:~$ ls",
      "site  notes.txt",
      "alice@vps:~$ systemctl restart nginx",
      "Job for nginx.service failed because the control process exited with error code.",
      "See \"systemctl status nginx.service\" for details.",
      "alice@vps:~$ ",
    ];
    const f = findLastFailure(lines);
    expect(f).not.toBeNull();
    expect(f!.command).toBe("systemctl restart nginx");
    // La sortie retenue commence après l'invite fautive, pas avant.
    expect(f!.output).toContain("Job for nginx.service failed");
    expect(f!.output).not.toContain("notes.txt");
    expect(f!.reason).toContain("Job for nginx.service failed");
  });

  it("garde le dernier échec, pas le premier", () => {
    const lines = [
      "root@vps:/# cat absent",
      "cat: absent: No such file or directory",
      "root@vps:/# docker ps",
      "CONTAINER ID   IMAGE",
      "root@vps:/# docker logs inconnu",
      "Error: No such container: inconnu",
      "root@vps:/# ",
    ];
    expect(findLastFailure(lines)!.command).toBe("docker logs inconnu");
  });

  it("ne crie pas au loup sur une sortie normale", () => {
    const lines = [
      "alice@vps:~$ docker ps",
      "CONTAINER ID   IMAGE          STATUS",
      "abc123         nginx:alpine   Up 3 days",
      "alice@vps:~$ tail -n1 /var/log/nginx/access.log",
      '10.0.0.1 - - [12/Mar/2026:10:00:00] "GET /error-page HTTP/1.1" 200 12',
      "alice@vps:~$ ",
    ];
    expect(findLastFailure(lines)).toBeNull();
  });

  it("ignore les barres de progression et les lignes vides", () => {
    const lines = ["alice@vps:~$ apt-get install truc", "  45%", "[####=====]", "E: Unable to locate package truc", "", "alice@vps:~$ "];
    const f = findLastFailure(lines)!;
    expect(f.command).toBe("apt-get install truc");
    expect(f.output).toBe("E: Unable to locate package truc");
  });

  it("fonctionne sans invite reconnaissable", () => {
    const f = findLastFailure(["bash: helmd: command not found"])!;
    expect(f.command).toBeNull();
    expect(f.output).toContain("command not found");
  });

  it("demande la cause puis la correction", () => {
    const prompt = diagnosePrompt({ command: "systemctl restart nginx", output: "x", reason: "x" });
    expect(prompt).toContain("systemctl restart nginx");
    expect(prompt).toContain("pourquoi elle a échoué");
    expect(prompt).toContain("la commande exacte qui corrige");
  });
});
