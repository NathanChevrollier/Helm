# Identité visuelle de Zenytt

Le symbole « Zénith » : une étoile polaire qui perce l'horizon par le haut. Le zénith est le point
du ciel à la verticale de l'observateur, repère de la navigation astronomique : Zenytt donne de la
hauteur sur ses serveurs et le cap pour les piloter.

## Fichiers

| Fichier | Usage |
|---|---|
| `zenytt-icon.svg` | Icône de l'application : tuile qui remplit le carré, symbole à ~93 %. Source : `apps/desktop/app-icon.svg` |
| `zenytt-icon-small.svg` | Même icône pour 16 à 32 px (barre des tâches, zone de notification) : trait épaissi, sans micro-détails. Source : `apps/desktop/app-icon-small.svg` |
| `zenytt-logo.svg` / `zenytt-logo-light.svg` | Logo horizontal, sur fond sombre / sur fond clair |
| `zenytt-mark.svg` / `zenytt-mark-light.svg` | Symbole seul, sur fond sombre / sur fond clair |
| `zenytt-wordmark.svg` / `zenytt-wordmark-light.svg` | Nom seul |

Le nom est vectorisé : aucun fichier ne dépend d'une police installée.

### Discord et réseaux (`discord/`, en PNG et SVG)

| Fichier | Où le mettre |
|---|---|
| `discord-icone-512.png` / `-1024.png` | Icône du serveur Discord et avatar du bot (affichés en cercle). Aussi dans `apps/discord-bot/` |
| `discord-banniere-serveur-960x540.png` | Paramètres du serveur → Profil du serveur → Bannière |
| `discord-invitation-1920x1080.png` | Paramètres du serveur → Arrière-plan de l'invitation |
| `discord-banniere-profil-1360x480.png` | Portail développeur Discord → ton application → Bannière du bot |
| `github-apercu-1280x640.png` | Dépôt GitHub → Settings → Social preview |

Slogan : « Garde le cap sur tes serveurs. »

Régénérer les icônes de l'application après une modification du symbole :

```sh
cd apps/desktop && pnpm exec tauri icon app-icon.svg   # puis supprimer src-tauri/icons/android et ios
```

`tauri icon` dessine toutes les tailles depuis une seule image : il faut ensuite reconstruire
`src-tauri/icons/icon.ico` (et `32x32.png`) avec la version simplifiée d'`app-icon-small.svg` pour
16, 24 et 32 px, et la version complète au-delà. Windows prend dans le `.ico` l'image de la taille
affichée : c'est ce qui garde l'icône nette dans la barre des tâches.

## Couleurs

| Rôle | Sur fond sombre | Sur fond clair |
|---|---|---|
| Fond | `#0B1120` (tuile `#16213A` → `#0B1120`) | `#F3F5FA` |
| Encre (horizon, « zeny ») | `#E9EEF7` | `#0E1526` |
| Bleu (étoile, « tt ») | `#4F8BFF` | `#2F6BEA` |
| Facette claire de l'étoile | `#9CC0FF` | `#7FA6F5` |
| Étoile d'accent | `#F5B642` | `#F5B642` |

## Typographie

Nom : **Unbounded** Medium (500), approche -17/1000 em, toujours en minuscules. Le double « tt »
est en bleu : c'est la signature de la marque, et il rappelle l'orthographe. Police sous licence
SIL Open Font License 1.1 (<https://github.com/googlefonts/unbounded>).

## Règles

- Laisser autour du logo une marge au moins égale à la moitié de la hauteur du symbole.
- Ne pas déformer, recolorer, ajouter d'ombre ou de contour, ni écrire « Zenith » ou « ZENYTT ».
- En dessous de 24 px, utiliser l'icône seule, jamais le logo horizontal.
