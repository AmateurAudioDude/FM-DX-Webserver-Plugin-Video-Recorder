/*
    VideoRec
    --------
*/

(function () {
    'use strict';

    // Quantizer and full picture interval come from createMp4's caller, see QUALITY_SETTINGS in pluginVideoRec.js.
    const CODEC_CANDIDATES = ['avc1.42E01F', 'avc1.4D401F', 'avc1.64001F'];
    const MAX_ENCODE_QUEUE = 8;
    const YIELD_INTERVAL_MS = 30;
    const MP4_EPOCH_OFFSET_S = 2082844800;
    const SCRIPT_BASE = document.currentScript?.src ? new URL('.', document.currentScript.src).href : '/videorec/';

    const MP3_BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
    const MP3_BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
    const MP3_SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

    function readMp3Header(bytes, i) {
        if (bytes[i] !== 0xFF || (bytes[i + 1] & 0xE0) !== 0xE0) return null;
        const version = (bytes[i + 1] >> 3) & 0x03;
        const layer = (bytes[i + 1] >> 1) & 0x03;
        const bitrateIndex = bytes[i + 2] >> 4;
        const rateIndex = (bytes[i + 2] >> 2) & 0x03;
        if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
        const mpeg1 = version === 3;
        const bitrate = (mpeg1 ? MP3_BITRATES_V1 : MP3_BITRATES_V2)[bitrateIndex] * 1000;
        const sampleRate = MP3_SAMPLE_RATES[version][rateIndex];
        return {
            mpeg1,
            sampleRate,
            channels: (bytes[i + 3] >> 6) === 3 ? 1 : 2,
            samplesPerFrame: mpeg1 ? 1152 : 576,
            length: Math.floor((mpeg1 ? 144 : 72) * bitrate / sampleRate) + ((bytes[i + 2] >> 1) & 0x01)
        };
    }

    function parseMp3(buffer) {
        const bytes = new Uint8Array(buffer);
        const frames = [];
        let format = null;
        let i = 0;
        while (i + 4 <= bytes.length) {
            const header = readMp3Header(bytes, i);
            const next = header ? i + header.length : 0;
            const nextIsFrame = header && (next + 1 >= bytes.length || (bytes[next] === 0xFF && (bytes[next + 1] & 0xE0) === 0xE0));
            if (!header || next > bytes.length || !nextIsFrame || (format && header.sampleRate !== format.sampleRate)) {
                i++;
                continue;
            }
            if (!format) format = header;
            frames.push(bytes.subarray(i, next));
            i = next;
        }
        if (!format) throw new Error('No MP3 audio found in the recording.');
        let totalBytes = 0;
        let maxFrameBytes = 0;
        for (const frame of frames) {
            totalBytes += frame.length;
            maxFrameBytes = Math.max(maxFrameBytes, frame.length);
        }
        return {
            mpeg1: format.mpeg1,
            sampleRate: format.sampleRate,
            channels: format.channels,
            samplesPerFrame: format.samplesPerFrame,
            bitrate: Math.round(totalBytes * 8 * format.sampleRate / (frames.length * format.samplesPerFrame)),
            maxFrameBytes,
            frames
        };
    }

    function abortError() {
        return new DOMException('Cancelled', 'AbortError');
    }

    // Message-channel tasks keep running at full speed in background tabs, unlike timers.
    function yieldToBrowser() {
        return new Promise(resolve => {
            const channel = new MessageChannel();
            channel.port1.onmessage = () => resolve();
            channel.port2.postMessage(null);
        });
    }

    function waitForEncoder(encoder) {
        return new Promise(resolve => {
            const done = () => {
                clearTimeout(timer);
                encoder.removeEventListener?.('dequeue', done);
                resolve();
            };
            const timer = setTimeout(done, 50);
            encoder.addEventListener?.('dequeue', done);
        });
    }

    function toBytes(source) {
        if (source instanceof ArrayBuffer) return new Uint8Array(source.slice(0));
        return new Uint8Array(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength));
    }

    async function pickEncoderConfig(width, height, framerate) {
        if (typeof window.VideoEncoder !== 'function') return null;
        for (const codec of CODEC_CANDIDATES) {
            const config = { codec, width, height, framerate, bitrateMode: 'quantizer', avc: { format: 'avc' } };
            try {
                const support = await VideoEncoder.isConfigSupported(config);
                if (support?.supported && support.config?.bitrateMode === 'quantizer') return config;
            } catch (_error) {}
        }
        return null;
    }

    // Some browsers accept quantizer mode but ignore the per-frame quantizer, so encode the first frame at two
    // quantizers and only trust the mode if the sizes clearly differ.
    async function quantizerHonoured(config, { width, height, frames, draw }) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        draw(canvas.getContext('2d', { alpha: false }), frames[0]);
        const sizes = [];
        for (const quantizer of [10, 40]) {
            let size = 0;
            const encoder = new VideoEncoder({ output: chunk => { size += chunk.byteLength; }, error: () => {} });
            try {
                encoder.configure(config);
                const videoFrame = new VideoFrame(canvas, { timestamp: 0 });
                encoder.encode(videoFrame, { keyFrame: true, avc: { quantizer } });
                videoFrame.close();
                await encoder.flush();
            } catch (_error) {
                return false;
            } finally {
                if (encoder.state !== 'closed') encoder.close();
            }
            sizes.push(size);
        }
        return sizes[0] > sizes[1] * 1.5;
    }

    async function encodeVideo(options) {
        const durationS = (options.frames[options.frames.length - 1]?.t || 0) / 1000;
        const framerate = Math.min(30, Math.max(1, Math.round(options.frames.length / Math.max(1, durationS))));
        let config = await pickEncoderConfig(options.width, options.height, framerate);
        if (config && !(await quantizerHonoured(config, options))) config = null;
        console.info(`[VideoRec] MP4 encoder: ${config ? `browser ${config.codec}` : 'VideoRec'}, ${options.width}x${options.height}, QP ${options.qp}, keyframes ${options.keyframeIntervalMs} ms`);
        return config ? encodeWithWebCodecs(config, options) : encodeWithVideoRec(options);
    }

    async function encodeWithWebCodecs(config, { width, height, frames, draw, onProgress, signal, qp, keyframeIntervalMs }) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d', { alpha: false });
        const samples = [];
        let description = null;
        let failure = null;
        const encoder = new VideoEncoder({
            output: (chunk, metadata) => {
                if (!description && metadata?.decoderConfig?.description) description = toBytes(metadata.decoderConfig.description);
                const data = new Uint8Array(chunk.byteLength);
                chunk.copyTo(data);
                samples.push({ t: Math.round(chunk.timestamp / 1000), data, key: chunk.type === 'key' });
            },
            error: error => { failure = error; }
        });
        encoder.configure(config);
        let lastKeyAt = -Infinity;
        let lastYieldAt = performance.now();
        try {
            for (let i = 0; i < frames.length; i++) {
                if (signal?.aborted) throw abortError();
                if (failure) throw failure;
                const frame = frames[i];
                draw(ctx, frame);
                const videoFrame = new VideoFrame(canvas, { timestamp: frame.t * 1000 });
                const keyFrame = frame.t - lastKeyAt >= keyframeIntervalMs;
                if (keyFrame) lastKeyAt = frame.t;
                encoder.encode(videoFrame, { keyFrame, avc: { quantizer: qp } });
                videoFrame.close();
                while (encoder.encodeQueueSize > MAX_ENCODE_QUEUE) await waitForEncoder(encoder);
                onProgress?.((i + 1) / frames.length);
                if (performance.now() - lastYieldAt >= YIELD_INTERVAL_MS) {
                    await yieldToBrowser();
                    lastYieldAt = performance.now();
                }
            }
            await encoder.flush();
            if (failure) throw failure;
            if (signal?.aborted) throw abortError();
        } finally {
            if (encoder.state !== 'closed') encoder.close();
        }
        if (!description) throw new Error('The browser did not provide an H.264 configuration.');
        for (let i = 1; i < samples.length; i++) {
            if (samples[i].t <= samples[i - 1].t) throw new Error('The browser produced reordered H.264 frames.');
        }
        return { samples, description };
    }

    function loadVideoRecEncoder() {
        if (window.VideoRecH264) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = `${SCRIPT_BASE}videorec-h264.js`;
            script.onload = () => resolve();
            script.onerror = () => {
                script.remove();
                reject(new Error('Could not load the video encoder.'));
            };
            document.head.appendChild(script);
        });
    }

    // Browsers without WebCodecs (plain HTTP pages) use VideoRec's own H.264 encoder.
    async function encodeWithVideoRec({ width, height, frames, draw, onProgress, signal, qp, keyframeIntervalMs }) {
        await loadVideoRecEncoder();
        const encoder = window.VideoRecH264.createEncoder(width, height, { qp, keyframeIntervalMs });
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
        const samples = [];
        let lastYieldAt = performance.now();
        for (let i = 0; i < frames.length; i++) {
            if (signal?.aborted) throw abortError();
            const frame = frames[i];
            draw(ctx, frame);
            const { data, key } = encoder.encodeFrame(ctx.getImageData(0, 0, width, height).data, frame.t);
            samples.push({ t: frame.t, data, key });
            onProgress?.((i + 1) / frames.length);
            if (performance.now() - lastYieldAt >= YIELD_INTERVAL_MS) {
                await yieldToBrowser();
                lastYieldAt = performance.now();
            }
        }
        return { samples, description: encoder.description };
    }

    function concatBytes(parts) {
        let length = 0;
        for (const part of parts) length += part.length;
        const out = new Uint8Array(length);
        let offset = 0;
        for (const part of parts) {
            out.set(part, offset);
            offset += part.length;
        }
        return out;
    }

    function u8(value) { return Uint8Array.of(value & 0xFF); }
    function u16(value) { return Uint8Array.of((value >> 8) & 0xFF, value & 0xFF); }
    function u24(value) { return Uint8Array.of((value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF); }
    function u32(value) { return u32Table([value]); }
    function ascii(text) { return Uint8Array.from(text, char => char.charCodeAt(0)); }
    function zeros(length) { return new Uint8Array(length); }

    function u32Table(values) {
        const out = new Uint8Array(values.length * 4);
        const view = new DataView(out.buffer);
        for (let i = 0; i < values.length; i++) view.setUint32(i * 4, values[i] >>> 0);
        return out;
    }

    function box(type, ...parts) {
        const payload = concatBytes(parts);
        return concatBytes([u32(payload.length + 8), ascii(type), payload]);
    }

    function fullBox(type, version, flags, ...parts) {
        return box(type, u8(version), u24(flags), ...parts);
    }

    const MATRIX = u32Table([0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000]);

    function tkhd(time, trackId, duration, volume, width, height) {
        return fullBox('tkhd', 0, 3, u32(time), u32(time), u32(trackId), zeros(4), u32(duration), zeros(8),
            u16(0), u16(0), u16(volume), zeros(2), MATRIX, u32(width * 65536), u32(height * 65536));
    }

    function mdhd(time, timescale, duration) {
        return fullBox('mdhd', 0, 0, u32(time), u32(time), u32(timescale), u32(duration), u16(0x55C4), u16(0));
    }

    function hdlr(type, name) {
        return fullBox('hdlr', 0, 0, zeros(4), ascii(type), zeros(12), ascii(name), zeros(1));
    }

    function dinf() {
        return box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));
    }

    // One sample per chunk, so samples of both tracks can be interleaved freely.
    function stbl(sampleEntry, timeToSample, sizes, offsets, syncSamples) {
        return box('stbl',
            fullBox('stsd', 0, 0, u32(1), sampleEntry),
            fullBox('stts', 0, 0, u32(timeToSample.length / 2), u32Table(timeToSample)),
            syncSamples ? fullBox('stss', 0, 0, u32(syncSamples.length), u32Table(syncSamples)) : zeros(0),
            fullBox('stsc', 0, 0, u32(1), u32Table([1, 1, 1])),
            fullBox('stsz', 0, 0, u32(0), u32(sizes.length), u32Table(sizes)),
            fullBox('stco', 0, 0, u32(offsets.length), u32Table(offsets)));
    }

    function avc1(width, height, avcC) {
        return box('avc1', zeros(6), u16(1), zeros(16), u16(width), u16(height),
            u32(0x00480000), u32(0x00480000), zeros(4), u16(1), zeros(32), u16(0x0018), u16(0xFFFF),
            box('avcC', avcC));
    }

    // MP3 inside MP4: object type 0x6B (MPEG-1 audio) or 0x69 (MPEG-2 audio), no decoder-specific info.
    function mp4a(audio) {
        const decoderConfig = concatBytes([
            u8(audio.mpeg1 ? 0x6B : 0x69), u8(0x15), u24(audio.maxFrameBytes), u32(audio.bitrate), u32(audio.bitrate)
        ]);
        const esDescriptor = concatBytes([
            u16(0), u8(0),
            u8(0x04), u8(decoderConfig.length), decoderConfig,
            u8(0x06), u8(1), u8(0x02)
        ]);
        return box('mp4a', zeros(6), u16(1), zeros(8), u16(audio.channels), u16(16), zeros(4), u32(audio.sampleRate * 65536),
            fullBox('esds', 0, 0, u8(0x03), u8(esDescriptor.length), esDescriptor));
    }

    function runLength(values) {
        const out = [];
        for (const value of values) {
            if (out.length && out[out.length - 1] === value) out[out.length - 2]++;
            else out.push(1, value);
        }
        return out;
    }

    function buildMp4({ width, height, video, audio, endMs, creationTime }) {
        const time = Math.floor((Number(creationTime) || Date.now()) / 1000) + MP4_EPOCH_OFFSET_S;
        const videoSamples = video.samples;
        const videoDeltas = videoSamples.map((sample, i) => {
            const next = i + 1 < videoSamples.length ? videoSamples[i + 1].t : Math.max(endMs, sample.t + 1);
            return next - sample.t;
        });
        const videoDuration = videoSamples[0].t + videoDeltas.reduce((sum, delta) => sum + delta, 0);
        const syncSamples = [];
        videoSamples.forEach((sample, i) => { if (sample.key) syncSamples.push(i + 1); });
        const audioDurationMs = Math.round(audio.frames.length * audio.samplesPerFrame * 1000 / audio.sampleRate);
        const frameMs = audio.samplesPerFrame * 1000 / audio.sampleRate;

        const order = [];
        let vi = 0;
        let ai = 0;
        while (vi < videoSamples.length || ai < audio.frames.length) {
            const videoAt = vi < videoSamples.length ? videoSamples[vi].t : Infinity;
            const audioAt = ai < audio.frames.length ? ai * frameMs : Infinity;
            if (videoAt <= audioAt) order.push({ video: true, index: vi++ });
            else order.push({ video: false, index: ai++ });
        }
        const videoOffsets = new Array(videoSamples.length);
        const audioOffsets = new Array(audio.frames.length);
        const payload = [];
        let position = 0;
        for (const item of order) {
            const data = item.video ? videoSamples[item.index].data : audio.frames[item.index];
            (item.video ? videoOffsets : audioOffsets)[item.index] = position;
            payload.push(data);
            position += data.length;
        }

        const ftyp = box('ftyp', ascii('isom'), u32(512), ascii('isomiso2avc1mp41'));
        const makeMoov = shift => box('moov',
            fullBox('mvhd', 0, 0, u32(time), u32(time), u32(1000), u32(Math.max(videoDuration, audioDurationMs)),
                u32(0x00010000), u16(0x0100), zeros(10), MATRIX, zeros(24), u32(3)),
            box('trak',
                tkhd(time, 1, videoDuration, 0, width, height),
                box('mdia',
                    mdhd(time, 1000, videoDuration),
                    hdlr('vide', 'VideoHandler'),
                    box('minf',
                        fullBox('vmhd', 0, 1, zeros(8)),
                        dinf(),
                        stbl(avc1(width, height, video.description), runLength(videoDeltas),
                            videoSamples.map(sample => sample.data.length), videoOffsets.map(offset => offset + shift), syncSamples)))),
            box('trak',
                tkhd(time, 2, audioDurationMs, 0x0100, 0, 0),
                box('mdia',
                    mdhd(time, audio.sampleRate, audio.frames.length * audio.samplesPerFrame),
                    hdlr('soun', 'SoundHandler'),
                    box('minf',
                        fullBox('smhd', 0, 0, zeros(4)),
                        dinf(),
                        stbl(mp4a(audio), [audio.frames.length, audio.samplesPerFrame],
                            audio.frames.map(frame => frame.length), audioOffsets.map(offset => offset + shift), null)))));
        const moov = makeMoov(ftyp.length + makeMoov(0).length + 8);
        return new Blob([ftyp, moov, u32(position + 8), ascii('mdat'), ...payload], { type: 'video/mp4' });
    }

    // frames: [{ t (ms, first at 0, ascending) }], draw(ctx, frame) paints one frame onto the canvas.
    async function createMp4({ width, height, qp = 18, keyframeIntervalMs = 4000, frames, endMs, draw, audio, onProgress, signal, creationTime }) {
        const mp3 = parseMp3(audio);
        if (!mp3.frames.length) throw new Error('No MP3 audio found in the recording.');
        if (!frames.length || frames[0].t !== 0) throw new Error('The video needs a frame at 0 ms.');
        const audioDurationMs = Math.round(mp3.frames.length * mp3.samplesPerFrame * 1000 / mp3.sampleRate);
        const video = await encodeVideo({ width, height, qp, keyframeIntervalMs, frames, draw, onProgress, signal });
        return buildMp4({ width, height, video, audio: mp3, endMs: Math.max(Number(endMs) || 0, audioDurationMs), creationTime });
    }

    window.VideoRecVideo = { createMp4 };
})();
