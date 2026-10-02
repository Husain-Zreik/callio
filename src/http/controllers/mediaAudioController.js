// src/http/controllers/mediaAudioController.js
// GET /media/audio/:token/:name — audio for the media server to play
// (src/media/rooms/MediaAudio.js). The signed token is the authorisation.
import { mediaAudio } from '../../media/rooms/MediaAudio.js';
import { logger } from '../../infra/logging/logger.js';

const log = logger('http.controllers.mediaAudio');

export async function handleMediaAudio(request, reply) {
    let audio = null;
    try {
        audio = await mediaAudio.open(request.params.token);
    } catch (err) {
        log.warn({ err }, 'Opening media audio failed');
        return reply.code(502).send();
    }
    if (!audio) return reply.code(404).send();
    reply.header('Content-Type', audio.type).header('Cache-Control', 'private, max-age=3600');
    return reply.send(audio.stream ?? audio.body);
}
