/*
    VideoRec v1.1.2 by AAD
    ----------------------
    https://github.com/AmateurAudioDude/FM-DX-Webserver-Plugin-Video-Recorder

    Records the server's MP3 audio stream together with the live signal, RDS and TX data, then saves both as an
    MP4 video of the data panel. Everything happens in the browser.
*/

(() => {
    'use strict';

    // Longest recording in seconds, the whole recording stays in memory until it has been made into a video.
    const MAX_RECORDING_SECONDS = 600;
    // Per quality (right-click menu): video size, H.264 quantizer qp (0-51, lower = better quality, each +6 roughly
    // halves the video part of the file) and full picture interval in ms. Used by both the browser's encoder and VideoRec's.
    const QUALITY_SETTINGS = {
        high: { width: 1344, height: 576, qp: 18, keyframeIntervalMs: 4000 },
        low: { width: 952, height: 408, qp: 24, keyframeIntervalMs: 8000 }
    };
    const QUALITY_KEY = 'videorec-quality';
    const TIMESTAMP_KEY = 'videorec-timestamp';
    const SIGNAL_KEEPALIVE_MS = 1000;
    const BUTTON_ID = 'social-record-btn';
    const SCRIPT_BASE = new URL('videorec/', window.location.href).href;
    const AUDIO_URL = `${window.location.protocol === 'https:' ? 'wss://' : 'ws://'}${window.location.host}${window.location.pathname}audio`;
    const ROBOTO_MONO_URL = 'https://fonts.googleapis.com/css2?family=Roboto+Mono:wght@400;500&display=swap';

    // Same offsets as the webserver: dBuV = dBf - 11.25; dBuV = dBm + 108.75.
    const DBF_TO_DBUV = 11.25;
    const MICRO_SIGN = String.fromCharCode(181);
    // S-meter reference for VHF/FM: S9 = -93 dBm, 6 dB per S-unit below it.
    const S9_DBM = -93;

    const PTY_NAMES_RDS = [
        'No PTY', 'News', 'Current Affairs', 'Info',
        'Sport', 'Education', 'Drama', 'Culture', 'Science', 'Varied',
        'Pop Music', 'Rock Music', 'Easy Listening', 'Light Classical',
        'Serious Classical', 'Other Music', 'Weather', 'Finance',
        'Children\'s Programmes', 'Social Affairs', 'Religion', 'Phone-in',
        'Travel', 'Leisure', 'Jazz Music', 'Country Music', 'National Music',
        'Oldies Music', 'Folk Music', 'Documentary', 'Alarm Test', 'Alarm'
    ];
    const PTY_NAMES_RBDS = [
        'No PTY', 'News', 'Information', 'Sports', 'Talk', 'Rock', 'Classic Rock',
        'Adults Hits', 'Soft Rock', 'Top 40', 'Country', 'Oldies', 'Soft Music',
        'Nostalgia', 'Jazz', 'Classical', 'Rhythm and Blues', 'Soft Rhythm and Blues',
        'Language', 'Religious Music', 'Religious Talk', 'Personality', 'Public', 'College',
        'Spanish Talk', 'Spanish Music', 'Hip Hop', '', '', 'Weather', 'Emergency Test', 'Emergency'
    ];

    const BUTTON_CSS = `
@keyframes vr-blink { 50% { opacity: 0; } }
#${BUTTON_ID}:hover i, #${BUTTON_ID}.vr-active i { color: rgba(255, 0, 0, 0.75); }
#${BUTTON_ID}.vr-active i { animation: vr-blink 2s step-start 0s infinite; }
#${BUTTON_ID}.vr-active:hover i { color: var(--color-4); }`;

    // The video's look, the same panel as Visual Logbook's recordings. The video is measured from this CSS, so
    // changes here show up in the next video without touching the drawing code.
    const PANEL_CSS = `
:host { all: initial; }
[hidden] { display: none !important; }
.vr-stage { display: flex; flex-direction: column; font-family: "SF Pro Text", Arial, Helvetica, sans-serif; font-size: 16px; line-height: normal; color: #e5e7eb; }
.vr-stage * { box-sizing: border-box; }
.vr-header { position: relative; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; background: #0b1220; border-bottom: 1px solid rgba(148, 163, 184, 0.2); font-size: 14px; }
.vr-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vr-time { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); white-space: nowrap; font-variant-numeric: tabular-nums; }
.vr-users { flex: 0 0 auto; white-space: nowrap; font-variant-numeric: tabular-nums; }
.vr-users-icon { font-family: "Font Awesome 6 Free"; font-weight: 900; font-style: normal; }
.vr-body { background: #000; }
.vr-data { display: grid; gap: 8px; padding: 12px; color: #e5e7eb; }
.vr-row { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; }
.vr-span-2 { grid-column: span 2; }
.vr-span-4 { grid-column: span 4; }
.vr-cell {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    min-width: 0;
    padding: 8px 10px;
    border: 1px solid rgba(148, 163, 184, 0.2);
    border-radius: 8px;
    background: rgba(15, 23, 42, 0.85);
    text-align: center;
}
.vr-value.vr-rt { align-self: flex-start; text-align: left; width: 100%; }
.vr-label { font-size: 11px; color: #38bdf8; text-transform: uppercase; letter-spacing: 0.04em; }
.vr-value {
    max-width: 100%;
    font-size: 22px;
    line-height: 1.2;
    font-variant-numeric: tabular-nums;
    white-space: pre;
    overflow: hidden;
    text-overflow: ellipsis;
}
.vr-ps {
    font-family: "Roboto Mono", monospace;
    font-size: 26px;
    font-weight: 500;
}
.vr-rt { font-family: "Roboto Mono", monospace; font-size: 10px; line-height: 1.4; white-space: pre; min-height: 3.4em; }
.vr-faint, .vr-unit { font-size: 18px; opacity: 0.55; }
.vr-unit { font-size: 13px; }
.vr-peak, .vr-sub { min-height: 1.2em; font-size: 10px; opacity: 0.7; font-variant-numeric: tabular-nums; }
.vr-sub { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vr-status { gap: 6px; }
.vr-pty {
    max-width: 100%;
    min-height: 1.3em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 14px;
    color: #38bdf8;
}
.vr-flags { display: flex; align-items: center; gap: 12px; font-size: 14px; font-weight: 700; }
.vr-dim { opacity: 0.2; }
.vr-flag-slot { display: inline-flex; justify-content: center; width: 20px; }
.vr-flag { display: block; width: 20px; height: auto; }
.vr-stereo { position: relative; display: inline-block; width: 18px; height: 12px; }
.vr-circle { position: absolute; top: 0; width: 12px; height: 12px; border: 2px solid currentColor; border-radius: 50%; }
.vr-circle1 { left: 0; }
.vr-circle2 { left: 6px; }
.vr-stereo-forced .vr-circle1 { left: 3px; }
.vr-stereo-forced .vr-circle2 { display: none; }
.vr-tx-body { max-width: 100%; }
.vr-tx-body > span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vr-tx-name { font-size: 14px; color: #38bdf8; }
.vr-tx-city { margin-top: 2px; font-size: 12px; }
.vr-tx-small { margin-top: 2px; font-size: 11px; }
.vr-tx-sep { opacity: 0.55; }`;

    const PANEL_HTML = `
<div class="vr-data">
    <div class="vr-row">
        <div class="vr-cell vr-span-2"><span class="vr-label">PS</span><span class="vr-value vr-ps" data-vr="ps"></span></div>
        <div class="vr-cell"><span class="vr-label">ACI</span><span class="vr-value" data-vr="aci"></span></div>
        <div class="vr-cell"><span class="vr-label">CCI</span><span class="vr-value" data-vr="cci"></span></div>
        <div class="vr-cell vr-span-2 vr-status">
            <span class="vr-pty" data-vr="pty"></span>
            <span class="vr-flags">
                <span data-vr="tp">TP</span>
                <span data-vr="ta">TA</span>
                <span class="vr-flag-slot"><img class="vr-flag" data-vr="flag" alt="" hidden></span>
                <span class="vr-stereo" data-vr="stereo"><span class="vr-circle vr-circle1"></span><span class="vr-circle vr-circle2"></span></span>
                <span data-vr="ms"><span data-vr="music">M</span><span data-vr="speech">S</span></span>
            </span>
        </div>
    </div>
    <div class="vr-row">
        <div class="vr-cell vr-span-2"><span class="vr-label">PI code</span><span class="vr-sub" data-vr="regularPi"></span><span class="vr-value" data-vr="pi"></span></div>
        <div class="vr-cell vr-span-2"><span class="vr-label">Frequency</span><span class="vr-sub" data-vr="tuner"></span><span class="vr-value" data-vr="freq"></span></div>
        <div class="vr-cell vr-span-2">
            <span class="vr-label">Signal</span>
            <span class="vr-peak" data-vr="peak"></span>
            <span class="vr-value"><span data-vr="sigInt"></span><span class="vr-faint" data-vr="sigDec"></span> <span class="vr-unit" data-vr="sigUnit"></span></span>
        </div>
    </div>
    <div class="vr-row">
        <div class="vr-cell vr-span-4"><span class="vr-label">RadioText</span><span class="vr-value vr-rt" data-vr="rt"></span></div>
        <div class="vr-cell vr-span-2">
            <div class="vr-tx-body" data-vr="txBody" hidden>
                <span class="vr-tx-name" data-vr="txName"></span>
                <span class="vr-tx-city"><span data-vr="txCity"></span> <span class="vr-tx-small">[<span data-vr="txItu"></span>]</span></span>
                <span class="vr-tx-small"><span data-vr="txPower"></span> <span class="vr-tx-sep">\u{2022}</span> <span data-vr="txDist"></span> <span class="vr-tx-sep">\u{2022}</span> <span data-vr="txAzi"></span></span>
            </div>
        </div>
    </div>
</div>`;

    const HEADER_HTML = `<div class="vr-header"><span class="vr-title">VideoRec</span><span class="vr-time">0</span><span class="vr-users"><i class="vr-users-icon">\u{f007}</i> <span class="vr-users-count">0</span></span></div>`;

    let recording = null;
    let encoding = null;
    let robotoMono = null;
    let quality = loadQuality();
    let includeTimestamp = loadTimestamp();
    let tooltip = null;
    let tooltipTimer = null;
    let menu = null;

    // ---- Button ----

    function setButton(state, label) {
        const button = document.getElementById(BUTTON_ID);
        if (!button) return;
        button.classList.toggle('vr-active', state === 'active');
        const text = button.querySelector('span');
        if (text) text.textContent = label || 'Video';
    }

    function formatElapsed(ms) {
        const seconds = Math.floor(ms / 1000);
        return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    }

    function notify(type, title, message) {
        if (typeof sendToast === 'function') {
            if (navigator.userAgent.indexOf('Chrome') !== -1) {
                sendToast(type, title, message, false, false);
            } else {
                sendToast(type, title, message.length > 28 ? message.slice(0, 16) + '...' + message.slice(-12) : message, false, false);
            }
        } else {
            console.log(`[VideoRec] ${title}: ${message}`);
        }
    }

    function loadQuality() {
        try {
            return window.localStorage.getItem(QUALITY_KEY) === 'low' ? 'low' : 'high';
        } catch (_error) {
            return 'high';
        }
    }

    function saveQuality(value) {
        quality = value;
        try {
            window.localStorage.setItem(QUALITY_KEY, value);
        } catch (_error) {}
    }

    function loadTimestamp() {
        try {
            return window.localStorage.getItem(TIMESTAMP_KEY) === '1';
        } catch (_error) {
            return false;
        }
    }

    function saveTimestamp(value) {
        includeTimestamp = value;
        try {
            window.localStorage.setItem(TIMESTAMP_KEY, value ? '1' : '0');
        } catch (_error) {}
    }

    function hideTooltip() {
        clearTimeout(tooltipTimer);
        if (!tooltip) return;
        const tip = tooltip;
        tooltip = null;
        tip.style.opacity = '0';
        setTimeout(() => tip.remove(), 300);
    }

    // Own tooltip like Visual Logbook's button, with the right-click hint under the action.
    function showTooltip(button) {
        clearTimeout(tooltipTimer);
        tooltipTimer = setTimeout(() => {
            const tip = document.createElement('div');
            tip.style.cssText = 'position:fixed;z-index:1001;background:var(--color-2,#333);border:2px solid var(--color-3,#666);border-radius:15px;padding:5px 25px;pointer-events:none;white-space:nowrap;font-size:14px;color:var(--color-text,#eee);text-align:center;opacity:0;transition:opacity 0.3s ease;';
            const title = document.createElement('div');
            title.textContent = encoding ? 'Cancel the video' : (recording ? 'Stop video recording' : 'Start video recording');
            const hint = document.createElement('div');
            hint.textContent = 'Right-click for video options';
            hint.style.cssText = 'font-size:11px;opacity:0.6;margin-top:2px;';
            tip.append(title, hint);
            document.body.appendChild(tip);
            const rect = button.getBoundingClientRect();
            const tipRect = tip.getBoundingClientRect();
            const left = Math.max(8, Math.min(rect.left + rect.width / 2 - tipRect.width / 2, window.innerWidth - tipRect.width - 8));
            tip.style.left = `${left}px`;
            tip.style.top = `${rect.bottom + 10}px`;
            tooltip = tip;
            requestAnimationFrame(() => requestAnimationFrame(() => {
                if (tooltip === tip) tip.style.opacity = '1';
            }));
        }, 400);
    }

    function closeMenu() {
        if (!menu) return;
        menu.backdrop.remove();
        menu.list.remove();
        menu = null;
    }

    // Right-click menu like Visual Logbook's. A transparent backdrop closes it, so nothing listens page-wide.
    function openMenu(x, y) {
        closeMenu();
        const backdrop = document.createElement('div');
        backdrop.style.cssText = 'position:fixed;inset:0;z-index:1001;';
        const closeFromBackdrop = event => {
            event.preventDefault();
            closeMenu();
        };
        backdrop.addEventListener('click', closeFromBackdrop);
        backdrop.addEventListener('contextmenu', closeFromBackdrop);

        const list = document.createElement('div');
        list.tabIndex = -1;
        list.style.cssText = [
            'position:fixed',
            'z-index:1002',
            'background:var(--color-1,#1a1a2e)',
            'border:1px solid var(--color-2,#444)',
            'border-radius:8px',
            'padding:4px 0',
            'min-width:180px',
            'box-shadow:0 4px 16px rgba(0,0,0,0.4)',
            'user-select:none',
            'font-size:13px',
            'outline:none'
        ].join(';');
        [
            ['Include Timestamp', includeTimestamp, () => saveTimestamp(!includeTimestamp)],
            ['High Quality', quality === 'high', () => saveQuality(quality === 'high' ? 'low' : 'high')]
        ].forEach(([label, on, toggle]) => {
            const item = document.createElement('div');
            item.style.cssText = 'padding:8px 14px;cursor:pointer;color:var(--color-5,#eee);white-space:nowrap;display:flex;align-items:center;gap:8px;';
            if (on) {
                item.style.fontWeight = '600';
                item.style.color = 'var(--color-main-bright,#38bdf8)';
            }
            const check = document.createElement('span');
            check.style.cssText = 'width:14px;flex:0 0 auto;font-size:11px;';
            check.textContent = on ? '\u{2714}' : '';
            const text = document.createElement('span');
            text.textContent = label;
            item.append(check, text);
            item.addEventListener('mouseenter', () => { item.style.background = 'var(--color-2,#333)'; });
            item.addEventListener('mouseleave', () => { item.style.background = ''; });
            item.addEventListener('click', () => {
                toggle();
                closeMenu();
            });
            list.appendChild(item);
        });
        list.addEventListener('keydown', event => {
            if (event.key === 'Escape') closeMenu();
        });
        list.addEventListener('contextmenu', event => event.preventDefault());

        document.body.append(backdrop, list);
        const rect = list.getBoundingClientRect();
        list.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
        list.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
        list.focus();
        menu = { backdrop, list };
    }

    function onButtonClick() {
        if (encoding) {
            encoding.abort();
            encoding = null;
            setButton('idle');
            notify('info', 'Video recording', 'The video was cancelled.');
            return;
        }
        if (recording) stopRecording();
        else startRecording();
    }

    // ---- Recording ----

    // UTC, like the filename.
    function formatTimestamp(ms) {
        return `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
    }

    function videoFilename() {
        const time = new Date().toISOString().slice(0, 19).replaceAll(':', '').replace('T', '_');
        const freq = Number.parseFloat(document.getElementById('data-frequency')?.textContent);
        return `Video_${time}z${Number.isFinite(freq) ? `_${Math.round(freq * 1000)}kHz` : ''}.mp4`;
    }

    function startRecording() {
        let audioSocket;
        try {
            audioSocket = new WebSocket(AUDIO_URL);
        } catch (_error) {
            notify('error', 'Video recording failed', 'Could not connect to the audio stream.');
            return;
        }
        audioSocket.binaryType = 'arraybuffer';
        const rec = {
            filename: videoFilename(),
            pressedAt: Date.now(),
            audioSocket,
            audio: [],
            audioStartedAt: 0,
            signal: [],
            rds: [],
            lastSigRaw: null,
            lastSignalAt: 0,
            lastRdsKey: null,
            dataSocket: null,
            onData: null,
            ticker: 0,
            limit: 0
        };
        rec.onData = event => recordData(rec, event);
        recording = rec;
        audioSocket.addEventListener('open', () => audioSocket.send(JSON.stringify({ type: 'fallback', data: 'mp3' })));
        audioSocket.addEventListener('message', event => {
            if (recording !== rec || !(event.data instanceof ArrayBuffer)) return;
            if (!rec.audioStartedAt) rec.audioStartedAt = Date.now();
            rec.audio.push(event.data);
        });
        audioSocket.addEventListener('close', () => {
            if (recording === rec) stopRecording(['warning', 'The audio stream closed, so the recording was stopped.']);
        });
        attachDataSocket(rec);
        // The page replaces its data socket when it reconnects, so follow it.
        rec.ticker = setInterval(() => {
            attachDataSocket(rec);
            setButton('active', formatElapsed(Date.now() - rec.pressedAt));
        }, 1000);
        rec.limit = setTimeout(() => {
            stopRecording(['info', `Recordings stop after ${Math.round(MAX_RECORDING_SECONDS / 60)} minutes.`]);
        }, MAX_RECORDING_SECONDS * 1000);
        setButton('active', '00:00');
    }

    function attachDataSocket(rec) {
        const socket = window.socket || null;
        if (socket === rec.dataSocket) return;
        rec.dataSocket?.removeEventListener('message', rec.onData);
        rec.dataSocket = socket;
        socket?.addEventListener('message', rec.onData);
    }

    // notice: optional [toast type, message]
    function stopRecording(notice) {
        const rec = recording;
        if (!rec) return;
        recording = null;
        clearInterval(rec.ticker);
        clearTimeout(rec.limit);
        rec.dataSocket?.removeEventListener('message', rec.onData);
        try {
            rec.audioSocket.close();
        } catch (_error) {}
        if (notice && rec.audio.length) notify(notice[0], 'Video recording', notice[1]);
        makeVideo(rec, Date.now());
    }

    function parseQuality(value) {
        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : null;
    }

    // The antenna and bandwidth as the page's own dropdowns show them, empty when the server hides that control.
    function readTunerSetup() {
        const ant = document.querySelector('.data-ant input');
        const bw = document.querySelector('.data-bw input');
        return {
            ant: ant ? String(ant.value || ant.placeholder || '').trim() : '',
            bw: bw ? String(bw.value || bw.placeholder || '').trim() : ''
        };
    }

    // Same samples as Visual Logbook's auto-recorder: signal on change (or every second), RDS and TX on change.
    function recordData(rec, event) {
        if (recording !== rec || typeof event.data !== 'string' || event.data[0] !== '{') return;
        let data;
        try {
            data = JSON.parse(event.data);
        } catch (_error) {
            return;
        }
        const now = Date.now();
        const freq = Number.parseFloat(data.freq);

        const sigRaw = String(data.sigRaw || '');
        if (sigRaw !== rec.lastSigRaw || now - rec.lastSignalAt >= SIGNAL_KEEPALIVE_MS) {
            const parts = sigRaw.split(',');
            const sig = Number.parseFloat(data.sig);
            rec.signal.push([
                now,
                Number.isFinite(sig) ? Math.round(sig * 100) / 100 : null,
                parts.length > 1 ? parseQuality(parts[1]) : null,
                parts.length > 2 ? parseQuality(parts[2]) : null,
                data.st ? 1 : 0,
                data.stForced ? 1 : 0
            ]);
            rec.lastSigRaw = sigRaw;
            rec.lastSignalAt = now;
        }

        const txInfo = data.txInfo || {};
        const tuner = readTunerSetup();
        const rdsKey = [
            data.freq, data.pi, data.ps, data.ps_errors, data.rt0, data.rt1, data.rt0_errors, data.rt1_errors,
            data.pty, data.tp, data.ta, data.ms, data.ecc, data.country_iso,
            txInfo.tx, txInfo.city, txInfo.itu, txInfo.erp, txInfo.pol, txInfo.dist, txInfo.azi, txInfo.reg, txInfo.pi,
            tuner.ant, tuner.bw, data.users
        ].join('\u0001');
        if (rdsKey === rec.lastRdsKey) return;
        rec.lastRdsKey = rdsKey;
        const users = Number.parseInt(data.users, 10);
        const pty = Number.parseInt(data.pty, 10);
        const ms = Number.parseInt(data.ms, 10);
        const ecc = Number.parseInt(data.ecc, 10);
        const dist = Number.parseFloat(txInfo.dist);
        const azi = Number.parseFloat(txInfo.azi);
        rec.rds.push({
            t: now,
            f: Number.isFinite(freq) ? freq : null,
            pi: String(data.pi || ''),
            ps: String(data.ps || ''),
            pse: String(data.ps_errors || ''),
            rt0: String(data.rt0 || ''),
            rt1: String(data.rt1 || ''),
            rte0: String(data.rt0_errors || ''),
            rte1: String(data.rt1_errors || ''),
            pty: Number.isFinite(pty) ? pty : null,
            tp: data.tp ? 1 : 0,
            ta: data.ta ? 1 : 0,
            ms: Number.isFinite(ms) ? ms : -1,
            ecc: Number.isFinite(ecc) ? ecc : null,
            ci: String(data.country_iso || ''),
            cn: String(data.country_name || ''),
            tx: String(txInfo.tx || '').length > 1 ? {
                name: String(txInfo.tx),
                city: String(txInfo.city || ''),
                itu: String(txInfo.itu || ''),
                erp: String(txInfo.erp ?? ''),
                pol: String(txInfo.pol || ''),
                dist: Number.isFinite(dist) ? dist : null,
                azi: Number.isFinite(azi) ? azi : null
            } : null,
            // Station matched by its regional PI, the webserver then shows the regular PI too.
            regularPi: txInfo.reg === true ? String(txInfo.pi || '') : '',
            ant: tuner.ant,
            bw: tuner.bw,
            users: Number.isFinite(users) ? users : null
        });
    }

    // Samples from startedAt to endTime with times relative to startedAt, the last earlier one becomes the one at 0.
    function sliceSamples(list, startedAt, endTime, timeOf, toRecord) {
        const out = [];
        let initial = null;
        for (const sample of list) {
            const t = timeOf(sample);
            if (t < startedAt) {
                initial = sample;
                continue;
            }
            if (t > endTime) break;
            if (initial) {
                if (t > startedAt) out.push(toRecord(initial, 0));
                initial = null;
            }
            out.push(toRecord(sample, t - startedAt));
        }
        if (initial) out.push(toRecord(initial, 0));
        return out;
    }

    // ---- Making the video ----

    function loadScript(url, isLoaded) {
        if (isLoaded()) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = url;
            script.onload = () => resolve();
            script.onerror = () => {
                script.remove();
                reject(new Error('Could not load the video module.'));
            };
            document.head.appendChild(script);
        });
    }

    // PS and RadioText use Roboto Mono like the webserver, loaded only when a video is made.
    function loadRobotoMono() {
        robotoMono ||= new Promise(resolve => {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = ROBOTO_MONO_URL;
            link.onload = () => resolve();
            link.onerror = () => resolve();
            setTimeout(resolve, 3000);
            document.head.appendChild(link);
        });
        return robotoMono;
    }

    function getPtyNames() {
        try {
            return window.localStorage.getItem('rdsMode') === 'true' ? PTY_NAMES_RBDS : PTY_NAMES_RDS;
        } catch (_error) {
            return PTY_NAMES_RDS;
        }
    }

    // The webserver's own signal unit setting, dBf when it isn't set.
    function getSignalUnit() {
        try {
            const unit = window.localStorage.getItem('signalUnit');
            return unit === 'dbuv' || unit === 'dbm' ? unit : 'dbf';
        } catch (_error) {
            return 'dbf';
        }
    }

    function formatDistance(km) {
        try {
            if (window.localStorage.getItem('imperialUnits') === 'true') return `${Math.round(km * 0.621371192)} mi`;
        } catch (_error) {}
        return `${Math.round(km)} km`;
    }

    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    }

    async function makeVideo(rec, stoppedAt) {
        if (!rec.audioStartedAt || !rec.audio.length) {
            setButton('idle');
            notify('error', 'Video recording failed', 'No audio was received from the server.');
            return;
        }
        const controller = new AbortController();
        encoding = controller;
        setButton('busy', '0%');
        const settings = QUALITY_SETTINGS[quality] || QUALITY_SETTINGS.high;
        const { width, height } = settings;
        const timestampAt = includeTimestamp ? formatTimestamp : null;
        try {
            const startedAt = rec.audioStartedAt;
            const data = {
                startedAt,
                durationMs: Math.max(0, stoppedAt - startedAt),
                signal: sliceSamples(rec.signal, startedAt, stoppedAt, sample => sample[0], (sample, offset) => [offset, ...sample.slice(1)]),
                rds: sliceSamples(rec.rds, startedAt, stoppedAt, sample => sample.t, (sample, offset) => ({ ...sample, t: offset }))
            };
            const frames = buildRecordingVideoFrames(data, computeRecordingPeaks(data), getPtyNames(), getSignalUnit(), timestampAt);
            const [audio, flags] = await Promise.all([
                new Blob(rec.audio).arrayBuffer(),
                loadRecordingVideoFlags(frames),
                loadScript(`${SCRIPT_BASE}videorec-video.js`, () => window.VideoRecVideo),
                loadRobotoMono()
            ]);
            if (controller.signal.aborted) return;
            const layout = await measureRecordingVideoLayout(width / height);
            if (controller.signal.aborted) return;
            const blob = await window.VideoRecVideo.createMp4({
                width,
                height,
                qp: settings.qp,
                keyframeIntervalMs: settings.keyframeIntervalMs,
                frames,
                endMs: data.durationMs,
                audio,
                draw: (ctx, frame) => drawRecordingVideoFrame(ctx, frame.view, layout, flags),
                onProgress: progress => {
                    if (encoding === controller) setButton('busy', `${Math.floor(progress * 100)}%`);
                },
                signal: controller.signal,
                creationTime: startedAt
            });
            if (controller.signal.aborted) return;
            downloadBlob(blob, rec.filename);
            notify('success', 'Video recording complete', rec.filename);
        } catch (error) {
            if (error?.name !== 'AbortError') notify('error', 'Video recording failed', error?.message || String(error));
        } finally {
            if (encoding === controller) {
                encoding = null;
                setButton('idle');
            }
        }
    }

    // ---- Recording data to panel views (shared logic with Visual Logbook) ----

    function findRecordingIndex(list, offsetMs, getTime) {
        if (!Array.isArray(list) || !list.length) return -1;
        let lo = 0;
        let hi = list.length - 1;
        let found = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (getTime(list[mid]) <= offsetMs) {
                found = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        return found;
    }

    // Running peak per signal sample, reset whenever the recorded frequency changes.
    function computeRecordingPeaks(data) {
        const signal = Array.isArray(data?.signal) ? data.signal : [];
        const rds = Array.isArray(data?.rds) ? data.rds : [];
        const peaks = new Array(signal.length);
        let rdsIndex = -1;
        let currentFreq;
        let peak = -Infinity;
        for (let i = 0; i < signal.length; i++) {
            while (rdsIndex + 1 < rds.length && rds[rdsIndex + 1].t <= signal[i][0]) rdsIndex++;
            const freq = rdsIndex >= 0 ? rds[rdsIndex].f : null;
            if (freq !== currentFreq) {
                currentFreq = freq;
                peak = -Infinity;
            }
            const value = Number(signal[i][1]);
            if (Number.isFinite(value) && value > peak) peak = value;
            peaks[i] = Number.isFinite(peak) ? peak : null;
        }
        return peaks;
    }

    function dbmToSUnitLabel(dbm) {
        const overS9 = dbm - S9_DBM;
        if (overS9 >= 0) {
            const rounded = Math.round(overS9);
            return rounded === 0 ? 'S9' : `S9+${rounded} dB`;
        }
        const sUnit = Math.max(0, Math.round(9 + overS9 / 6));
        return `S${sUnit}`;
    }

    function formatSignalValue(dbuv, unit) {
        if (dbuv === null) return '';
        if (unit === 'dbf') return (Math.round((dbuv + DBF_TO_DBUV) * 10) / 10).toFixed(1) + ' dBf';
        if (unit === 'dbm') return (Math.round((dbuv - 108.75) * 10) / 10).toFixed(1) + ' dBm';
        if (unit === 's') return dbmToSUnitLabel(dbuv - 108.75);
        return (Math.round(dbuv * 10) / 10).toFixed(1) + ' dB' + MICRO_SIGN + 'V';
    }

    function formatRecordingSignalParts(dbf, unit) {
        const dbuv = dbf - DBF_TO_DBUV;
        if (unit === 's') return { int: dbmToSUnitLabel(dbuv - 108.75), dec: '', unit: '' };
        let value = dbuv;
        let label = 'dB' + MICRO_SIGN + 'V';
        if (unit === 'dbf') {
            value = dbf;
            label = 'dBf';
        } else if (unit === 'dbm') {
            value = dbuv - 108.75;
            label = 'dBm';
        }
        const text = (Math.round(value * 10) / 10).toFixed(1);
        const dot = text.indexOf('.');
        return { int: text.slice(0, dot), dec: text.slice(dot), unit: label };
    }

    // Same per-character dimming as the webserver's processString(): opacity drops as the error count rises.
    function recordingCharOpacity(errorList, index) {
        const alpha = Number.parseInt(errorList[index], 10) * (50 / 11);
        return alpha ? Math.max(0, 70 - alpha) / 100 : 1;
    }

    // What the panel shows at a point in the recording.
    function getRecordingView(data, peaks, ptyNames, unit, offsetMs) {
        const sigIndex = findRecordingIndex(data.signal, offsetMs, sample => sample[0]);
        const rdsIndex = findRecordingIndex(data.rds, offsetMs, sample => sample.t);
        const sig = sigIndex >= 0 ? data.signal[sigIndex] : null;
        const rds = rdsIndex >= 0 ? data.rds[rdsIndex] : null;
        const quality = value => (Number.isFinite(value) ? `${value}%` : '-');
        const sigDbf = sig ? Number(sig[1]) : NaN;
        const peak = sigIndex >= 0 ? peaks[sigIndex] : null;
        const ms = Number.isInteger(rds?.ms) ? rds.ms : -1;
        const iso = /^[A-Z]{2}$/.test(String(rds?.ci || '')) && rds.ci !== 'UN' ? rds.ci : '';
        const tx = rds?.tx || null;
        return {
            title: [tx?.name, Number.isFinite(rds?.f) ? rds.f.toFixed(2) : ''].filter(Boolean).join(' \u{00B7} '),
            users: Number.isFinite(rds?.users) ? String(rds.users) : '',
            signal: Number.isFinite(sigDbf) ? formatRecordingSignalParts(sigDbf, unit) : { int: '-', dec: '', unit: '' },
            peak: Number.isFinite(peak) ? `\u{2191} ${formatSignalValue(peak - DBF_TO_DBUV, unit)}` : '',
            cci: quality(sig?.[2]),
            aci: quality(sig?.[3]),
            ps: rds?.ps || '',
            psErrors: rds?.pse || '',
            pi: rds?.pi || '-',
            regularPi: rds?.regularPi || '',
            freq: Number.isFinite(rds?.f) ? `${rds.f.toFixed(3)} MHz` : '-',
            tuner: [rds?.ant, rds?.bw ? `BW ${rds.bw}` : ''].filter(Boolean).join(' \u{00B7} '),
            rt: [[rds?.rt0, rds?.rte0], [rds?.rt1, rds?.rte1]]
                .map(([text, errors]) => ({ text: String(text || '').trimEnd(), errors: String(errors || '') }))
                .filter(line => line.text.trim()),
            pty: Number.isInteger(rds?.pty) ? (ptyNames[rds.pty] || '') : '',
            tp: rds?.tp === 1,
            ta: rds?.ta === 1,
            music: ms === 1,
            speech: ms === 0,
            stereo: sig?.[4] === 1,
            stereoForced: sig?.[5] === 1,
            flagIso: iso,
            tx: tx ? {
                name: tx.name || '',
                city: tx.city || '',
                itu: tx.itu || '',
                power: `${tx.erp || '?'} kW [${tx.pol || '?'}]`,
                dist: Number.isFinite(tx.dist) ? formatDistance(tx.dist) : '-',
                azi: Number.isFinite(tx.azi) ? `${Math.round(tx.azi)}\u{00B0}` : '-'
            } : null
        };
    }

    // timestampAt(ms since 1970), when given, adds each frame's time as view.time.
    function buildRecordingVideoFrames(data, peaks, ptyNames, unit, timestampAt = null) {
        const end = Math.max(0, Number(data.durationMs) || 0);
        const withTime = typeof timestampAt === 'function' && Number.isFinite(data.startedAt);
        const times = new Set([0]);
        (data.signal || []).forEach(sample => times.add(Math.round(sample[0])));
        (data.rds || []).forEach(sample => times.add(Math.round(sample.t)));
        // A frame on every whole second too, so the timestamp ticks with the clock.
        if (withTime) for (let t = 1000 - (data.startedAt % 1000); t < end; t += 1000) times.add(t);
        const frames = [];
        let lastKey = null;
        [...times].filter(t => t === 0 || (t > 0 && t < end)).sort((a, b) => a - b).forEach(t => {
            const view = getRecordingView(data, peaks, ptyNames, unit, t);
            if (withTime) view.time = timestampAt(data.startedAt + t);
            const key = JSON.stringify(view);
            if (key === lastKey) return;
            lastKey = key;
            frames.push({ t, view });
        });
        return frames;
    }

    async function loadRecordingVideoFlags(frames) {
        const flags = new Map();
        const isos = new Set(frames.map(frame => frame.view.flagIso).filter(Boolean));
        await Promise.all([...isos].map(async iso => {
            const image = new Image();
            image.src = new URL(`images/flags/${iso}.svg`, window.location.href).href;
            try {
                await image.decode();
                flags.set(iso, image);
            } catch (_error) {}
        }));
        return flags;
    }

    // ---- Layout measured from PANEL_CSS, then drawn per frame ----

    function canvasFontOf(style) {
        return `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    }

    // A hidden copy of the header and panel (in a shadow root, so the page's CSS can't reach it) is laid out at the
    // video's aspect ratio, then every box, font, colour, opacity and baseline is measured once.
    async function measureRecordingVideoLayout(aspect) {
        const host = document.createElement('div');
        host.style.cssText = 'position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;';
        const root = host.attachShadow({ mode: 'open' });
        root.innerHTML = `<style>${PANEL_CSS}</style><div class="vr-stage">${HEADER_HTML}<div class="vr-body">${PANEL_HTML}</div></div>`;
        const stage = root.querySelector('.vr-stage');
        const header = root.querySelector('.vr-header');
        const titleEl = header.querySelector('.vr-title');
        const timeEl = header.querySelector('.vr-time');
        const body = root.querySelector('.vr-body');
        const panel = root.querySelector('.vr-data');
        // Placeholder text, so every line takes its space.
        panel.querySelectorAll('[data-vr]').forEach(node => {
            if (node.tagName === 'IMG') return;
            node.hidden = false;
            if (!node.children.length && !node.textContent) node.textContent = '0';
        });
        document.body.appendChild(host);
        try {
            const fonts = new Set([...stage.querySelectorAll('*')].map(el => canvasFontOf(getComputedStyle(el))));
            if (document.fonts?.load) await Promise.all([...fonts].map(font => document.fonts.load(font).catch(() => {})));
            if (document.fonts?.ready) await document.fonts.ready;

            let width = 800;
            for (let i = 0; i < 4; i++) {
                stage.style.width = `${width}px`;
                const next = stage.getBoundingClientRect().height * aspect;
                if (Math.abs(next - width) < 0.5) break;
                width = next;
            }

            const origin = stage.getBoundingClientRect();
            const px = value => Number.parseFloat(value) || 0;
            const box = el => {
                const rect = el.getBoundingClientRect();
                return { x: rect.left - origin.left, y: rect.top - origin.top, w: rect.width, h: rect.height };
            };
            const contentBox = el => {
                const b = box(el);
                const s = getComputedStyle(el);
                const left = px(s.borderLeftWidth) + px(s.paddingLeft);
                const top = px(s.borderTopWidth) + px(s.paddingTop);
                return {
                    x: b.x + left,
                    y: b.y + top,
                    w: b.w - left - px(s.borderRightWidth) - px(s.paddingRight),
                    h: b.h - top - px(s.borderBottomWidth) - px(s.paddingBottom)
                };
            };
            const alphaOf = el => {
                let alpha = 1;
                for (let node = el; node && node !== stage; node = node.parentElement) {
                    const opacity = Number.parseFloat(getComputedStyle(node).opacity);
                    if (Number.isFinite(opacity)) alpha *= opacity;
                }
                return alpha;
            };
            const textStyle = el => {
                if (!el) return null;
                const style = getComputedStyle(el);
                // A zero-size inline-block sits on the first line's baseline.
                const probe = document.createElement('span');
                probe.style.cssText = 'display:inline-block;width:0;height:0;margin:0;padding:0;border:0;vertical-align:baseline;';
                el.insertBefore(probe, el.firstChild);
                const baseline = probe.getBoundingClientRect().bottom - origin.top;
                probe.remove();
                const own = contentBox(el);
                const area = contentBox(el.closest('.vr-cell') || header);
                return {
                    text: el.textContent,
                    font: canvasFontOf(style),
                    color: style.color,
                    alpha: alphaOf(el),
                    letterSpacing: style.letterSpacing === 'normal' ? '0px' : style.letterSpacing,
                    upper: style.textTransform === 'uppercase',
                    tabular: String(style.fontVariantNumeric || '').includes('tabular-nums'),
                    baseline,
                    left: own.x,
                    right: own.x + own.w,
                    top: own.y,
                    width: own.w,
                    lineHeight: px(style.lineHeight) || px(style.fontSize) * 1.2,
                    center: area.x + area.w / 2,
                    maxWidth: area.w,
                    bottom: area.y + area.h
                };
            };

            const field = key => panel.querySelector(`[data-vr="${key}"]`);
            const text = {};
            ['ps', 'aci', 'cci', 'pty', 'tp', 'ta', 'music', 'speech', 'pi', 'regularPi', 'freq', 'tuner', 'peak',
                'sigInt', 'sigDec', 'sigUnit', 'rt', 'txName', 'txCity', 'txPower', 'txDist', 'txAzi'].forEach(key => {
                text[key] = textStyle(field(key));
            });
            text.sigLine = textStyle(field('sigInt')?.parentElement);
            text.txCityLine = textStyle(field('txCity')?.parentElement);
            text.txItu = textStyle(field('txItu')?.parentElement);
            text.txMetaLine = textStyle(field('txPower')?.parentElement);
            text.txSep = textStyle(panel.querySelector('.vr-tx-sep'));

            const tp = field('tp');
            tp?.classList.add('vr-dim');
            const dim = tp ? Number.parseFloat(getComputedStyle(tp).opacity) : NaN;
            tp?.classList.remove('vr-dim');

            const stereo = field('stereo');
            const circles = () => [...(stereo?.querySelectorAll('.vr-circle') || [])]
                .filter(circle => getComputedStyle(circle).display !== 'none')
                .map(box);
            const stereoCircles = circles();
            stereo?.classList.add('vr-stereo-forced');
            const forcedCircles = circles();
            stereo?.classList.remove('vr-stereo-forced');
            const circleStyle = stereo?.querySelector('.vr-circle') ? getComputedStyle(stereo.querySelector('.vr-circle')) : null;

            const flagImg = field('flag');
            const flagSlot = flagImg?.parentElement;
            const flagsRow = panel.querySelector('.vr-flags');
            const headerStyle = getComputedStyle(header);
            const title = textStyle(titleEl);
            // The title shares the header with the listener count, so it is cut off at its own width.
            if (title) title.maxWidth = title.width;
            return {
                height: stage.getBoundingClientRect().height,
                background: getComputedStyle(body).backgroundColor,
                header: {
                    h: box(header).h,
                    background: headerStyle.backgroundColor,
                    border: px(headerStyle.borderBottomWidth),
                    borderColor: headerStyle.borderBottomColor,
                    gap: px(headerStyle.columnGap)
                },
                title,
                time: textStyle(timeEl),
                users: {
                    line: textStyle(header.querySelector('.vr-users')),
                    icon: textStyle(header.querySelector('.vr-users-icon')),
                    count: textStyle(header.querySelector('.vr-users-count'))
                },
                cells: [...panel.querySelectorAll('.vr-cell')].map(cell => {
                    const s = getComputedStyle(cell);
                    return { ...box(cell), radius: px(s.borderTopLeftRadius), background: s.backgroundColor, border: px(s.borderTopWidth), borderColor: s.borderTopColor };
                }),
                labels: [...panel.querySelectorAll('.vr-label')].map(textStyle),
                text,
                // RadioText lines that fit in its cell.
                rtLines: text.rt ? Math.max(1, Math.floor((text.rt.bottom - text.rt.top) / text.rt.lineHeight + 0.01)) : 0,
                dim: Number.isFinite(dim) ? dim : 0.2,
                flag: flagSlot && flagsRow ? {
                    x: box(flagSlot).x,
                    slotWidth: box(flagSlot).w,
                    width: px(getComputedStyle(flagImg).width) || 20,
                    center: box(flagsRow).y + box(flagsRow).h / 2,
                    alpha: alphaOf(flagSlot)
                } : null,
                stereo: stereoCircles.length && circleStyle ? {
                    circles: stereoCircles,
                    forced: forcedCircles,
                    lineWidth: px(circleStyle.borderTopWidth),
                    color: circleStyle.borderTopColor,
                    alpha: alphaOf(stereo)
                } : null
            };
        } finally {
            host.remove();
        }
    }

    function fitCanvasText(ctx, text, maxWidth) {
        if (ctx.measureText(text).width <= maxWidth) return text;
        let end = text.length;
        while (end > 0 && ctx.measureText(`${text.slice(0, end)}\u{2026}`).width > maxWidth) end--;
        return `${text.slice(0, end)}\u{2026}`;
    }

    // Canvas has no tabular-nums, so tabular digits get slots as wide as the widest digit.
    function tabularDigitWidth(ctx) {
        return Math.max(...[...'0123456789'].map(digit => ctx.measureText(digit).width));
    }

    function measureCanvasText(ctx, text, tabular) {
        if (!tabular) return ctx.measureText(text).width;
        const digit = tabularDigitWidth(ctx);
        return (String(text).match(/\d+|\D+/g) || [])
            .reduce((sum, part) => sum + (/\d/.test(part) ? part.length * digit : ctx.measureText(part).width), 0);
    }

    // Left-aligned at x.
    function fillCanvasText(ctx, text, x, y, tabular) {
        ctx.textAlign = 'left';
        if (!tabular) {
            ctx.fillText(text, x, y);
            return;
        }
        const digit = tabularDigitWidth(ctx);
        (String(text).match(/\d+|\D+/g) || []).forEach(part => {
            if (/\d/.test(part)) {
                ctx.textAlign = 'center';
                for (let i = 0; i < part.length; i++) ctx.fillText(part[i], x + digit * (i + 0.5), y);
                ctx.textAlign = 'left';
                x += part.length * digit;
            } else {
                ctx.fillText(part, x, y);
                x += ctx.measureText(part).width;
            }
        });
    }

    function setLayoutFont(ctx, style, alpha = 1) {
        ctx.font = style.font;
        ctx.fillStyle = style.color;
        ctx.globalAlpha = style.alpha * alpha;
        ctx.textAlign = 'left';
        if ('letterSpacing' in ctx) ctx.letterSpacing = style.letterSpacing;
    }

    // One line of text as measured, centred in its cell or from its own left edge.
    function drawLayoutText(ctx, style, text, align = 'center', alpha = 1) {
        if (!style || !text) return;
        setLayoutFont(ctx, style, alpha);
        const shown = fitCanvasText(ctx, style.upper ? text.toUpperCase() : text, style.maxWidth);
        const x = align === 'left' ? style.left : style.center - measureCanvasText(ctx, shown, style.tabular) / 2;
        fillCanvasText(ctx, shown, x, style.baseline, style.tabular);
    }

    // Runs [[style, text]] centred (or right-aligned) together on the line's baseline, like spans sharing one line.
    function drawLayoutRuns(ctx, line, runs, align = 'center') {
        if (!line) return;
        const parts = runs.filter(([style, text]) => style && text);
        const widths = parts.map(([style, text]) => {
            setLayoutFont(ctx, style);
            return measureCanvasText(ctx, text, style.tabular);
        });
        const total = widths.reduce((sum, width) => sum + width, 0);
        let x = align === 'right' ? line.right - total : line.center - total / 2;
        parts.forEach(([style, text], i) => {
            setLayoutFont(ctx, style);
            fillCanvasText(ctx, text, x, line.baseline, style.tabular);
            x += widths[i];
        });
    }

    function canvasRoundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }

    function drawRecordingVideoFrame(ctx, view, layout, flags) {
        const scale = ctx.canvas.height / layout.height;
        const width = ctx.canvas.width / scale;
        ctx.setTransform(scale, 0, 0, scale, 0, 0);
        ctx.globalAlpha = 1;
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = layout.background;
        ctx.fillRect(0, 0, width, layout.height);

        const header = layout.header;
        ctx.fillStyle = header.background;
        ctx.fillRect(0, 0, width, header.h);
        ctx.fillStyle = header.borderColor;
        ctx.fillRect(0, header.h - header.border, width, header.border);
        let title = layout.title;
        if (view.time && layout.time) {
            setLayoutFont(ctx, layout.time);
            const timeLeft = layout.time.center - measureCanvasText(ctx, view.time, layout.time.tabular) / 2;
            // The title stops short of the centred timestamp.
            if (title) title = { ...title, maxWidth: Math.min(title.maxWidth, timeLeft - header.gap - title.left) };
            drawLayoutText(ctx, layout.time, view.time);
        }
        drawLayoutText(ctx, title, view.title, 'left');
        if (view.users) {
            const users = layout.users;
            drawLayoutRuns(ctx, users.line, [[users.icon, users.icon?.text], [users.line, ' '], [users.count, view.users]], 'right');
        }

        ctx.globalAlpha = 1;
        layout.cells.forEach(cell => {
            const inset = cell.border / 2;
            const radius = Math.min(Math.max(0, cell.radius - inset), cell.w / 2, cell.h / 2);
            canvasRoundRect(ctx, cell.x + inset, cell.y + inset, cell.w - cell.border, cell.h - cell.border, radius);
            ctx.fillStyle = cell.background;
            ctx.fill();
            if (cell.border) {
                ctx.strokeStyle = cell.borderColor;
                ctx.lineWidth = cell.border;
                ctx.stroke();
            }
        });
        layout.labels.forEach(label => drawLayoutText(ctx, label, label?.text));

        const t = layout.text;
        if (t.ps) {
            setLayoutFont(ctx, t.ps);
            const ps = String(view.ps || '').padEnd(8, ' ');
            const errors = String(view.psErrors || '').split(',');
            const charWidth = ctx.measureText('M').width;
            const left = t.ps.center - charWidth * ps.length / 2;
            for (let i = 0; i < ps.length; i++) {
                ctx.globalAlpha = t.ps.alpha * recordingCharOpacity(errors, i);
                ctx.fillText(ps[i], left + charWidth * i, t.ps.baseline);
            }
        }
        drawLayoutText(ctx, t.aci, view.aci);
        drawLayoutText(ctx, t.cci, view.cci);
        drawLayoutText(ctx, t.pty, view.pty);

        const dim = on => (on ? 1 : layout.dim);
        drawLayoutText(ctx, t.tp, t.tp?.text, 'left', dim(view.tp));
        drawLayoutText(ctx, t.ta, t.ta?.text, 'left', dim(view.ta));
        drawLayoutText(ctx, t.music, t.music?.text, 'left', dim(view.music));
        drawLayoutText(ctx, t.speech, t.speech?.text, 'left', dim(view.speech));
        const flag = flags.get(view.flagIso);
        if (flag && layout.flag) {
            const f = layout.flag;
            const height = flag.naturalWidth ? f.width * flag.naturalHeight / flag.naturalWidth : f.width * 0.75;
            ctx.globalAlpha = f.alpha;
            ctx.drawImage(flag, f.x + (f.slotWidth - f.width) / 2, f.center - height / 2, f.width, height);
        }
        const stereo = layout.stereo;
        if (stereo) {
            ctx.globalAlpha = stereo.alpha * dim(view.stereo);
            ctx.strokeStyle = stereo.color;
            ctx.lineWidth = stereo.lineWidth;
            ctx.beginPath();
            (view.stereoForced ? stereo.forced : stereo.circles).forEach(circle => {
                const radius = (circle.w - stereo.lineWidth) / 2;
                ctx.moveTo(circle.x + circle.w / 2 + radius, circle.y + circle.h / 2);
                ctx.arc(circle.x + circle.w / 2, circle.y + circle.h / 2, radius, 0, Math.PI * 2);
            });
            ctx.stroke();
        }

        drawLayoutText(ctx, t.pi, view.pi);
        drawLayoutText(ctx, t.regularPi, view.regularPi);
        drawLayoutText(ctx, t.freq, view.freq);
        drawLayoutText(ctx, t.tuner, view.tuner);
        drawLayoutText(ctx, t.peak, view.peak);
        drawLayoutRuns(ctx, t.sigLine, [
            [t.sigInt, view.signal.int],
            [t.sigDec, view.signal.dec],
            [t.sigLine, ' '],
            [t.sigUnit, view.signal.unit]
        ]);

        const rt = t.rt;
        if (rt) {
            setLayoutFont(ctx, rt);
            view.rt.slice(0, layout.rtLines).forEach((line, i) => {
                const y = rt.baseline + rt.lineHeight * i;
                // Lines don't wrap, one too wide ends in an ellipsis like the panel's text-overflow.
                const shown = fitCanvasText(ctx, line.text, rt.width);
                const end = shown === line.text ? line.text.length : shown.length - 1;
                const errorList = line.errors.split(',');
                let runStart = 0;
                while (runStart < end) {
                    const opacity = recordingCharOpacity(errorList, runStart);
                    let runEnd = runStart + 1;
                    while (runEnd < end && recordingCharOpacity(errorList, runEnd) === opacity) runEnd++;
                    ctx.globalAlpha = rt.alpha * opacity;
                    ctx.fillText(line.text.slice(runStart, runEnd), rt.left + ctx.measureText(line.text.slice(0, runStart)).width, y);
                    runStart = runEnd;
                }
                if (end < line.text.length) {
                    ctx.globalAlpha = rt.alpha;
                    ctx.fillText('\u{2026}', rt.left + ctx.measureText(line.text.slice(0, end)).width, y);
                }
            });
        }

        const tx = view.tx;
        if (tx) {
            drawLayoutText(ctx, t.txName, tx.name);
            drawLayoutRuns(ctx, t.txCityLine, [[t.txCity, tx.city], [t.txCityLine, ' '], [t.txItu, `[${tx.itu}]`]]);
            const sep = t.txSep?.text || '\u{2022}';
            drawLayoutRuns(ctx, t.txMetaLine, [
                [t.txPower, tx.power], [t.txMetaLine, ' '], [t.txSep, sep], [t.txMetaLine, ' '],
                [t.txDist, tx.dist], [t.txMetaLine, ' '], [t.txSep, sep], [t.txMetaLine, ' '], [t.txAzi, tx.azi]
            ]);
        }
        ctx.globalAlpha = 1;
    }

    // ---- Start-up ----

    // Plugin scripts run before the webserver's plugins.js, so wait for its button helper.
    function addButton(attempt = 0) {
        if (typeof addIconToPluginPanel !== 'function') {
            if (attempt < 100) setTimeout(() => addButton(attempt + 1), 100);
            else console.error('[VideoRec] addIconToPluginPanel not found after 10 seconds.');
            return;
        }
        addIconToPluginPanel(BUTTON_ID, 'Video', 'solid', 'video', '');
        const style = document.createElement('style');
        style.textContent = BUTTON_CSS;
        document.head.appendChild(style);
        const bind = (tries = 0) => {
            const button = document.getElementById(BUTTON_ID);
            if (!button) {
                if (tries < 50) setTimeout(() => bind(tries + 1), 100);
                return;
            }
            // The webserver's tooltip is replaced by our own, which also mentions the right-click menu.
            if (typeof $ === 'function') $(button).off('mouseenter mouseleave focusin focusout');
            button.addEventListener('click', () => {
                hideTooltip();
                onButtonClick();
            });
            button.addEventListener('mouseenter', () => {
                if (window.matchMedia('(hover: hover)').matches) showTooltip(button);
            });
            button.addEventListener('mouseleave', hideTooltip);
            button.addEventListener('contextmenu', event => {
                event.preventDefault();
                hideTooltip();
                openMenu(event.clientX, event.clientY);
            });
        };
        bind();
    }

    addButton();
})();
