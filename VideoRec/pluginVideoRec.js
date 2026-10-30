/*
    VideoRec v1.3.1 by AAD
    ----------------------
    https://github.com/AmateurAudioDude/FM-DX-Webserver-Plugin-Video-Recorder

    Original concept taken from the Audio Recorder Plugin by mrwish7: https://github.com/mrwish7/webserver-audio-recorder

    Records the server's MP3 audio stream together with the live signal, RDS and TX data, then saves both as an
    MP4 video of the data panel. Everything happens in the browser.
*/

(() => {
    'use strict';

    // Longest recording in seconds, the whole recording stays in memory until it has been made into a video.
    const MAX_RECORDING_SECONDS = 600;
    // Pre-roll: the audio stays connected, so a recording starts up to PRE_ROLL_SECONDS before the button was pressed.
    const PRE_ROLL_ENABLED = true;
    const PRE_ROLL_SECONDS = 15;
    // true for tuners using MPX mode
    const FORCED_MONO_IS_MPX = false;
    // Per quality (right-click menu): video size, H.264 quantizer qp (0-51, lower = better quality, each +6 roughly
    // halves the video part of the file) and full picture interval in ms. Used by both the browser's encoder and VideoRec's.
    const QUALITY_SETTINGS = {
        high: { width: 1344, height: 576, qp: 18, keyframeIntervalMs: 4000 },
        low: { width: 952, height: 408, qp: 24, keyframeIntervalMs: 8000 }
    };

    // const plugin update checker variables
    const pluginVersion = '1.3.1';
    const pluginName = "VideoRec";
    const pluginHomepageUrl = "https://github.com/AmateurAudioDude/FM-DX-Webserver-Plugin-Video-Recorder";
    const pluginUpdateUrl = "https://raw.githubusercontent.com/AmateurAudioDude/FM-DX-Webserver-Plugin-Video-Recorder/refs/heads/main/VideoRec/pluginVideoRec.js";
    const pluginSetupOnlyNotify = true;
    const CHECK_FOR_UPDATES = true;

    const QUALITY_KEY = 'videorec-quality';
    const TIMESTAMP_KEY = 'videorec-timestamp';
    const THEME_KEY = 'videorec-theme';
    const SERVER_NAME_KEY = 'videorec-server-name';
    const AVERAGE_SIGNAL_KEY = 'videorec-average-signal';
    const PRE_ROLL_KEY = 'videorec-preroll';
    const PRE_ROLL_RETRY_MS = 5000;
    const SIGNAL_KEEPALIVE_MS = 1000;
    // "Average Signal": the webserver shows the mean of its last 8 readings, sent at most every 75 ms.
    const SIGNAL_AVERAGE_READINGS = 8;
    const SIGNAL_READING_MS = 75;
    const BUTTON_ID = 'social-record-btn';
    const SCRIPT_BASE = new URL('videorec/', window.location.href).href;
    const AUDIO_URL = `${window.location.protocol === 'https:' ? 'wss://' : 'ws://'}${window.location.host}${window.location.pathname}audio`;
    const ROBOTO_MONO_URL = 'https://fonts.googleapis.com/css2?family=Roboto+Mono:wght@400;500&display=swap';

    // Same offsets as the webserver: dBuV = dBf - 11.25, dBuV = dBm + 108.75.
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

    // The video is measured from this CSS.
    const PANEL_CSS = `
:host { all: initial; }
[hidden] { display: none !important; }
.vr-stage { display: flex; flex-direction: column; font-family: "SF Pro Text", Arial, Helvetica, sans-serif; font-size: 16px; line-height: normal; color: #e5e7eb; }
.vr-stage * { box-sizing: border-box; }
.vr-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; background: #0b1220; border-bottom: 1px solid rgba(148, 163, 184, 0.2); font-size: 14px; }
.vr-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vr-time { flex: 0 0 auto; white-space: nowrap; font-variant-numeric: tabular-nums; }
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
.vr-circle { --vr-circle-line: 1.5px; position: absolute; top: 0; width: 12px; height: 12px; border: var(--vr-circle-line) solid currentColor; border-radius: 50%; }
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

    // "Webserver Theme" colours.
    const THEME_CSS = `
.vr-stage, .vr-data { color: var(--color-text, #e5e7eb); }
.vr-header { background: var(--color-1, #0b1220); border-bottom-color: var(--color-2, rgba(148, 163, 184, 0.2)); }
.vr-body { background: var(--color-main, #000); }
.vr-cell { background: var(--color-1-transparent, rgba(15, 23, 42, 0.85)); border-color: var(--color-2-transparent, rgba(148, 163, 184, 0.2)); }
.vr-label { color: var(--color-4, #38bdf8); }
.vr-pty, .vr-tx-name { color: var(--color-main-bright, #38bdf8); }`;

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
    let useTheme = loadTheme();
    let showServerName = loadServerName();
    let averageSignal = loadAverageSignal();
    let preRollOn = loadPreRoll();
    let preRoll = null;
    let preRollRetry = 0;
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
            sendToast(type, title, message, false, false);
        } else {
            console.log(`[${pluginName}] ${title}: ${message}`);
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
            return window.localStorage.getItem(TIMESTAMP_KEY) !== '0';
        } catch (_error) {
            return true;
        }
    }

    function saveTimestamp(value) {
        includeTimestamp = value;
        try {
            window.localStorage.setItem(TIMESTAMP_KEY, value ? '1' : '0');
        } catch (_error) {}
    }

    function loadTheme() {
        try {
            return window.localStorage.getItem(THEME_KEY) === '1';
        } catch (_error) {
            return false;
        }
    }

    function saveTheme(value) {
        useTheme = value;
        try {
            window.localStorage.setItem(THEME_KEY, value ? '1' : '0');
        } catch (_error) {}
    }

    function loadServerName() {
        try {
            return window.localStorage.getItem(SERVER_NAME_KEY) !== '0';
        } catch (_error) {
            return true;
        }
    }

    function saveServerName(value) {
        showServerName = value;
        try {
            window.localStorage.setItem(SERVER_NAME_KEY, value ? '1' : '0');
        } catch (_error) {}
    }

    function loadAverageSignal() {
        try {
            return window.localStorage.getItem(AVERAGE_SIGNAL_KEY) === '1';
        } catch (_error) {
            return false;
        }
    }

    function saveAverageSignal(value) {
        averageSignal = value;
        try {
            window.localStorage.setItem(AVERAGE_SIGNAL_KEY, value ? '1' : '0');
        } catch (_error) {}
    }

    function loadPreRoll() {
        try {
            return window.localStorage.getItem(PRE_ROLL_KEY) === '1';
        } catch (_error) {
            return false;
        }
    }

    function savePreRoll(value) {
        preRollOn = value;
        try {
            window.localStorage.setItem(PRE_ROLL_KEY, value ? '1' : '0');
        } catch (_error) {}
        if (value) startPreRoll();
        else stopPreRoll();
    }

    function hideTooltip() {
        clearTimeout(tooltipTimer);
        if (!tooltip) return;
        const tip = tooltip;
        tooltip = null;
        tip.style.opacity = '0';
        setTimeout(() => tip.remove(), 300);
    }

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

    // A backdrop closes it, so nothing listens page-wide.
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
        const items = [
            ['Webserver Theme', useTheme, () => saveTheme(!useTheme)],
            ['Show Server Name', showServerName, () => saveServerName(!showServerName)],
            ['Include Timestamp', includeTimestamp, () => saveTimestamp(!includeTimestamp)],
            ['Average Signal', averageSignal, () => saveAverageSignal(!averageSignal)],
            ['High Quality', quality === 'high', () => saveQuality(quality === 'high' ? 'low' : 'high')]
        ];
        if (PRE_ROLL_ENABLED) items.push([`Pre-roll (${PRE_ROLL_SECONDS} sec)`, preRollOn, () => savePreRoll(!preRollOn)]);
        items.forEach(([label, on, toggle]) => {
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

    // keepMs: pre-roll length, 0 keeps everything.
    function openCapture(keepMs) {
        let audioSocket;
        try {
            audioSocket = new WebSocket(AUDIO_URL);
        } catch (_error) {
            return null;
        }
        audioSocket.binaryType = 'arraybuffer';
        const cap = {
            keepMs,
            audioSocket,
            audio: [],
            signal: [],
            rds: [],
            lastSigRaw: null,
            lastSignalAt: 0,
            lastRdsKey: null,
            readings: 0,
            firstReadingAt: 0,
            lastReadingAt: 0,
            dataSocket: null,
            onData: null,
            onClose: null,
            closed: false,
            ticker: 0,
            limit: 0
        };
        cap.onData = event => recordData(cap, event);
        audioSocket.addEventListener('open', () => audioSocket.send(JSON.stringify({ type: 'fallback', data: 'mp3' })));
        audioSocket.addEventListener('message', event => {
            if (cap.closed || !(event.data instanceof ArrayBuffer)) return;
            const now = Date.now();
            cap.audio.push([now, event.data]);
            if (cap.keepMs) trimCapture(cap, now - cap.keepMs);
        });
        audioSocket.addEventListener('close', () => {
            if (!cap.closed) cap.onClose?.();
        });
        attachDataSocket(cap);
        return cap;
    }

    function closeCapture(cap) {
        cap.closed = true;
        clearInterval(cap.ticker);
        clearTimeout(cap.limit);
        cap.dataSocket?.removeEventListener('message', cap.onData);
        try {
            cap.audioSocket.close();
        } catch (_error) {}
    }

    // The last data sample before cutoff is kept as the starting state.
    function trimCapture(cap, cutoff) {
        let audio = 0;
        while (audio < cap.audio.length && cap.audio[audio][0] < cutoff) audio++;
        if (audio) cap.audio.splice(0, audio);
        [[cap.signal, sample => sample[0]], [cap.rds, sample => sample.t]].forEach(([list, timeOf]) => {
            let drop = 0;
            while (drop + 1 < list.length && timeOf(list[drop + 1]) <= cutoff) drop++;
            if (drop) list.splice(0, drop);
        });
    }

    function startPreRoll() {
        clearTimeout(preRollRetry);
        if (!PRE_ROLL_ENABLED || !preRollOn || preRoll || recording) return;
        const cap = openCapture(PRE_ROLL_SECONDS * 1000);
        if (!cap) return;
        cap.onClose = () => {
            closeCapture(cap);
            if (preRoll === cap) preRoll = null;
            preRollRetry = setTimeout(startPreRoll, PRE_ROLL_RETRY_MS);
        };
        cap.ticker = setInterval(() => attachDataSocket(cap), 1000);
        preRoll = cap;
    }

    function stopPreRoll() {
        clearTimeout(preRollRetry);
        if (!preRoll) return;
        closeCapture(preRoll);
        preRoll = null;
    }

    function startRecording() {
        let rec = preRoll;
        preRoll = null;
        clearTimeout(preRollRetry);
        if (rec) {
            clearInterval(rec.ticker);
            trimCapture(rec, Date.now() - rec.keepMs);
            rec.keepMs = 0;
        } else {
            rec = openCapture(0);
            if (!rec) {
                notify('error', 'Video recording failed', 'Could not connect to the audio stream.');
                return;
            }
        }
        rec.filename = videoFilename();
        rec.pressedAt = Date.now();
        rec.onClose = () => {
            if (recording === rec) stopRecording(['warning', 'The audio stream closed, so the recording was stopped.']);
        };
        recording = rec;
        // The page replaces its data socket on reconnect.
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
        closeCapture(rec);
        if (notice && rec.audio.length) notify(notice[0], 'Video recording', notice[1]);
        makeVideo(rec, Date.now());
        startPreRoll();
    }

    function parseQuality(value) {
        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : null;
    }

    function readTunerSetup() {
        const ant = document.querySelector('.data-ant input');
        const bw = document.querySelector('.data-bw input');
        return {
            ant: ant ? String(ant.value || ant.placeholder || '').trim() : '',
            bw: bw ? String(bw.value || bw.placeholder || '').trim() : ''
        };
    }

    // Same sample format as Visual Logbook's recorder.
    function recordData(rec, event) {
        if (rec.closed || typeof event.data !== 'string' || event.data[0] !== '{') return;
        let data;
        try {
            data = JSON.parse(event.data);
        } catch (_error) {
            return;
        }
        const now = Date.now();
        const freq = Number.parseFloat(data.freq);
        if (!rec.readings++) rec.firstReadingAt = now;
        rec.lastReadingAt = now;

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
            // Matched by regional PI.
            regularPi: txInfo.reg === true ? String(txInfo.pi || '') : '',
            ant: tuner.ant,
            bw: tuner.bw,
            users: Number.isFinite(users) ? users : null
        });
    }

    // The last sample before startedAt becomes the one at 0.
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

    // How far apart the webserver's readings arrived, never under its 75 ms minimum.
    function signalReadingMs(rec) {
        if (rec.readings < 2) return SIGNAL_READING_MS;
        return Math.max(SIGNAL_READING_MS, Math.round((rec.lastReadingAt - rec.firstReadingAt) / (rec.readings - 1)));
    }

    async function makeVideo(rec, stoppedAt) {
        if (!rec.audio.length) {
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
            const startedAt = rec.audio[0][0];
            const data = {
                startedAt,
                durationMs: Math.max(0, stoppedAt - startedAt),
                signal: sliceSamples(rec.signal, startedAt, stoppedAt, sample => sample[0], (sample, offset) => [offset, ...sample.slice(1)]),
                rds: sliceSamples(rec.rds, startedAt, stoppedAt, sample => sample.t, (sample, offset) => ({ ...sample, t: offset })),
                forcedMonoIsMpx: FORCED_MONO_IS_MPX
            };
            const frames = buildRecordingVideoFrames(data, computeRecordingPeaks(data), getPtyNames(), getSignalUnit(), timestampAt, averageSignal ? signalReadingMs(rec) : 0);
            const serverName = showServerName ? String(document.querySelector('#tuner-name span')?.textContent || '').trim() : '';
            if (serverName) frames.forEach(frame => { frame.view.title = serverName; });
            const [audio, flags] = await Promise.all([
                new Blob(rec.audio.map(([, data]) => data)).arrayBuffer(),
                loadRecordingVideoFlags(frames),
                loadScript(`${SCRIPT_BASE}videorec-video.js`, () => window.VideoRecVideo),
                loadRobotoMono()
            ]);
            if (controller.signal.aborted) return;
            let layout = await measureRecordingVideoLayout(width / height, useTheme);
            if (useTheme && !canvasDrawsColors(layout)) {
                console.info(`[${pluginName}] This browser can't draw the webserver theme's colours, using the default look.`);
                layout = await measureRecordingVideoLayout(width / height, false);
            }
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
            const name = rec.filename;
            notify('success', 'Video recording complete', navigator.userAgent.indexOf('Chrome') === -1 && name.length > 28 ? name.slice(0, 16) + '...' + name.slice(-12) : name);
        } catch (error) {
            if (error?.name !== 'AbortError') notify('error', 'Video recording failed', error?.message || String(error));
        } finally {
            if (encoding === controller) {
                encoding = null;
                setButton('idle');
            }
        }
    }

    // ---- Panel views (shared with Visual Logbook) ----

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

    // Resets on frequency change.
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

    // Same dimming as the webserver's processString().
    function recordingCharOpacity(errorList, index) {
        const alpha = Number.parseInt(errorList[index], 10) * (50 / 11);
        return alpha ? Math.max(0, 70 - alpha) / 100 : 1;
    }

    // Only changes are stored, so each value stands for the readings until the next one, spread evenly.
    function recordingSignalReadings(signal, index, readingMs) {
        const next = signal[index + 1];
        if (!next) return { count: Infinity, spacing: readingMs };
        const count = Math.max(1, Math.round((next[0] - signal[index][0]) / readingMs));
        return { count, spacing: (next[0] - signal[index][0]) / count };
    }

    function averageRecordingSignal(signal, offsetMs, readingMs) {
        let left = SIGNAL_AVERAGE_READINGS;
        let sum = 0;
        let count = 0;
        for (let index = findRecordingIndex(signal, offsetMs, sample => sample[0]), first = true; index >= 0 && left > 0; index--, first = false) {
            const readings = recordingSignalReadings(signal, index, readingMs);
            const take = Math.min(left, first ? Math.floor((offsetMs - signal[index][0]) / readings.spacing + 1e-9) + 1 : readings.count);
            if (Number.isFinite(signal[index][1])) {
                sum += signal[index][1] * take;
                count += take;
            }
            left -= take;
        }
        return count ? sum / count : NaN;
    }

    function getRecordingView(data, peaks, ptyNames, unit, offsetMs, averageMs = 0) {
        const sigIndex = findRecordingIndex(data.signal, offsetMs, sample => sample[0]);
        const rdsIndex = findRecordingIndex(data.rds, offsetMs, sample => sample.t);
        const sig = sigIndex >= 0 ? data.signal[sigIndex] : null;
        const rds = rdsIndex >= 0 ? data.rds[rdsIndex] : null;
        const quality = value => (Number.isFinite(value) ? `${value}%` : '-');
        const sigDbf = averageMs ? averageRecordingSignal(data.signal, offsetMs, averageMs) : (sig ? Number(sig[1]) : NaN);
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
            // forcedMonoIsMpx: forced mono means MPX mode, so the circles show the pilot as in stereo mode.
            stereoForced: sig?.[5] === 1 && data.forcedMonoIsMpx !== true,
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

    // averageMs: reading interval for "Average Signal", 0 = off.
    function buildRecordingVideoFrames(data, peaks, ptyNames, unit, timestampAt = null, averageMs = 0) {
        const end = Math.max(0, Number(data.durationMs) || 0);
        const withTime = typeof timestampAt === 'function' && Number.isFinite(data.startedAt);
        const times = new Set([0]);
        (data.signal || []).forEach(sample => times.add(Math.round(sample[0])));
        (data.rds || []).forEach(sample => times.add(Math.round(sample.t)));
        // Whole seconds, so the timestamp ticks.
        if (withTime) for (let t = 1000 - (data.startedAt % 1000); t < end; t += 1000) times.add(t);
        if (averageMs) (data.signal || []).forEach((sample, i) => {
            const readings = recordingSignalReadings(data.signal, i, averageMs);
            for (let m = 1; m < Math.min(readings.count, SIGNAL_AVERAGE_READINGS); m++) times.add(Math.ceil(sample[0] + m * readings.spacing));
        });
        const frames = [];
        let lastKey = null;
        [...times].filter(t => t === 0 || (t > 0 && t < end)).sort((a, b) => a - b).forEach(t => {
            const view = getRecordingView(data, peaks, ptyNames, unit, t, averageMs);
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

    // ---- Layout and drawing ----

    function canvasFontOf(style) {
        return `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    }

    // Shadow root, so the page's CSS can't reach it.
    async function measureRecordingVideoLayout(aspect, themed = false) {
        const host = document.createElement('div');
        host.style.cssText = 'position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;';
        const root = host.attachShadow({ mode: 'open' });
        root.innerHTML = `<style>${PANEL_CSS}${themed ? THEME_CSS : ''}</style><div class="vr-stage">${HEADER_HTML}<div class="vr-body">${PANEL_HTML}</div></div>`;
        const stage = root.querySelector('.vr-stage');
        const header = root.querySelector('.vr-header');
        const titleEl = header.querySelector('.vr-title');
        const timeEl = header.querySelector('.vr-time');
        const body = root.querySelector('.vr-body');
        const panel = root.querySelector('.vr-data');
        // Placeholders, so empty lines take space.
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
                // Baseline probe.
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
                    // Border widths are rounded to screen pixels, the variable isn't.
                    lineWidth: px(circleStyle.getPropertyValue('--vr-circle-line')) || px(circleStyle.borderTopWidth),
                    color: circleStyle.borderTopColor,
                    alpha: alphaOf(stereo)
                } : null
            };
        } finally {
            host.remove();
        }
    }

    // Theme shades are color-mix() results, which a canvas may not accept.
    function canvasDrawsColors(layout) {
        const ctx = document.createElement('canvas').getContext('2d');
        const colors = [];
        const collect = value => {
            if (!value || typeof value !== 'object') return;
            Object.entries(value).forEach(([key, item]) => {
                if (typeof item === 'string' && (key === 'color' || key === 'background' || key === 'borderColor')) colors.push(item);
                else collect(item);
            });
        };
        collect(layout);
        return colors.every(color => {
            ctx.fillStyle = '#000';
            ctx.fillStyle = color;
            const first = ctx.fillStyle;
            ctx.fillStyle = '#fff';
            ctx.fillStyle = color;
            return ctx.fillStyle === first;
        });
    }

    function fitCanvasText(ctx, text, maxWidth) {
        if (ctx.measureText(text).width <= maxWidth) return text;
        let end = text.length;
        while (end > 0 && ctx.measureText(`${text.slice(0, end)}\u{2026}`).width > maxWidth) end--;
        return `${text.slice(0, end)}\u{2026}`;
    }

    // Canvas has no tabular-nums.
    function tabularDigitWidth(ctx) {
        return Math.max(...[...'0123456789'].map(digit => ctx.measureText(digit).width));
    }

    function measureCanvasText(ctx, text, tabular) {
        if (!tabular) return ctx.measureText(text).width;
        const digit = tabularDigitWidth(ctx);
        return (String(text).match(/\d+|\D+/g) || [])
            .reduce((sum, part) => sum + (/\d/.test(part) ? part.length * digit : ctx.measureText(part).width), 0);
    }

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

    function drawLayoutText(ctx, style, text, align = 'center', alpha = 1) {
        if (!style || !text) return;
        setLayoutFont(ctx, style, alpha);
        const shown = fitCanvasText(ctx, style.upper ? text.toUpperCase() : text, style.maxWidth);
        const x = align === 'left' ? style.left : style.center - measureCanvasText(ctx, shown, style.tabular) / 2;
        fillCanvasText(ctx, shown, x, style.baseline, style.tabular);
    }

    // runs: [[style, text]] drawn as one line.
    function drawLayoutRuns(ctx, line, runs, align = 'center') {
        if (!line) return 0;
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
        return total;
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
        // Right to left: listener count, timestamp, then the title gets what's left.
        const users = layout.users;
        let right = users.line ? users.line.right : width;
        if (view.users) {
            right -= drawLayoutRuns(ctx, users.line, [[users.icon, users.icon?.text], [users.line, ' '], [users.count, view.users]], 'right') + header.gap;
        }
        if (view.time && layout.time) {
            setLayoutFont(ctx, layout.time);
            right -= measureCanvasText(ctx, view.time, layout.time.tabular);
            fillCanvasText(ctx, view.time, right, layout.time.baseline, layout.time.tabular);
            right -= header.gap;
        }
        if (layout.title) drawLayoutText(ctx, { ...layout.title, maxWidth: right - layout.title.left }, view.title, 'left');

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

    // plugins.js loads after plugin scripts.
    function addButton(attempt = 0) {
        if (typeof addIconToPluginPanel !== 'function') {
            if (attempt < 100) setTimeout(() => addButton(attempt + 1), 100);
            else console.error(`[${pluginName}] addIconToPluginPanel not found after 10 seconds.`);
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
            // Replaced by our own tooltip.
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
            startPreRoll();
        };
        bind();
    }

    addButton();

    if (window.location.pathname === '/setup') {
        // Function for update notification in /setup
        function checkUpdate(e,n,t,o){if(e&&"/setup"!==location.pathname)return;let i="undefined"!=typeof pluginVersion?pluginVersion:"undefined"!=typeof plugin_version?plugin_version:"undefined"!=typeof PLUGIN_VERSION?PLUGIN_VERSION:"Unknown";async function r(){try{let e=await fetch(o);if(!e.ok)throw new Error("["+n+"] update check HTTP error! status: "+e.status);let t=(await e.text()).split("\n"),r;if(t.length>2){let e=t.find(e=>e.includes("const pluginVersion =")||e.includes("const plugin_version =")||e.includes("const PLUGIN_VERSION ="));if(e){let n=e.match(/const\s+(?:pluginVersion|plugin_version|PLUGIN_VERSION)\s*=\s*['"]([^'"]+)['"]/);n&&(r=n[1])}}return r||(r=/^\d/.test(t[0].trim())?t[0].trim():"Unknown"),r}catch(e){return console.error("["+n+"] error fetching file:",e),null}}r().then(e=>{e&&e!==i&&(console.log("["+n+"] There is a new version of this plugin available"),function(e,n,t,o){if("/setup"===location.pathname){let i=document.getElementById("plugin-settings");if(i){let r=i.textContent.trim(),l=`<a href="${o}" target="_blank">[${t}] Update available: ${e} --> ${n}</a><br>`;i.innerHTML="No plugin settings are available."===r?l:i.innerHTML+" "+l}let a=document.querySelector(".wrapper-outer #navigation .sidenav-content .fa-puzzle-piece")||document.querySelector(".wrapper-outer .sidenav-content")||document.querySelector(".sidenav-content"),d=document.createElement("span");d.style.cssText="display:block;width:12px;height:12px;border-radius:50%;background:#FE0830;margin-left:82px;margin-top:-12px",a.appendChild(d)}}(i,e,n,t))})}CHECK_FOR_UPDATES&&checkUpdate(pluginSetupOnlyNotify,pluginName,pluginHomepageUrl,pluginUpdateUrl);
    }
})();
