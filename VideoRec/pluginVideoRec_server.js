/*
    VideoRec v1.2.0 by AAD
    ----------------------
    https://github.com/AmateurAudioDude/FM-DX-Webserver-Plugin-Video-Recorder

    //// Server-side code ////

    On Linux only the main frontend file is linked into /js/plugins, so the encoder scripts that pluginVideoRec.js loads
    when a video is made are served from here.
*/

'use strict';

const path = require('path');

const rootDir = path.dirname(require.main.filename);
const endpointsRouter = require(rootDir + '/server/endpoints');

const SCRIPTS = new Set(['videorec-video.js', 'videorec-h264.js']);

endpointsRouter.get('/videorec/:file', (req, res) => {
    const file = req.params.file;
    if (!SCRIPTS.has(file)) {
        res.status(404).end();
        return;
    }
    res.type('application/javascript');
    res.sendFile(path.join(__dirname, file));
});
