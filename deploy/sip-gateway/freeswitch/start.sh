#!/bin/sh
# Sets the event-socket password, then hands over to the image's entrypoint.
set -e
sed -i -e "s/name=\"password\" value=\"[^\"]*\"/name=\"password\" value=\"${ESL_PASSWORD:-ClueCon}\"/" \
    /usr/local/freeswitch/conf/autoload_configs/event_socket.conf.xml
exec /entrypoint.sh "$@"
