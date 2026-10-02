#!/bin/sh
# Sets the event-socket password, then hands over to the image's entrypoint.
# MEDIA_BIND_IP (production, host networking): the SIP profiles, RTP and the
# event socket listen on that address only (127.0.0.1: only rtpengine,
# drachtio and Callio on this host reach FreeSWITCH). The image's entrypoint
# sets the event socket to 0.0.0.0 at start, so its sed is redirected too.
set -e
sed -i -e "s/name=\"password\" value=\"[^\"]*\"/name=\"password\" value=\"${ESL_PASSWORD:-ClueCon}\"/" \
    /usr/local/freeswitch/conf/autoload_configs/event_socket.conf.xml
if [ -n "$MEDIA_BIND_IP" ]; then
    sed -i -e "s/\$\${local_ip_v4}/$MEDIA_BIND_IP/g" \
        /usr/local/freeswitch/conf/sip_profiles/mrf.xml /usr/local/freeswitch/conf/sip_profiles/mrf_g711.xml
    sed -i -e "s/value=\\\\\"0\\.0\\.0\\.0\\\\\"/value=\\\\\"$MEDIA_BIND_IP\\\\\"/" /entrypoint.sh
fi
exec /entrypoint.sh "$@"
