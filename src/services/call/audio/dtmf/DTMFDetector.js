// services/call/audio/dtmf/DTMFDetector.js
//
// Goertzel-based DTMF detector with production-grade accuracy.
//
// Problems addressed vs naive Goertzel:
//   1. Speech false positives — voice overlaps DTMF frequencies.
//      Fixed by: stricter thresholdRatio, twist bounds check, minPower floor,
//      and requiring N consecutive confirming windows before emitting.
//   2. Multi-fire per keypress — a single held key can produce multiple events
//      if a brief silence window resets the active-digit state mid-tone.
//      Fixed by: silenceWindows hysteresis (require M consecutive nulls before
//      resetting the active digit) and a per-digit cooldown floor.
//   3. Sample rate mismatch — wrtc delivers the first frame at 16kHz then
//      switches to 48kHz. Fixed by re-initializing when the rate changes.
//
// Tuning guide:
//   minPower      — raise if speech still triggers; lower if real DTMF misses.
//   thresholdRatio — raise to suppress speech (real DTMF is a pure tone, ratio >> 5).
//   confirmWindows — raise for fewer false positives, lower for faster response.
//   silenceWindows — raise to prevent multi-fire on the same keypress.
//   cooldownMs     — hard floor between successive events of the same digit.

const ROW_FREQS = [697, 770, 852, 941];     // DTMF low group
const COL_FREQS = [1209, 1336, 1477, 1633]; // DTMF high group

const DIGIT_MAP = {
    697: { 1209: '1', 1336: '2', 1477: '3', 1633: 'A' },
    770: { 1209: '4', 1336: '5', 1477: '6', 1633: 'B' },
    852: { 1209: '7', 1336: '8', 1477: '9', 1633: 'C' },
    941: { 1209: '*', 1336: '0', 1477: '#', 1633: 'D' },
};

export class DTMFDetector {
    constructor({
        windowMs           = 25,
        minPower           = 5e11,
        thresholdRatio     = 6,
        minTwist           = 0.1,
        maxTwist           = 6,
        confirmWindows     = 2,
        pendingFailWindows  = 2,
        silenceWindows     = 3,
        cooldownMs         = 150,
    } = {}) {
        this._windowMs          = windowMs;
        this._minPower          = minPower;
        this._thresholdRatio    = thresholdRatio;
        this._minTwist          = minTwist;
        this._maxTwist          = maxTwist;
        this._confirmWindows    = confirmWindows;
        this._pendingFailWindows = pendingFailWindows;
        this._silenceWindows    = silenceWindows;
        this._cooldownMs        = cooldownMs;

        this._buffer     = [];
        this._windowSize = null;
        this._sampleRate = null;

        this._pendingDigit    = null;
        this._pendingCount    = 0;
        this._pendingFailCount = 0;

        this._activeDigit  = null;
        this._silenceCount = 0;

        this._lastEmit = {};
    }

    // ─────────────────────────────────────────────────────────────────
    // PUBLIC
    // ─────────────────────────────────────────────────────────────────

    /**
     * Clear transient detection state between ivr_menu node entries.
     * Keeps stream config (_sampleRate, _windowSize) since the audio
     * source does not change.
     *
     * @param {object}  [opts]
     * @param {boolean} [opts.full=false]  Also clear _activeDigit/_lastEmit.
     *
     * `full` must be false for a direct ivr_menu -> ivr_menu transition
     * (frames kept flowing the whole time): the digit that routed into
     * this node may still be trailing in the RTP stream (a real keypress
     * tone commonly lasts 100-300ms, far longer than the ~50ms needed to
     * reconfirm a digit), so clearing the suppression here would let that
     * trailing tone re-fire as a "new" press on the node we just entered,
     * cutting off its audio before it played. The existing silence
     * hysteresis (_silenceWindows, in _onNullWindow) already clears
     * _activeDigit once the tone genuinely stops, so a real new press is
     * still detected correctly.
     *
     * `full` must be true when frame delivery was actually paused since
     * the last reset (e.g. an ivr_play node played in between): with no
     * frames flowing, _onNullWindow never runs, so a stale _activeDigit
     * from before the pause would otherwise sit frozen and could swallow
     * an entire genuine new press on the resumed node, however much real
     * time elapsed during the pause — the trailing-tone race above cannot
     * happen across a real pause, so it's safe to clear here.
     */
    reset({ full = false } = {}) {
        this._buffer           = [];
        this._pendingDigit     = null;
        this._pendingCount     = 0;
        this._pendingFailCount = 0;
        if (full) {
            this._activeDigit  = null;
            this._silenceCount = 0;
            this._lastEmit     = {};
        }
    }

