#!/usr/bin/env python3
"""Construit le latest.json d'une release (mises à jour automatiques de Helm).

Les quatre machines de compilation publient leurs installeurs en parallèle ; si chacune met aussi
le latest.json à jour, elles s'écrasent (et l'une d'elles échoue sur un 404). Ce script est donc
lancé une seule fois, après tous les builds : il lit les signatures déposées sur la release et
écrit le manifeste complet.

    python3 scripts/latest-json.py v0.4.0

Il échoue si une plateforme manque : mieux vaut une release non publiée qu'une mise à jour
automatique qui oublie Windows ou macOS.
"""

import json
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

# Suffixe de l'installeur → clés de plateforme du format « latest.json » de Tauri.
PLATFORMS = [
    ("_x64.app.tar.gz", ["darwin-x86_64", "darwin-x86_64-app"]),
    ("_aarch64.app.tar.gz", ["darwin-aarch64", "darwin-aarch64-app"]),
    (".AppImage", ["linux-x86_64", "linux-x86_64-appimage"]),
    (".deb", ["linux-x86_64-deb"]),
    (".rpm", ["linux-x86_64-rpm"]),
    ("-setup.exe", ["windows-x86_64", "windows-x86_64-nsis"]),
]


def gh(*args: str) -> str:
    return subprocess.run(["gh", *args], check=True, capture_output=True, text=True, encoding="utf-8").stdout


def repository() -> str:
    return json.loads(gh("repo", "view", "--json", "nameWithOwner"))["nameWithOwner"]


def build(tag: str, signatures: Path, repo: str) -> dict:
    version = tag.lstrip("v")
    platforms: dict[str, dict[str, str]] = {}
    missing = []
    for suffix, keys in PLATFORMS:
        found = [f for f in sorted(signatures.glob("*.sig")) if f.name[: -len(".sig")].endswith(suffix)]
        if not found:
            missing.append(suffix)
            continue
        installer = found[0].name[: -len(".sig")]
        entry = {
            "signature": found[0].read_text(encoding="utf-8").strip(),
            "url": f"https://github.com/{repo}/releases/latest/download/{installer}",
        }
        for key in keys:
            platforms[key] = entry
    if missing:
        raise SystemExit(f"::error::signatures manquantes pour {', '.join(missing)} : la release n'est pas complète")
    return {
        "version": version,
        "notes": "",
        "pub_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "platforms": platforms,
    }


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage : latest-json.py <tag>")
    tag = sys.argv[1]
    repo = repository()
    with tempfile.TemporaryDirectory() as tmp:
        directory = Path(tmp)
        gh("release", "download", tag, "-p", "*.sig", "-D", str(directory), "--clobber")
        manifest = build(tag, directory, repo)
        target = directory / "latest.json"
        target.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        gh("release", "upload", tag, str(target), "--clobber")
    print(f"latest.json publié pour {tag} : {', '.join(sorted(manifest['platforms']))}")


if __name__ == "__main__":
    main()
