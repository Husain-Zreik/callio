// src/services/call/audio/recording/encoding/OggMuxer.js
import { EventEmitter } from 'events';

const OGG_CAPTURE_PATTERN = Buffer.from('OggS');
const SAMPLE_RATE = 48000;

// Pre-computed CRC32 lookup table for the OGG polynomial (0x04C11DB7, MSB-first).
// Reduces per-byte CRC work from 8 shift+XOR iterations to one table lookup.
const OGG_CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let r = i << 24;
        for (let j = 0; j < 8; j++) {
            r = (r & 0x80000000) ? ((r << 1) ^ 0x04C11DB7) : (r << 1);
        }
        table[i] = r >>> 0;
    }
    return table;
})();

/**
 * Wraps Opus packets into an OGG container stream.
 * Implements the minimal OGG page structure required for valid .ogg files.
 *
 * OGG page structure:
 *  - capture pattern : 4 bytes  "OggS"
 *  - version         : 1 byte   0x00
 *  - header type     : 1 byte   0x00 continuation, 0x02 first page, 0x04 last page
 *  - granule pos     : 8 bytes  sample position
 *  - serial number   : 4 bytes  stream identifier
 *  - sequence number : 4 bytes  page counter
 *  - checksum        : 4 bytes  CRC32
 *  - segments        : 1 byte   number of segments
 *  - segment table   : N bytes  size of each segment
 *  - data            : payload
 */
export class OggMuxer extends EventEmitter {
    constructor() {
        super();
        this.serialNumber = Math.floor(Math.random() * 0xFFFFFFFF);
        this.sequenceNumber = 0;
        this.granulePos = 0;
        this.frameSize = 960; // samples per Opus frame at 48kHz/20ms
        this.headerWritten = false;
        this._finalized = false;
    }

    /**
     * Write the two required OGG/Opus header pages:
     * 1. ID header — identifies the stream as Opus
     * 2. Comment header — metadata (empty but required)
     */
    writeHeaders() {
        // --- Opus ID Header ---
        const idHeader = Buffer.alloc(19);
        idHeader.write('OpusHead', 0);               // magic signature
        idHeader.writeUInt8(1, 8);                   // version
        idHeader.writeUInt8(2, 9);                   // channel count (stereo)
        idHeader.writeUInt16LE(312, 10);             // pre-skip samples
        idHeader.writeUInt32LE(SAMPLE_RATE, 12);     // input sample rate
        idHeader.writeInt16LE(0, 16);                // output gain
        idHeader.writeUInt8(0, 18);                  // mapping family (0 = mono/stereo)

        this.emit('data', this._buildPage(idHeader, 0x02, 0)); // 0x02 = beginning of stream

        // --- Opus Comment Header ---
        const vendor = 'node-opus';
        const commentHeader = Buffer.alloc(16 + vendor.length);
        commentHeader.write('OpusTags', 0);                      // magic signature
        commentHeader.writeUInt32LE(vendor.length, 8);           // vendor string length
        commentHeader.write(vendor, 12);                         // vendor string
        commentHeader.writeUInt32LE(0, 12 + vendor.length);     // user comment list length (0)

        this.emit('data', this._buildPage(commentHeader, 0x00, 0));

        this.headerWritten = true;
    }

    /**
     * Accept an encoded Opus packet and wrap it in an OGG page
     * @param {Buffer} packet - Encoded Opus packet from OpusEncoder
     */
    writePacket(packet) {
        if (!this.headerWritten) this.writeHeaders();

        this.granulePos += this.frameSize;
        this.emit('data', this._buildPage(packet, 0x00, this.granulePos));
    }

    /**
     * Write the final OGG page (end of stream flag)
     * @param {Buffer|null} lastPacket - Final flushed Opus packet, or null
     */
    finalize(lastPacket = null) {
        if (this._finalized) return;
        this._finalized = true;
        if (!this.headerWritten) this.writeHeaders();

        if (lastPacket) {
            this.granulePos += this.frameSize;
        }

        const payload = lastPacket || Buffer.alloc(0);
        this.emit('data', this._buildPage(payload, 0x04, this.granulePos)); // 0x04 = end of stream
    }

    /**
     * Build a single OGG page from a payload buffer
     */
    _buildPage(payload, headerType, granulePos) {
        const segments = Math.ceil(payload.length / 255);
        const headerSize = 27 + segments;
        // allocUnsafe is safe here — every byte in the page is written explicitly below.
        const page = Buffer.allocUnsafe(headerSize + payload.length);

        // Capture pattern
        OGG_CAPTURE_PATTERN.copy(page, 0);

        page.writeUInt8(0x00, 4);                    // version
        page.writeUInt8(headerType, 5);              // header type
        page.writeBigInt64LE(BigInt(granulePos), 6); // granule position
        page.writeUInt32LE(this.serialNumber, 14);   // serial number
        page.writeUInt32LE(this.sequenceNumber++, 18); // sequence number
        page.writeUInt32LE(0, 22);                   // checksum placeholder
        page.writeUInt8(segments, 26);               // segment count

        // Segment table
        let remaining = payload.length;
        for (let i = 0; i < segments; i++) {
            const size = Math.min(remaining, 255);
            page.writeUInt8(size, 27 + i);
            remaining -= size;
        }

        // Payload
        payload.copy(page, headerSize);

        // CRC32 checksum
        const crc = this._crc32(page);
        page.writeUInt32LE(crc, 22);

        return page;
    }

    /**
     * CRC32 checksum as required by OGG spec (MSB-first, polynomial 0x04C11DB7).
     * Uses the pre-computed lookup table — one table lookup per byte instead of
     * 8 shift+XOR iterations, giving ~8× throughput improvement.
     */
    _crc32(buffer) {
        let crc = 0;
        for (let i = 0; i < buffer.length; i++) {
            crc = (OGG_CRC32_TABLE[((crc >>> 24) ^ buffer[i]) & 0xFF] ^ (crc << 8)) >>> 0;
        }
        return crc;
    }
}
