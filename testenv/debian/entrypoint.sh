#!/bin/sh
# Pas de systemd dans le conteneur : rsyslog écrit /var/log/auth.log (format standard, horodaté),
# que fail2ban surveille, comme sur un VPS classique.
rm -f /run/rsyslogd.pid
rsyslogd
nginx
/usr/sbin/sshd
rm -f /var/run/fail2ban/fail2ban.sock
fail2ban-client start >/var/log/fail2ban-start.log 2>&1
exec tail -f /dev/null
