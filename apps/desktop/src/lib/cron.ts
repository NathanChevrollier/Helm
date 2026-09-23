// Traduction d'une ligne de cron en français : à quoi sert réellement la commande.
//
// Une crontab est illisible pour qui n'a pas écrit la ligne. On reconnaît ici les tâches les plus
// courantes d'un serveur Linux, et à défaut on décrit ce que l'on peut dire avec certitude :
// le script exécuté, le fichier de journal, la surveillance branchée dessus.

interface Regle {
  test: RegExp;
  /** Description, éventuellement construite à partir de la capture. */
  texte: string | ((m: RegExpMatchArray) => string);
}

const REGLES: Regle[] = [
  { test: /certbot.*renew|letsencrypt.*renew/i, texte: "Renouvelle les certificats Let's Encrypt qui approchent de l'expiration (ne fait rien sinon)." },
  { test: /run-parts.*cron\.hourly/i, texte: "Exécute les scripts déposés dans /etc/cron.hourly." },
  { test: /run-parts.*cron\.daily/i, texte: "Exécute les scripts déposés dans /etc/cron.daily (logrotate, nettoyages, mises à jour légères…)." },
  { test: /run-parts.*cron\.weekly/i, texte: "Exécute les scripts déposés dans /etc/cron.weekly." },
  { test: /run-parts.*cron\.monthly/i, texte: "Exécute les scripts déposés dans /etc/cron.monthly." },
  { test: /e2scrub/i, texte: "Vérifie en arrière-plan les métadonnées des systèmes de fichiers ext4, pour repérer une corruption avant qu'elle ne gêne." },
  { test: /sessionclean/i, texte: "Supprime les sessions PHP expirées du disque." },
  { test: /logrotate/i, texte: "Fait tourner les fichiers de journaux : archive les anciens, en limite la taille." },
  { test: /systemd-tmpfiles.*clean/i, texte: "Nettoie les fichiers temporaires devenus inutiles (/tmp, /var/tmp)." },
  { test: /fstrim/i, texte: "Signale au SSD les blocs libérés, pour maintenir ses performances." },
  { test: /updatedb|mlocate|plocate/i, texte: "Met à jour l'index utilisé par la commande « locate »." },
  { test: /man-db|mandb/i, texte: "Reconstruit l'index des pages de manuel." },
  { test: /apt-get\s+update.*(upgrade|dist-upgrade)|unattended-upgrade/i, texte: "Installe les mises à jour de paquets sans intervention." },
  { test: /apt-get\s+update|apt\s+update/i, texte: "Rafraîchit la liste des paquets disponibles (n'installe rien)." },
  { test: /apt-get\s+(autoremove|clean|autoclean)/i, texte: "Fait le ménage dans les paquets et le cache d'installation." },
  { test: /(^|\s)snap\s+refresh/i, texte: "Met à jour les paquets snap." },
  { test: /docker\s+system\s+prune|docker\s+image\s+prune/i, texte: "Supprime les images, conteneurs et caches Docker inutilisés pour récupérer de l'espace disque." },
  { test: /helm-backup|restic\s+backup/i, texte: "Sauvegarde du serveur (restic) : bases, volumes et dossiers configurés." },
  { test: /restic\s+(forget|prune)/i, texte: "Applique la rétention des sauvegardes : supprime les anciennes copies devenues inutiles." },
  { test: /restic\s+check/i, texte: "Vérifie l'intégrité du dépôt de sauvegarde." },
  { test: /borg\s+(create|prune)/i, texte: "Sauvegarde ou rétention avec BorgBackup." },
  { test: /(mysqldump|mariadb-dump)/i, texte: "Exporte une base MySQL/MariaDB dans un fichier." },
  { test: /pg_dump/i, texte: "Exporte une base PostgreSQL dans un fichier." },
  { test: /rsync/i, texte: "Copie ou synchronise des fichiers, souvent vers un autre disque ou une autre machine." },
  { test: /rclone/i, texte: "Synchronise des fichiers avec un stockage distant (S3, Drive, etc.)." },
  { test: /(^|\/)(reboot|shutdown)(\s|$)/i, texte: "Redémarre ou éteint la machine." },
  { test: /systemctl\s+restart\s+(\S+)/i, texte: (m) => `Redémarre le service ${m[1]}.` },
  { test: /curl|wget/i, texte: "Appelle une adresse web (déclenchement d'un traitement, envoi d'un signal de surveillance…)." },
];

/** Chemin du script exécuté, quand la ligne en lance un. */
function script(command: string): string | null {
  const m = command.match(/(\/(?:usr\/local\/bin|opt|srv|home\/[^/\s]+|root|etc\/cron[^\s]*)\/[^\s;|>]+\.(?:sh|py|pl|rb|php|js))/);
  return m ? m[1] : null;
}

/** Fichier où part la sortie de la commande, s'il y en a un. */
function journal(command: string): string | null {
  const m = command.match(/>>?\s*(\/[^\s;|&]+)/);
  return m && m[1] !== "/dev/null" ? m[1] : null;
}

/**
 * Phrase expliquant ce que fait une ligne de cron. `null` quand rien ne peut être affirmé :
 * mieux vaut ne rien écrire qu'une description inventée.
 */
export function describeCron(command: string): string | null {
  const parties: string[] = [];

  for (const r of REGLES) {
    const m = command.match(r.test);
    if (m) {
      parties.push(typeof r.texte === "string" ? r.texte : r.texte(m));
      break;
    }
  }

  const chemin = script(command);
  if (parties.length === 0 && chemin) {
    parties.push(`Script propre à ce serveur : ${chemin}.`);
  } else if (chemin && !parties[0]?.includes(chemin)) {
    parties.push(`Exécuté par ${chemin}.`);
  }

  if (/hc-ping\.com|healthchecks/i.test(command)) {
    parties.push("Un ping de surveillance (Healthchecks) prévient si la tâche ne s'exécute pas.");
  }
  if (/\/dev\/null/.test(command)) {
    parties.push("Sa sortie est jetée : en cas d'échec, rien ne sera visible.");
  } else {
    const log = journal(command);
    if (log) parties.push(`Sortie ajoutée à ${log}.`);
  }
  if (/anacron/i.test(command)) {
    parties.push("Ne s'exécute que si anacron n'a pas déjà pris le relais (machine éteinte à l'heure prévue).");
  }

  return parties.length > 0 ? parties.join(" ") : null;
}
