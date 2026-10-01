# FreeSWITCH as Callio's media server (docs/media-architecture.md): the image
# drachtio-fsmrf is built against, plus what Callio needs from it.
#   - libopusfile/libopusenc, so mod_opusfile loads (the image ships the
#     module, built read-only, without its libraries): Ogg Opus prompts play
#   - opus-tools + curl: a recording is written as stereo WAV, encoded to Ogg
#     Opus and uploaded to object storage by callio-recording-upload
#   - Opus preferred over G.711 (the image prefers G.711)
# The event-socket password is set at start from ESL_PASSWORD.
FROM drachtio/drachtio-freeswitch-mrf:latest

RUN apt-get update \
 && apt-get install -y --no-install-recommends libopusfile0 libopusenc0 opus-tools curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && sed -i -e 's|<!--<load module="mod_opusfile"/>-->|<load module="mod_opusfile"/>|' \
        /usr/local/freeswitch/conf/autoload_configs/modules.conf.xml \
 && sed -i -e 's/global_codec_prefs=[^"]*"/global_codec_prefs=OPUS,PCMU,PCMA,G722"/' \
        -e 's/outbound_codec_prefs=[^"]*"/outbound_codec_prefs=OPUS,PCMU,PCMA,G722"/' \
        /usr/local/freeswitch/conf/vars.xml

COPY start.sh /start.sh
COPY callio-recording-upload /usr/local/bin/callio-recording-upload
RUN chmod +x /start.sh /usr/local/bin/callio-recording-upload
ENTRYPOINT ["/start.sh"]
CMD ["freeswitch"]
