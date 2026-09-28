# Conditions d'utilisation de Zenytt

*Dernière mise à jour : 28 septembre 2026*

Ces conditions encadrent l'utilisation de l'application Zenytt, éditée par Nathan Chevrollier (voir
les [mentions légales](mentions-legales.md)). Installer ou utiliser Zenytt vaut acceptation de ces
conditions et de la [licence](../../LICENSE).

## 1. Licence

Zenytt est mis à disposition **gratuitement** sous la licence PolyForm Shield 1.0.0, dont le texte
anglais fait foi. En résumé :

- tu peux utiliser Zenytt librement, à titre personnel comme professionnel, sur autant de machines
  que tu veux ;
- tu peux lire, modifier et redistribuer le code, à condition de conserver la licence et la
  mention de copyright (`Required Notice`) ;
- tu ne peux pas utiliser Zenytt, ni une version modifiée, ni une partie de son code, pour proposer
  un produit ou service **concurrent** de Zenytt, même gratuit.

Seuls les fichiers d'installation publiés sur la page officielle des versions
(<https://github.com/NathanChevrollier/Zenytt/releases>) et les dépôts de paquets qui y renvoient
(winget, Homebrew, AUR, Flathub) sont distribués par l'éditeur. Une copie obtenue ailleurs peut
avoir été modifiée.

## 2. Ce que fait Zenytt, et ta responsabilité

Zenytt est un outil d'administration : il exécute sur tes serveurs les actions que tu demandes
(commandes, suppression de fichiers ou de conteneurs, modification de configurations nginx ou
Apache, pare-feu, sauvegardes, restaurations, déploiements, réseaux privés entre serveurs…). Ces actions peuvent être
**irréversibles** ou rendre un serveur inaccessible.

Tu es seul responsable :

- des serveurs auxquels tu connectes Zenytt, et de disposer des autorisations nécessaires pour les
  administrer ;
- des actions lancées depuis Zenytt, y compris celles que tu confies à l'assistant IA ;
- de la conservation de sauvegardes indépendantes de tes données ;
- de la sécurité de ton poste (session, mot de passe de verrouillage de Zenytt, clés SSH) ;
- du respect de la réglementation applicable aux données hébergées sur tes serveurs ;
- des serveurs que tu relies par un réseau privé : n'y relie que des serveurs que tu administres, et
  n'en fais pas un relais pour le trafic de tiers.

Zenytt ne doit pas être utilisé pour accéder à un système sans autorisation.

## 3. Assistant IA

L'assistant est facultatif. Il utilise le fournisseur et la clé d'API **que tu choisis**, sous
les conditions de ce fournisseur, et les frais éventuels sont à ta charge. Ses réponses peuvent
être inexactes : vérifie toute commande avant de l'approuver. En mode autonome, il peut exécuter
des commandes sans demander ta validation à chaque fois ; tu actives ce mode en connaissance de
cause. Les informations qu'il lit sur tes serveurs sont transmises au fournisseur (voir la
[politique de confidentialité](confidentialite.md)).

## 4. Services tiers

Certaines fonctions s'appuient sur des services que tu configures (fournisseurs d'IA, stockage de
sauvegardes, Discord, ntfy, Let's Encrypt…). Zenytt n'est affilié à aucun d'eux ; leur usage relève
de leurs propres conditions.

## 5. Mises à jour

Zenytt vérifie au démarrage si une nouvelle version existe et peut l'installer. Les mises à jour
sont signées : une version altérée est refusée. L'éditeur peut faire évoluer, modifier ou arrêter
Zenytt à tout moment, sans obligation de maintenance ni de support.

## 6. Garantie et responsabilité

Zenytt est fourni **« en l'état »**, gratuitement, sans garantie de fonctionnement, d'absence
d'erreur ou d'adéquation à un besoin particulier.

Dans les limites permises par la loi, l'éditeur ne pourra être tenu responsable des dommages
directs ou indirects résultant de l'utilisation ou de l'impossibilité d'utiliser Zenytt, notamment
la perte de données, l'interruption d'un service, l'indisponibilité d'un serveur ou une faille de
sécurité. Cette limitation ne s'applique pas en cas de faute lourde ou intentionnelle, ni aux
dommages corporels, ni aux droits que la loi reconnaît impérativement aux consommateurs.

## 7. Sécurité

Si tu découvres une faille de sécurité, signale-la de façon confidentielle en suivant
[SECURITY.md](../../SECURITY.md) plutôt que publiquement.

## 8. Modification des conditions

Ces conditions peuvent évoluer. La version applicable est celle publiée dans le dépôt à la date
de la version de Zenytt que tu utilises.

## 9. Droit applicable

Ces conditions sont régies par le droit français. En cas de litige, et à défaut d'accord amiable,
les tribunaux français sont compétents, sous réserve des règles protectrices dont tu bénéficies
en tant que consommateur dans ton pays de résidence.
