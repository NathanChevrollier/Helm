import { describe, expect, it } from "vitest";
import { cwdFromPrompt, cwdFromPromptLine } from "./prompt-cwd";

describe("cwdFromPromptLine", () => {
  it("lit un chemin absolu", () => {
    expect(cwdFromPromptLine("root@vps:/etc/nginx# ")).toBe("/etc/nginx");
    expect(cwdFromPromptLine("alice@web-01:/var/log$ tail -f syslog")).toBe("/var/log");
    expect(cwdFromPromptLine("root@vps:/# ls")).toBe("/");
  });

  it("développe le dossier personnel", () => {
    expect(cwdFromPromptLine("root@vps:~# ")).toBe("/root");
    expect(cwdFromPromptLine("root@vps:~/sites/blog# ")).toBe("/root/sites/blog");
    expect(cwdFromPromptLine("alice@vps:~$ ")).toBe("/home/alice");
    expect(cwdFromPromptLine("root@vps:~bob/app# ")).toBe("/home/bob/app");
  });

  it("accepte un préfixe (virtualenv, chroot)", () => {
    expect(cwdFromPromptLine("(venv) alice@vps:/opt/app$ ")).toBe("/opt/app");
    expect(cwdFromPromptLine("(debian)root@vps:/srv# ")).toBe("/srv");
  });

  it("ignore ce qui n'est pas une invite", () => {
    expect(cwdFromPromptLine("total 48")).toBeNull();
    expect(cwdFromPromptLine("drwxr-xr-x 2 root root 4096 sites")).toBeNull();
    expect(cwdFromPromptLine("")).toBeNull();
  });
});

describe("cwdFromPrompt", () => {
  it("prend la dernière invite, même pendant qu'une commande tourne", () => {
    expect(cwdFromPrompt(["alice@vps:~$ sudo -i", "root@vps:~# cd /etc", "root@vps:/etc# top", "Tasks: 90 total"])).toBe("/etc");
    expect(cwdFromPrompt(["rien", "à voir"])).toBeNull();
  });
});
