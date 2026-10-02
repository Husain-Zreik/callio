# rtpengine for Callio's media plane: Debian's own package (trixie: 12.5.x,
# built with transcoding), no third-party repository. Replaces
# drachtio/rtpengine:latest, which stopped at 9.4 (2021) and lacks the
# subscribe requests a supervisor uses to listen to a direct call
# (docs/direct-lines.md, Part B).
#
# The config is bind-mounted at /etc/rtpengine.conf (rtpengine.conf on the
# server, rtpengine.local.conf for tests). Kernel forwarding is used when the
# host has the xt_RTPENGINE module loaded, userspace otherwise.
FROM debian:trixie-slim

# IPv4 only: a Docker network without an IPv6 route makes every download wait
# for the IPv6 attempt to time out first.
RUN echo 'Acquire::ForceIPv4 "true";' > /etc/apt/apt.conf.d/99force-ipv4 \
 && apt-get update \
 && apt-get install -y --no-install-recommends rtpengine-daemon \
 && rm -rf /var/lib/apt/lists/*

ENTRYPOINT ["rtpengine"]
CMD ["--config-file", "/etc/rtpengine.conf"]
