# Audit de sécurité complet — complément du 26 septembre 2026

Ce document complète [audit-2026-09-26.md](audit-2026-09-26.md). Il n'en reprend pas les points déjà corrigés. Il couvre :
- le code modifié depuis : la refonte graphique, et le suivi du dossier du terminal (lecture de l'invite, resynchronisation à l'Entrée) ;
- une revue systématique de toutes les commandes shell construites par Zenytt ;
- les frontières de confiance que l'audit précédent n'avait pas entièrement fermées.

Niveaux : 🔴 critique · 🟠 élevé · 🟡 moyen · ⚪ faible / à décider.

## Synthèse

| # | Niveau | Sujet | État |
|---|---|---|---|
| 1 | 🟠 | Import d'un partage : un bureau à distance ou un registre reçu avec l'identifiant d'un élément existant le remplaçait, adresse comprise (mot de passe ou jeton envoyé ailleurs) | Corrigé |
| 2 | 🟠 | Import d'un partage : un serveur ou un bureau reçu pouvait se servir d'un de **tes** identifiants (banque) sans en fournir le secret, donc avec ton mot de passe, vers son adresse | Corrigé |
| 3 | 🟡 | Bureaux à distance importés non validés : identifiant utilisé comme nom de fichier (traversée de chemin vers le dossier Démarrage), retours à la ligne injectant des options `.rdp` | Corrigé |
| 4 | ⚪ | Révocation d'une clé de déploiement : le `.` du nom de projet était un joker `sed` (`my.app` révoquait aussi `myXapp`) | Corrigé |
| 5 | 🟡 | Règle sudoers `NOPASSWD` du déploiement GitHub : chemin vers root si le compte peut modifier les fichiers du projet | Avertissement ajouté |
| 6 | ⚪ | Le verrouillage ne filtre pas les commandes des plugins Tauri (presse-papiers) | À décider |
| 7 | ⚪ | `write_file_sudo` suit un lien symbolique posé à l'avance dans un dossier modifiable | Noté |

**Verdict** : aucune injection de commande trouvée. Les 295 commandes construites avec une valeur interpolée ont été relues une à une. Chaque valeur est soit quotée (`shell_quote`), soit validée par une liste blanche de caractères, soit choisie dans une énumération fermée. Les failles restantes étaient encore des **hypothèses de confiance trop larges sur l'import d'un partage**. Elles appartiennent à la même famille que le point 2 de l'audit précédent, corrigé alors pour les seuls serveurs.

## Revu et sain

