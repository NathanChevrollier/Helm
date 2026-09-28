# Politique de confidentialité de Zenytt

*Dernière mise à jour : 28 septembre 2026*

Zenytt est une application de bureau qui fonctionne **sur ton ordinateur**. Elle n'a pas de compte
utilisateur, pas de serveur central et **aucune télémétrie** : l'éditeur ne reçoit ni statistiques
d'usage, ni rapport de plantage, ni aucune donnée te concernant.

Cette politique explique quelles données Zenytt manipule, où elles restent, et à quels services
tiers elles peuvent être transmises, uniquement quand tu utilises la fonction concernée.

## 1. Qui est responsable ?

L'éditeur de Zenytt est Nathan Chevrollier (voir les [mentions légales](mentions-legales.md)).

Comme Zenytt ne transmet aucune donnée à son éditeur, celui-ci **ne traite pas tes données
personnelles** au sens du RGPD : c'est toi qui décides quels serveurs tu gères, ce que tu y
stockes et quels services tiers tu actives. Si tu utilises Zenytt pour administrer des serveurs qui
contiennent des données personnelles de tiers (clients, utilisateurs d'un site…), tu restes
responsable de ces traitements.

## 2. Données conservées sur ton ordinateur

| Donnée | Où | Pourquoi |
|---|---|---|
| Profils de serveurs (nom, adresse, port, utilisateur, dossiers, tunnels, snippets, réseaux privés — adresses privées et clés publiques WireGuard —, réglages) | Fichier `zenytt.json` dans le dossier de configuration de l'application (`%APPDATA%\dev.zenytt.desktop` sous Windows) | Te reconnecter à tes serveurs |
| Mots de passe, phrases de passe de clés, clés d'API, jetons | Gestionnaire d'identifiants du système (Windows Credential Manager, trousseau macOS, Secret Service sous Linux), jamais en clair dans un fichier | Authentification |
| Empreintes des clés d'hôte approuvées | Fichier de configuration | Détecter une usurpation de serveur |
| Journal technique de l'application (5 fichiers de 2 Mo au plus, rotation automatique) | Dossier des journaux de l'application | Diagnostiquer un problème ; aucun secret n'y est écrit |
| Journal des actions sensibles effectuées dans Zenytt | Local | Te permettre de retrouver ce qui a été fait |
| État de l'interface (onglets ouverts, préférences d'affichage) | Local | Retrouver ton espace de travail |

Tu peux tout supprimer à tout moment : désinstalle Zenytt puis efface son dossier de configuration
et ses entrées dans le gestionnaire d'identifiants du système.

Zenytt peut être protégé par un mot de passe de verrouillage, défini dans les réglages.

## 3. Données envoyées à tes propres serveurs

Zenytt se connecte en SSH aux serveurs que **tu** as configurés, pour y exécuter les commandes que
tu demandes (terminal, fichiers, Docker, nginx, sauvegardes…). L'agent facultatif `zenyttd`, s'il est
installé, tourne sur ces serveurs et ne communique qu'avec Zenytt via SSH, et avec les services de
notification que tu as configurés (section 4).

Le **réseau privé** (WireGuard) relie les serveurs que tu choisis entre eux. Chaque serveur génère
sa propre clé privée, qui **ne quitte jamais le serveur** (Zenytt ne la lit pas) ; seules les clés
publiques et les adresses sont connues de Zenytt. Le trafic du réseau privé circule directement
entre tes serveurs, chiffré, sans passer par l'éditeur ni par un service tiers.

L'**écran d'une machine virtuelle** s'affiche par un tunnel SSH ; si la VM a un mot de passe VNC,
Zenytt le lit sur le serveur et ne le garde qu'en mémoire, le temps de la session.

Pour installer un outil nécessaire à une fonction (WireGuard, restic, tmux…), Zenytt utilise le
gestionnaire de paquets du serveur, qui contacte les dépôts de ta distribution.

## 4. Services tiers (uniquement si tu utilises la fonction)

| Fonction | Service contacté | Données transmises | Quand |
|---|---|---|---|
| Mises à jour | GitHub (GitHub, Inc., États-Unis) | Ton adresse IP et la version installée, comme pour tout téléchargement | Au démarrage, pour vérifier s'il existe une nouvelle version |
| Diagnostic d'accès (fail2ban, pare-feu) | api.ipify.org | Ton adresse IP, pour connaître ton IP publique | Quand tu lances le diagnostic |
| Détection de l'IP publique d'un serveur | api.ipify.org, **depuis le serveur** | L'adresse IP du serveur | Pages Sites et domaines |
| Expiration des noms de domaine | rdap.org et les registres de domaines | Les noms de domaine de tes sites | Page Sites, vérification des domaines |
| Assistant IA (inactif tant qu'aucun fournisseur n'est configuré) | Le fournisseur que tu choisis : Anthropic, OpenAI, Mistral, OpenRouter, ou un modèle local | Tes messages et les informations que l'assistant lit sur tes serveurs (journaux, configurations, état des services). Les mots de passe, clés et jetons détectés sont masqués avant l'envoi, sans garantie absolue | Quand tu utilises l'assistant, avec **ta** clé d'API |
| Notifications d'alerte | Discord, ntfy ou tout webhook que tu configures | Le texte de l'alerte (nom du serveur, métrique, valeur) | Quand une alerte se déclenche |
| Sauvegardes | Le stockage que tu configures (S3, Backblaze, SFTP…) | Tes sauvegardes, chiffrées par restic | Selon ta planification |
| Synchronisation | Un dossier de ton choix, ou un serveur `zenytt-sync` que tu héberges | Tes réglages **chiffrés de bout en bout** (AES-256-GCM) avec ta phrase de passe, qui ne quitte jamais tes appareils | Si tu actives la synchronisation |
| Terminal partagé | Ton serveur `zenytt-sync` (relais) | Le flux du terminal partagé, chiffré de bout en bout | Quand tu partages un terminal |
| Certificats HTTPS | Let's Encrypt, **depuis le serveur** | Le domaine et l'e-mail saisi pour les avertissements d'expiration | Création d'un site en HTTPS |

Chacun de ces services applique sa propre politique de confidentialité. En particulier, quand tu
utilises l'assistant IA, lis les conditions de ton fournisseur sur la conservation des requêtes et
leur éventuelle utilisation pour l'entraînement de modèles. Pour ne rien envoyer à l'extérieur,
utilise un modèle local.

## 5. Transferts hors de l'Union européenne

Certains services listés ci-dessus sont situés hors de l'UE (notamment aux États-Unis). Ces
transferts résultent de ton choix d'utiliser la fonction concernée ; aucun n'est effectué par
l'éditeur.

## 6. Mineurs

Zenytt est un outil d'administration de serveurs destiné à un public professionnel ou averti.

## 7. Tes droits

Aucune donnée n'étant collectée par l'éditeur, il n'a rien à te communiquer, rectifier ou effacer :
tu gardes la maîtrise complète de tes données, localement. Pour toute question, écris à l'adresse
indiquée dans les [mentions légales](mentions-legales.md). Tu peux aussi saisir la CNIL
([www.cnil.fr](https://www.cnil.fr)).

## 8. Modifications

Si une version future de Zenytt modifiait ces pratiques (par exemple en ajoutant un service), cette
politique serait mise à jour avant la publication de la version concernée, et le changement
signalé dans les notes de version.
