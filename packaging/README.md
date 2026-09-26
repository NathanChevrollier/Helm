# Distribution de Helm

Ce dossier rassemble ce qui permet d'installer Helm autrement qu'en téléchargeant l'installeur à la
main : gestionnaires de paquets officiels de chaque système, et signature de code Windows.

| Système | Commande | Fichier de référence | État |
| --- | --- | --- | --- |
| Windows | `winget install NathanChevrollier.Helm` | [`winget/`](winget/) | soumission à `microsoft/winget-pkgs` (workflow `winget.yml`) |
| macOS | `brew install --cask helm-desktop` | [`homebrew/helm-desktop.rb`](homebrew/helm-desktop.rb) | demande un tap (`NathanChevrollier/homebrew-tap`) |
| Arch Linux | `yay -S helm-desktop-bin` | [`aur/PKGBUILD`](aur/PKGBUILD) | demande un dépôt AUR |
| Flatpak | `flatpak install flathub dev.helm.desktop` | [`flatpak/dev.helm.desktop.yml`](flatpak/dev.helm.desktop.yml) | soumission à Flathub |

Tous ces fichiers pointent vers les installeurs d'une release GitHub et se régénèrent d'une commande :

```bash
python3 scripts/packaging.py v1.0.0
```

Le script télécharge les empreintes SHA-256 des assets de la release et réécrit chaque manifeste.
Il échoue plutôt que d'écrire une empreinte devinée : un paquet dont l'empreinte ne correspond pas
est rejeté par le gestionnaire, et pire, une empreinte fausse mais acceptée signifierait qu'on ne
vérifie rien.

## Signature de code Windows (SignPath)

Sans signature, SmartScreen affiche « Éditeur inconnu » à la première exécution. Helm demande un
certificat gratuit à la [SignPath Foundation](https://signpath.org/apply), réservé aux projets
libres.

Le workflow `release.yml` contient déjà le job `sign-windows`. Il ne se déclenche que si les trois
secrets du dépôt existent, si bien que la chaîne de release fonctionne à l'identique avant
l'approbation :

| Secret | Où le trouver |
| --- | --- |
| `SIGNPATH_API_TOKEN` | SignPath → *User settings* → *API tokens* |
| `SIGNPATH_ORGANIZATION_ID` | SignPath → *Organization* → identifiant affiché dans l'URL |
| `SIGNPATH_PROJECT_SLUG` | nom du projet créé dans SignPath (`helm`) |

**Point d'attention** : signer l'installeur modifie ses octets, donc *invalide* la signature de mise
à jour de Tauri (`.sig`). Le job recalcule donc cette signature après la signature de code, avec la
clé `TAURI_SIGNING_PRIVATE_KEY`, et remplace l'installeur *et* son `.sig` sur la release. Le
`latest.json` est construit après, dans le job `publish` : il reprend automatiquement la bonne
signature. Inverser cet ordre livrerait une release dont les mises à jour automatiques échouent avec
« signature invalide ».

## Ce que chaque canal demande, une fois pour toutes

* **winget** : une pull request sur `microsoft/winget-pkgs`. Le workflow `winget.yml` la soumet à
  chaque release publiée, avec un jeton personnel (`WINGET_TOKEN`, portée `public_repo`) sur un fork
  du dépôt. La première soumission est relue par un humain ; les suivantes sont automatiques.
* **Homebrew Cask** : un tap personnel suffit (`brew tap NathanChevrollier/tap`). Entrer dans
  `homebrew/homebrew-cask` demande une notarisation Apple, que Helm n'a pas encore.
* **AUR** : un dépôt Git `ssh://aur@aur.archlinux.org/helm-desktop-bin.git`, avec `PKGBUILD` et
  `.SRCINFO` (`makepkg --printsrcinfo > .SRCINFO`).
* **Flathub** : une pull request sur `flathub/flathub`. Le manifeste part de l'AppImage plutôt que
  des sources : reconstruire Tauri dans le bac à sable de Flatpak demanderait d'y embarquer toute la
  chaîne Rust et Node.