- **Commandes shell envoyées aux serveurs** : docker, compose, déploiement, sauvegardes restic, bases SQL, Redis, nginx et Apache, fail2ban, ufw, cron et timers, services, archives, recherche, tmux. Le mot de passe sudo passe par stdin, jamais par la ligne de commande.
- **Fichiers générés côté serveur** (`/etc/zenytt-deploy/*.conf`, environnement restic, exceptions fail2ban) : valeurs validées puis entre apostrophes. Les apostrophes et retours à la ligne sont refusés.
- **Téléchargements vers le PC** : `local_name` neutralise `\`, `/`, `:` et les noms réservés de Windows. Les liens symboliques ne sont pas suivis.
- **Front** : aucun `dangerouslySetInnerHTML` ni `innerHTML`. Les liens ne s'ouvrent qu'en `http(s)`. La CSP et les permissions Tauri sont minimales et inchangées.
- **Mises à jour** : signées (clé publique dans `tauri.conf.json`), récupérées en HTTPS.
- **zenytt-sync** : jetons hachés en SHA-256 et comparés par table, taille des requêtes limitée.
- **Dépendances** : `pnpm audit --prod` (app et bot) ne trouve aucune vulnérabilité. `cargo audit` ne trouve aucune vulnérabilité exploitable. Il signale seulement des crates non maintenues et un défaut de `glib`, tirés indirectement par Tauri sous Linux.
- **Suivi du dossier du terminal** (nouveau) : le chemin lu dans l'invite vient de la sortie du terminal, donc potentiellement d'un programme distant. Il ne sert qu'à **lister** un dossier en SFTP avec les droits de l'utilisateur SSH : aucune commande, aucune écriture. Le PID transmis au serveur est un entier typé.

## 🟠 1. Import : bureaux à distance et registres redirigés

- **Où** : `crates/profiles/src/export.rs`, fonction `import`.
- **Constat** : le correctif précédent donnait un nouvel identifiant à un **serveur** reçu avec l'identifiant d'un serveur existant mais une autre adresse. Les bureaux à distance et les registres Docker, eux, étaient encore fusionnés par identifiant. Leur mot de passe ou jeton est rangé dans le coffre sous cet identifiant. D'où le scénario :
  1. un collègue a reçu tes bureaux et registres dans un partage ;
  2. il te renvoie une « mise à jour » qui garde les identifiants mais change les adresses ;
  3. à la prochaine ouverture du bureau, ou au prochain `docker login`, ton secret part vers son adresse.
- **Correctif** : `rekey_conflicting_others`. Un bureau (hôte, port, utilisateur) ou un registre (adresse, utilisateur) dont l'adresse diffère reçoit un nouvel identifiant, avec ses secrets éventuels. L'élément existant reste intact.
- **Test** : `import_does_not_redirect_a_desktop_or_registry`.

## 🟠 2. Import : emprunt d'un identifiant de la banque

- **Constat** : un identifiant de la banque porte un utilisateur et un mot de passe, mais pas d'adresse. Ce sont les serveurs et bureaux qui le référencent qui décident où ce mot de passe part. Il suffisait d'un partage contenant un serveur `attaquant.example` avec `identityId` égal à l'identifiant d'un des tiens. Zenytt s'y connectait alors avec ton mot de passe. Un identifiant reçu avec le même identifiant que le tien remplaçait aussi le tien (changement d'utilisateur).
- **Correctif** : `protect_identities`. Si le contenu reçu référence un de tes identifiants **sans en fournir le secret** :
  - ton identifiant n'est pas modifié ;
  - le lien est retiré, sauf s'il existait déjà à l'identique chez toi (même serveur, même adresse, même identifiant), ce qui couvre le réimport de ses propres réglages.

  Le bilan d'import signale les liens retirés.
- **Tests** : `import_does_not_lend_my_identity`, `import_keeps_my_own_identity_link_on_reimport`.

## 🟡 3. Bureaux à distance importés non validés

- **Où** : `commands/rdp.rs` et `crates/profiles/src/lib.rs`.
- **Constat** : `desktop_save` valide les champs d'un bureau, mais un bureau importé n'y passe pas. Deux abus en découlaient :
  - **Traversée de chemin.** L'identifiant sert de nom de fichier : `cache/rdp/<id>.rdp`. Avec un identifiant `..\..\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\x`, le fichier `x.rdp` atterrit dans le dossier Démarrage de Windows. Il lance alors `mstsc` vers l'hôte de l'attaquant à chaque ouverture de session.
  - **Injection d'options.** Un utilisateur contenant un retour à la ligne ajoute des options au fichier `.rdp`, par exemple `drivestoredirect:s:*`, qui partage tous les disques du PC avec le serveur distant. L'utilisateur peut aussi venir d'un identifiant de la banque.
- **Correctif** :
  - `RemoteDesktop::is_valid` et `Registry::is_valid` : identifiant alphanumérique (UUID), hôte sans espace, aucun caractère de contrôle ;
  - les éléments invalides sont écartés à l'import, avec leurs secrets ;
  - la même vérification est refaite à chaque ouverture (`find_desktop`), pour les bureaux importés avant ce correctif ;
  - l'utilisateur final est nettoyé (`credentials`) ;
  - `desktop_save` refuse un identifiant fourni invalide.
- **Test** : `import_rejects_desktops_that_would_escape_or_inject`.

## ⚪ 4. Révocation d'une clé de déploiement

- **Où** : `crates/core/src/deploy.rs`.
- **Correctif** : `marker_pattern` échappe le `.` dans le motif `sed`, à la création comme à la révocation.
- **Test** : `revoke_pattern_matches_only_its_project`.

## Points à décider

5. **Règle `NOPASSWD` du déploiement GitHub** (`deploy::create_key`, utilisateur non root) — traité.
   - Constat : la clé GitHub est bien restreinte (commande forcée, `restrict`). En revanche, la règle sudoers ajoutée permet à **quiconque contrôle le compte SSH** de lancer `zenytt-deploy` en root sans mot de passe. Si les fichiers compose du projet sont modifiables par ce compte (projet créé à la main dans son dossier personnel), un `volumes: - /:/host` donne root. Pour un utilisateur déjà membre du groupe `docker`, rien ne change : ce groupe équivaut à root. Sinon, c'est un chemin vers root qui n'existait pas.
   - Les projets créés par Zenytt (`NewComposeProject`, catalogue) appartiennent à root et ne sont pas concernés.
   - **Décision : avertir.** Avant de créer la clé, Zenytt évalue le risque sur le serveur (`deploy::sudo_risk`) : compte root ou non, membre du groupe `docker` ou non, dossier du projet, fichiers compose et `.env` modifiables par le compte (`test -w`).
   - Le risque existe seulement si le compte n'est pas root, n'est pas dans le groupe `docker` et peut modifier au moins un de ces éléments. Dans ce cas, le dialogue GitHub affiche :
     - les éléments concernés ;
     - la commande qui les rend modifiables par root seulement (`chown root:root` + `chmod go-w`, sans toucher aux données du projet) ;
     - un bouton « Revérifier ».
   - La création de la clé demande alors une confirmation explicite.
   - Test : `deploy::tests::sudo_rule_risk`. Le script de vérification a aussi été rejoué sur le faux VPS Debian (utilisateur non root) : il signale bien un projet placé dans le dossier personnel, et ne signale rien pour des fichiers appartenant à root.
6. **Verrouillage et plugins Tauri**.
   - Constat : `guarded()` filtre les commandes de l'app, pas celles des plugins. Pendant le verrouillage, un script injecté pourrait encore lire le presse-papiers (`clipboard-manager:allow-read-text`).
   - Risque faible : il faut déjà un script dans la webview, et la CSP l'empêche.
   - Option : lire le presse-papiers via une commande de l'app plutôt que via le plugin.
7. **`write_file_sudo` et liens symboliques**. `cat > fichier` en root suit un lien symbolique qu'un autre compte du serveur aurait posé à l'avance dans un dossier modifiable. C'est sans objet sur un VPS personnel à un seul utilisateur.

## Vérifier soi-même

```sh
pnpm typecheck && pnpm --filter zenytt-desktop test
cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
cargo audit && pnpm audit --prod
```

Résultat au moment de l'audit :
- 177 tests Rust et 52 tests TypeScript passent ;
- clippy ne signale aucun avertissement ;
- aucune vulnérabilité connue dans les dépendances.
