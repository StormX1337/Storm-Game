#!/bin/sh
# Turn on the HTTPS server only when a certificate and key are present.
#
# nginx refuses to start if `ssl_certificate` points at a missing file, so the
# TLS block cannot simply live in the config: an operator who has not set up
# certificates yet would get a container that will not boot.
set -eu

CERT=/etc/nginx/certs/origin.pem
KEY=/etc/nginx/certs/origin.key

if [ -s "$CERT" ] && [ -s "$KEY" ]; then
    cp /etc/nginx/tls.conf /etc/nginx/conf.d/storm-tls.conf
    echo "storm: HTTPS enabled ($CERT)"
else
    rm -f /etc/nginx/conf.d/storm-tls.conf
    echo "storm: no certificate at $CERT — serving HTTP only"
fi
