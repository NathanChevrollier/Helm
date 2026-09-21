#!/bin/sh
# Donne au groupe sudo l'accès au socket Docker monté depuis l'hôte, puis lance nginx et sshd.
if [ -S /var/run/docker.sock ]; then
    chgrp sudo /var/run/docker.sock && chmod g+rw /var/run/docker.sock
fi
nginx
exec /usr/sbin/sshd -D -e
