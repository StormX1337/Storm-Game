#!/bin/sh
# Turn on the HTTPS server, but only if it actually works.
#
# nginx refuses to start when `ssl_certificate` points at a missing or
# unreadable file, and the stock entrypoint has no opinion about that: the
# container then crash-loops and takes port 80 down with it, so a mistyped
# certificate costs you the whole panel rather than just its TLS. Enable the
# block, ask nginx whether it is happy, and fall back to HTTP if it is not.
set -eu

CERT=/etc/nginx/certs/origin.pem
KEY=/etc/nginx/certs/origin.key
TLS_CONF=/etc/nginx/conf.d/storm-tls.conf

disable() {
    rm -f "$TLS_CONF"
    echo "storm: serving HTTP only — $1"
}

if [ ! -s "$CERT" ] || [ ! -s "$KEY" ]; then
    disable "no certificate at $CERT and key at $KEY"
    return 0 2>/dev/null || exit 0
fi

cp /etc/nginx/tls.conf "$TLS_CONF"

# `nginx -t` loads the certificate and the key for real, so this catches a
# truncated paste, a key in the wrong format, a certificate in the key file,
# and anything else wrong with the TLS block.
if error=$(nginx -t 2>&1); then
    echo "storm: HTTPS enabled ($CERT)"
else
    disable "the certificate or key was rejected"
    echo "$error" | sed 's/^/storm:   /'
    echo "storm:   check with: openssl pkey -in $KEY -noout"
fi
