"""Génère THIRD_PARTY_NOTICES.md : licences des composants tiers embarqués dans Zenytt.

Les licences MIT, Apache, BSD… imposent de fournir leur texte (et la mention de copyright) avec
les binaires distribués. On part des dépendances réellement compilées (hors dépendances de
développement) : crates Rust de l'application, de l'agent et de zenytt-sync, paquets npm de
production du front. Les textes identiques ne sont écrits qu'une fois.

Usage : python scripts/third-party-notices.py   (à relancer quand les dépendances changent)
"""

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "THIRD_PARTY_NOTICES.md"
LICENSE_NAMES = ("LICENSE", "LICENCE", "COPYING", "NOTICE", "UNLICENSE")
SPDX_DIR = Path(__file__).resolve().parent / "licenses"


def spdx_ids(expression):
    """Identifiants SPDX connus d'une expression (« MIT OR Apache-2.0 », « MIT/Apache-2.0 »…)."""
    words = expression.replace("/", " ").replace("(", " ").replace(")", " ").split()
    return [w for w in dict.fromkeys(words) if (SPDX_DIR / f"{w}.txt").is_file()]


def run(cmd, cwd=ROOT):
    return subprocess.run(cmd, cwd=cwd, check=True, capture_output=True, text=True, encoding="utf-8", shell=os.name == "nt").stdout


def license_texts(directory):
    """Fichiers de licence d'un paquet (LICENSE, LICENSE-MIT, NOTICE…), triés par nom."""
    texts = []
    if not directory or not directory.is_dir():
        return texts
    for f in sorted(directory.iterdir()):
        if f.is_file() and f.name.upper().startswith(LICENSE_NAMES):
            try:
                texts.append((f.name, f.read_text(encoding="utf-8", errors="replace").strip()))
            except OSError:
                pass
    return texts


def cargo_packages(manifest):
    """Crates tierces compilées pour ce manifeste (dépendances normales et de build)."""
    meta = json.loads(run(["cargo", "metadata", "--format-version", "1", "--manifest-path", str(manifest)]))
    members = set(meta["workspace_members"])
    by_id = {p["id"]: p for p in meta["packages"]}
    nodes = {n["id"]: n for n in meta["resolve"]["nodes"]}
    seen, stack = set(), list(members)
    while stack:
        pid = stack.pop()
        if pid in seen:
            continue
        seen.add(pid)
        for dep in nodes[pid]["deps"]:
            if any(k["kind"] != "dev" for k in dep["dep_kinds"]):
                stack.append(dep["pkg"])
    out = []
    for pid in seen - members:
        p = by_id[pid]
        out.append({
            "name": p["name"],
            "version": p["version"],
            "license": p.get("license") or "voir le texte",
            "url": p.get("repository") or p.get("homepage") or f"https://crates.io/crates/{p['name']}",
            "texts": license_texts(Path(p["manifest_path"]).parent),
        })
    return out


def npm_packages():
    data = json.loads(run(["pnpm", "--filter", "zenytt-desktop", "licenses", "list", "--prod", "--json"]))
    out = []
    for lic, pkgs in data.items():
        for p in pkgs:
            for version, path in zip(p.get("versions", []), p.get("paths", [])):
                out.append({
                    "name": p["name"],
                    "version": version,
                    "license": lic,
                    "url": p.get("homepage") or f"https://www.npmjs.com/package/{p['name']}",
                    "texts": license_texts(Path(path)),
                })
    return out


def main():
    packages = {}
    for manifest in (ROOT / "Cargo.toml", ROOT / "sync-server" / "Cargo.toml"):
        for p in cargo_packages(manifest):
            packages[("crate", p["name"], p["version"])] = p
    for p in npm_packages():
        packages[("npm", p["name"], p["version"])] = p

    blocks, lines = {}, []
    for (kind, name, version), p in sorted(packages.items(), key=lambda kv: (kv[0][1].lower(), kv[0][2])):
        refs = []
        for fname, text in p["texts"]:
            digest = hashlib.sha256(text.encode()).hexdigest()[:12]
            blocks.setdefault(digest, (fname, text))
            refs.append(f"[{fname}](#t-{digest})")
        if not refs:
            # Le paquet ne livre pas son texte : on renvoie au texte SPDX de référence
            # (scripts/licenses/), la mention de copyright se trouvant dans le dépôt du paquet.
            for spdx in spdx_ids(p["license"]):
                blocks.setdefault(f"spdx-{spdx}", (f"{spdx} (texte de référence SPDX)", (SPDX_DIR / f"{spdx}.txt").read_text(encoding="utf-8").strip()))
                refs.append(f"[{spdx}](#t-spdx-{spdx})")
        lines.append(f"| {name} | {version} | {kind} | {p['license']} | <{p['url']}> | {', '.join(refs)} |")

    doc = [
        "# Composants tiers",
        "",
        "Zenytt s'appuie sur les logiciels libres listés ci-dessous. Chacun reste sous sa propre licence,",
        "reproduite plus bas ; la licence de Zenytt (voir LICENSE) ne s'applique pas à eux.",
        "",
        "Les composants sous MPL-2.0 (@novnc/novnc, cssparser, selectors…) sont utilisés sans",
        "modification : leur code source est disponible à l'adresse indiquée pour chacun.",
        "Les polices IBM Plex Sans et JetBrains Mono sont distribuées sous SIL Open Font License 1.1.",
        "",
        f"Fichier généré par `scripts/third-party-notices.py` ({len(packages)} composants).",
        "",
        "| Composant | Version | Type | Licence | Source | Texte |",
        "|---|---|---|---|---|---|",
        *lines,
        "",
        "## Textes des licences",
        "",
    ]
    for digest, (fname, text) in blocks.items():
        doc += [f'<a id="t-{digest}"></a>', f"### {fname} ({digest})", "", "```text", text.replace("```", "'''"), "```", ""]
    OUT.write_text("\n".join(doc), encoding="utf-8", newline="\n")
    print(f"{OUT.name} : {len(packages)} composants, {len(blocks)} textes, {OUT.stat().st_size // 1024} Kio", file=sys.stderr)


if __name__ == "__main__":
    main()
