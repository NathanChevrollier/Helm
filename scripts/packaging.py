#!/usr/bin/env python3
"""Met à jour les manifestes de distribution (winget, Homebrew, AUR, Flatpak) pour une release.

    python3 scripts/packaging.py v1.0.0

Pour chaque manifeste, le script réécrit la version, les URL et les empreintes SHA-256 à partir des
assets réellement publiés sur la release GitHub. Il échoue si un asset manque ou si une empreinte
ne peut pas être obtenue : une empreinte devinée, c'est soit un paquet refusé, soit — pire — un
paquet accepté qui ne vérifie plus rien.

L'empreinte est lue dans le champ `digest` que GitHub fournit pour chaque asset ; à défaut
(anciennes releases), l'asset est téléchargé et haché localement.
"""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
import sys
import tempfile
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACKAGING = ROOT / "packaging"

# Asset attendu pour chaque rôle, d'après la version. Les noms sont ceux que produit tauri-action.
ASSETS = {
    "windows": "Helm_{v}_x64-setup.exe",
    "mac_arm": "Helm_{v}_aarch64.dmg",
    "mac_intel": "Helm_{v}_x64.dmg",
    "deb": "Helm_{v}_amd64.deb",
    "appimage": "Helm_{v}_amd64.AppImage",
}

SHA_RE = r"[0-9a-f]{64}"


def gh(*args: str) -> str:
    return subprocess.run(["gh", *args], check=True, capture_output=True, text=True, encoding="utf-8").stdout


def release_assets(tag: str) -> dict[str, dict]:
    """Assets de la release, indexés par nom."""
    data = json.loads(gh("release", "view", tag, "--json", "assets"))
    return {a["name"]: a for a in data.get("assets", [])}