    process(samples, sampleRate) {
        this._initWindow(sampleRate);

        const s16 = samples instanceof Int16Array ? samples : new Int16Array(samples);
        for (let i = 0; i < s16.length; i++) this._buffer.push(s16[i]);

        let result = null;
        while (this._buffer.length >= this._windowSize) {
            const window   = this._buffer.splice(0, this._windowSize);
            const detected = this._analyzeWindow(window);
            if (detected) result = detected;
        }
        return result;
    }

    // ─────────────────────────────────────────────────────────────────
    // PRIVATE — window analysis
    // ─────────────────────────────────────────────────────────────────

    _initWindow(sampleRate) {
        if (this._windowSize !== null && this._sampleRate === sampleRate) return;

        if (this._sampleRate !== null && this._sampleRate !== sampleRate) {
            // wrtc delivers the first frame at a different rate before settling on the
            // real stream rate. Discard buffered samples so bins are recalibrated cleanly.
            this._buffer = [];
        }

        this._sampleRate = sampleRate;
        this._windowSize = Math.max(64, Math.round(sampleRate * this._windowMs / 1000));
    }

    _analyzeWindow(samples) {
        const rowPowers = ROW_FREQS.map(f => this._goertzel(samples, f));
        const colPowers = COL_FREQS.map(f => this._goertzel(samples, f));

        const row = this._dominantFreq(rowPowers, ROW_FREQS);
        const col = this._dominantFreq(colPowers, COL_FREQS);

        if (!row || !col) {
            this._onNullWindow();
            return null;
        }

        const twist = col.power / row.power;
        if (twist < this._minTwist || twist > this._maxTwist) {
            this._onNullWindow();
            return null;
        }

        const digit = DIGIT_MAP[row.freq]?.[col.freq] ?? null;
        if (!digit) {
            this._onNullWindow();
            return null;
        }

        this._silenceCount     = 0;
        this._pendingFailCount = 0;

        if (digit === this._activeDigit) {
            this._pendingDigit = null;
            this._pendingCount = 0;
            return null;
        }

        if (digit === this._pendingDigit) {
            this._pendingCount++;
        } else {
            this._pendingDigit = digit;
            this._pendingCount = 1;
        }

        if (this._pendingCount < this._confirmWindows) return null;

        const now = Date.now();
        const lastEmit = this._lastEmit[digit] ?? 0;
        if (now - lastEmit < this._cooldownMs) return null;

        this._activeDigit  = digit;
        this._pendingDigit = null;
        this._pendingCount = 0;
        this._lastEmit[digit] = now;

        console.log(
            `[DTMFDetector] Digit '${digit}' confirmed — ` +
            `row=${row.freq}Hz power=${row.power.toExponential(2)}, ` +
            `col=${col.freq}Hz power=${col.power.toExponential(2)}, ` +
            `twist=${twist.toFixed(2)}`
        );

        return { digit, rowHz: row.freq, colHz: col.freq, rowPower: row.power, colPower: col.power };
    }

    _onNullWindow() {
        this._pendingFailCount++;
        if (this._pendingFailCount >= this._pendingFailWindows) {
            this._pendingDigit = null;
            this._pendingCount = 0;
        }

        this._silenceCount++;
        if (this._silenceCount >= this._silenceWindows) {
            this._activeDigit      = null;
            this._silenceCount     = 0;
            this._pendingFailCount = 0;
        }
    }

    // ─────────────────────────────────────────────────────────────────
    // PRIVATE — Goertzel
    // ─────────────────────────────────────────────────────────────────

    _goertzel(samples, targetFreq) {
        const N     = samples.length;
        const k     = Math.round(N * targetFreq / this._sampleRate);
        const omega = (2 * Math.PI * k) / N;
        const coeff = 2 * Math.cos(omega);

        let s1 = 0, s2 = 0;
        for (let i = 0; i < N; i++) {
            const s = samples[i] + coeff * s1 - s2;
            s2 = s1;
            s1 = s;
        }

        return s1 * s1 + s2 * s2 - coeff * s1 * s2;
    }

    _dominantFreq(powers, freqs) {
        let best = 0;
        for (let i = 1; i < powers.length; i++) {
            if (powers[i] > powers[best]) best = i;
        }

        const bestPower = powers[best];
        if (bestPower < this._minPower) return null;

        for (let i = 0; i < powers.length; i++) {
            if (i === best) continue;
            if (powers[i] > 0 && bestPower / powers[i] < this._thresholdRatio) return null;
        }

        return { freq: freqs[best], power: bestPower };
    }
}