def digest_of(tag: str, asset: dict, workdir: Path) -> str:
    """Empreinte SHA-256 d'un asset : celle de GitHub si elle existe, sinon calculée localement."""
    digest = (asset.get("digest") or "").removeprefix("sha256:")
    if re.fullmatch(SHA_RE, digest):
        return digest
    gh("release", "download", tag, "-p", asset["name"], "-D", str(workdir), "--clobber")
    h = hashlib.sha256()
    with open(workdir / asset["name"], "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def sub_once(text: str, pattern: str, repl: str, what: str) -> str:
    """Remplacement qui doit toucher exactement une occurrence : sinon le manifeste a changé de
    forme et le script refuse de deviner."""
    new, count = re.subn(pattern, repl, text, flags=re.MULTILINE)
    if count != 1:
        raise SystemExit(f"::error::{what} : {count} occurrence(s) trouvée(s) au lieu d'une")
    return new


def sub_all(text: str, pattern: str, repl: str, what: str) -> str:
    new, count = re.subn(pattern, repl, text, flags=re.MULTILINE)
    if count == 0:
        raise SystemExit(f"::error::{what} : aucune occurrence")
    return new


def update_winget(v: str, sha: dict[str, str], today: str) -> None:
    for path in (PACKAGING / "winget").glob("*.yaml"):
        text = path.read_text(encoding="utf-8")
        text = sub_once(text, r"^PackageVersion: .*$", f"PackageVersion: {v}", f"{path.name} PackageVersion")
        if path.name.endswith(".installer.yaml"):
            text = sub_once(text, r"^ReleaseDate: .*$", f"ReleaseDate: {today}", "winget ReleaseDate")
            text = sub_once(
                text,
                r"(InstallerUrl: https://github\.com/NathanChevrollier/Helm/releases/download/)v[^/]+/Helm_[^_]+_x64-setup\.exe",
                rf"\g<1>v{v}/{ASSETS['windows'].format(v=v)}",
                "winget InstallerUrl",
            )
            text = sub_once(text, rf"(InstallerSha256: ){SHA_RE}", rf"\g<1>{sha['windows'].upper()}", "winget InstallerSha256")
        if "ReleaseNotesUrl" in text:
            text = sub_once(text, r"(ReleaseNotesUrl: .*/releases/tag/)v.*$", rf"\g<1>v{v}", f"{path.name} ReleaseNotesUrl")
        path.write_text(text, encoding="utf-8")


def update_homebrew(v: str, sha: dict[str, str]) -> None:
    path = PACKAGING / "homebrew" / "helm-desktop.rb"
    text = path.read_text(encoding="utf-8")
    text = sub_once(text, r'^  version ".*"$', f'  version "{v}"', "cask version")
    # Deux blocs : on_arm puis on_intel, chacun avec sa propre empreinte, dans cet ordre.
    parts = re.split(r"(  on_intel do)", text)
    if len(parts) != 3:
        raise SystemExit("::error::cask : blocs on_arm / on_intel introuvables")
    arm, sep, intel = parts
    arm = sub_once(arm, rf'(sha256 "){SHA_RE}(")', rf"\g<1>{sha['mac_arm']}\g<2>", "cask sha256 arm")
    intel = sub_once(intel, rf'(sha256 "){SHA_RE}(")', rf"\g<1>{sha['mac_intel']}\g<2>", "cask sha256 intel")
    path.write_text(arm + sep + intel, encoding="utf-8")


def update_aur(v: str, sha: dict[str, str]) -> None:
    path = PACKAGING / "aur" / "PKGBUILD"
    text = path.read_text(encoding="utf-8")
    text = sub_once(text, r"^pkgver=.*$", f"pkgver={v}", "PKGBUILD pkgver")
    # Nouvelle version : le numéro de révision du paquet repart à 1.
    text = sub_once(text, r"^pkgrel=.*$", "pkgrel=1", "PKGBUILD pkgrel")
    text = sub_once(text, rf"^(sha256sums_x86_64=\('){SHA_RE}('\))$", rf"\g<1>{sha['deb']}\g<2>", "PKGBUILD sha256sums")
    path.write_text(text, encoding="utf-8")


def update_flatpak(v: str, sha: dict[str, str], today: str) -> None:
    path = PACKAGING / "flatpak" / "dev.helm.desktop.yml"
    text = path.read_text(encoding="utf-8")
    text = sub_once(
        text,
        r"(url: https://github\.com/NathanChevrollier/Helm/releases/download/)v[^/]+/Helm_[^_]+_amd64\.AppImage",
        rf"\g<1>v{v}/{ASSETS['appimage'].format(v=v)}",
        "flatpak url",
    )
    text = sub_once(text, rf"(        sha256: ){SHA_RE}", rf"\g<1>{sha['appimage']}", "flatpak sha256")
    path.write_text(text, encoding="utf-8")

    meta = PACKAGING / "flatpak" / "dev.helm.desktop.metainfo.xml"
    xml = meta.read_text(encoding="utf-8")
    if f'<release version="{v}"' not in xml:
        # La plus récente en tête : c'est l'ordre attendu par AppStream.
        xml = sub_once(xml, r"(  <releases>\n)", rf'\g<1>    <release version="{v}" date="{today}" />\n', "metainfo releases")
    meta.write_text(xml, encoding="utf-8")


def main() -> None:
    if len(sys.argv) != 2 or not re.fullmatch(r"v\d+\.\d+\.\d+(-[\w.]+)?", sys.argv[1]):
        raise SystemExit("usage : packaging.py vX.Y.Z")
    tag = sys.argv[1]
    v = tag[1:]
    today = date.today().isoformat()

    assets = release_assets(tag)
    missing = [ASSETS[k].format(v=v) for k in ASSETS if ASSETS[k].format(v=v) not in assets]
    if missing:
        raise SystemExit(f"::error::assets absents de la release {tag} : {', '.join(missing)}")

    with tempfile.TemporaryDirectory() as tmp:
        sha = {k: digest_of(tag, assets[name.format(v=v)], Path(tmp)) for k, name in ASSETS.items()}

    update_winget(v, sha, today)
    update_homebrew(v, sha)
    update_aur(v, sha)
    update_flatpak(v, sha, today)
    for k, h in sha.items():
        print(f"{ASSETS[k].format(v=v):32} {h}")
    print(f"Manifestes mis à jour pour {tag}. Pense à « makepkg --printsrcinfo > .SRCINFO » pour l'AUR.")


if __name__ == "__main__":
    main()
