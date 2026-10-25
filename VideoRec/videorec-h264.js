/*
    VideoRec
    --------
*/

(function () {
    'use strict';

    // H.264 Baseline encoder for browsers without WebCodecs (plain HTTP pages). Changed 16x16 macroblocks are
    // intra coded (Intra_16x16 prediction, 4x4 transform, CAVLC), unchanged ones are skipped (copied from the
    // previous frame). Full pictures come at the start and every KEYFRAME_INTERVAL_MS of video time.
    // Quantizer 0-51: lower is better quality and bigger files. null stores changed macroblocks uncompressed.
    const QP = 18;
    // Full picture interval in milliseconds of video time, Infinity for only the first frame.
    const KEYFRAME_INTERVAL_MS = 4000;
    const LEVEL_IDC = 40;
    const PCM_BITS = 384 * 8 + 16;

    const ZIGZAG = [0, 1, 4, 8, 5, 2, 3, 6, 9, 12, 13, 10, 7, 11, 14, 15];
    // luma4x4BlkIdx -> 4x4 block column/row inside the macroblock
    const BLOCK_X = [0, 1, 0, 1, 2, 3, 2, 3, 0, 1, 0, 1, 2, 3, 2, 3];
    const BLOCK_Y = [0, 0, 1, 1, 0, 0, 1, 1, 2, 2, 3, 3, 2, 2, 3, 3];
    // Raster coefficient index -> 0 both coordinates even, 2 both odd, 1 otherwise
    const POSITION_CLASS = Array.from({ length: 16 }, (_, i) => {
        const oddX = i & 1;
        const oddY = (i >> 2) & 1;
        return oddX && oddY ? 2 : (oddX || oddY ? 1 : 0);
    });
    const QUANT_SCALE = [[13107, 8066, 5243], [11916, 7490, 4660], [10082, 6554, 4194], [9362, 5825, 3647], [8192, 5243, 3355], [7282, 4559, 2893]];
    const DEQUANT_SCALE = [[10, 13, 16], [11, 14, 18], [13, 16, 20], [14, 18, 23], [16, 20, 25], [18, 23, 29]];
    const CHROMA_QP = [...Array(30).keys(), 29, 30, 31, 32, 32, 33, 34, 34, 35, 35, 36, 36, 37, 37, 37, 38, 38, 38, 39, 39, 39, 39];

    // CAVLC tables (H.264 tables 9-5, 9-7, 9-8, 9-9, 9-10), coeff_token indexed by 4 * TotalCoeff + TrailingOnes
    const COEFF_TOKEN_LEN = [
        [1, 0, 0, 0, 6, 2, 0, 0, 8, 6, 3, 0, 9, 8, 7, 5, 10, 9, 8, 6, 11, 10, 9, 7, 13, 11, 10, 8, 13, 13, 11, 9, 13, 13, 13, 10,
            14, 14, 13, 11, 14, 14, 14, 13, 15, 15, 14, 14, 15, 15, 15, 14, 16, 15, 15, 15, 16, 16, 16, 15, 16, 16, 16, 16, 16, 16, 16, 16],
        [2, 0, 0, 0, 6, 2, 0, 0, 6, 5, 3, 0, 7, 6, 6, 4, 8, 6, 6, 4, 8, 7, 7, 5, 9, 8, 8, 6, 11, 9, 9, 6, 11, 11, 11, 7,
            12, 11, 11, 9, 12, 12, 12, 11, 12, 12, 12, 11, 13, 13, 13, 12, 13, 13, 13, 13, 13, 14, 13, 13, 14, 14, 14, 13, 14, 14, 14, 14],
        [4, 0, 0, 0, 6, 4, 0, 0, 6, 5, 4, 0, 6, 5, 5, 4, 7, 5, 5, 4, 7, 5, 5, 4, 7, 6, 6, 4, 7, 6, 6, 4, 8, 7, 7, 5,
            8, 8, 7, 6, 9, 8, 8, 7, 9, 9, 8, 8, 9, 9, 9, 8, 10, 9, 9, 9, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10]
    ];
    const COEFF_TOKEN_BITS = [
        [1, 0, 0, 0, 5, 1, 0, 0, 7, 4, 1, 0, 7, 6, 5, 3, 7, 6, 5, 3, 7, 6, 5, 4, 15, 6, 5, 4, 11, 14, 5, 4, 8, 10, 13, 4,
            15, 14, 9, 4, 11, 10, 13, 12, 15, 14, 9, 12, 11, 10, 13, 8, 15, 1, 9, 12, 11, 14, 13, 8, 7, 10, 9, 12, 4, 6, 5, 8],
        [3, 0, 0, 0, 11, 2, 0, 0, 7, 7, 3, 0, 7, 10, 9, 5, 7, 6, 5, 4, 4, 6, 5, 6, 7, 6, 5, 8, 15, 6, 5, 4, 11, 14, 13, 4,
            15, 10, 9, 4, 11, 14, 13, 12, 8, 10, 9, 8, 15, 14, 13, 12, 11, 10, 9, 12, 7, 11, 6, 8, 9, 8, 10, 1, 7, 6, 5, 4],
        [15, 0, 0, 0, 15, 14, 0, 0, 11, 15, 13, 0, 8, 12, 14, 12, 15, 10, 11, 11, 11, 8, 9, 10, 9, 14, 13, 9, 8, 10, 9, 8, 15, 14, 13, 13,
            11, 14, 10, 12, 15, 10, 13, 12, 11, 14, 9, 12, 8, 10, 13, 8, 13, 7, 9, 12, 9, 12, 11, 10, 5, 8, 7, 6, 1, 4, 3, 2]
    ];
    const CHROMA_DC_TOKEN_LEN = [2, 0, 0, 0, 6, 1, 0, 0, 6, 6, 3, 0, 6, 7, 7, 6, 6, 8, 8, 7];
    const CHROMA_DC_TOKEN_BITS = [1, 0, 0, 0, 7, 1, 0, 0, 4, 6, 1, 0, 3, 3, 2, 5, 2, 3, 2, 0];
    // total_zeros indexed by [TotalCoeff - 1][total_zeros]
    const TOTAL_ZEROS_LEN = [
        [1, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 9], [3, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 6, 6, 6, 6],
        [4, 3, 3, 3, 4, 4, 3, 3, 4, 5, 5, 6, 5, 6], [5, 3, 4, 4, 3, 3, 3, 4, 3, 4, 5, 5, 5], [4, 4, 4, 3, 3, 3, 3, 3, 4, 5, 4, 5],
        [6, 5, 3, 3, 3, 3, 3, 3, 4, 3, 6], [6, 5, 3, 3, 3, 2, 3, 4, 3, 6], [6, 4, 5, 3, 2, 2, 3, 3, 6], [6, 6, 4, 2, 2, 3, 2, 5],
        [5, 5, 3, 2, 2, 2, 4], [4, 4, 3, 3, 1, 3], [4, 4, 2, 1, 3], [3, 3, 1, 2], [2, 2, 1], [1, 1]
    ];
    const TOTAL_ZEROS_BITS = [
        [1, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 1], [7, 6, 5, 4, 3, 5, 4, 3, 2, 3, 2, 3, 2, 1, 0],
        [5, 7, 6, 5, 4, 3, 4, 3, 2, 3, 2, 1, 1, 0], [3, 7, 5, 4, 6, 5, 4, 3, 3, 2, 2, 1, 0], [5, 4, 3, 7, 6, 5, 4, 3, 2, 1, 1, 0],
        [1, 1, 7, 6, 5, 4, 3, 2, 1, 1, 0], [1, 1, 5, 4, 3, 3, 2, 1, 1, 0], [1, 1, 1, 3, 3, 2, 2, 1, 0], [1, 0, 1, 3, 2, 1, 1, 1],
        [1, 0, 1, 3, 2, 1, 1], [0, 1, 1, 2, 1, 3], [0, 1, 1, 1, 1], [0, 1, 1, 1], [0, 1, 1], [0, 1]
    ];
    const CHROMA_DC_TOTAL_ZEROS_LEN = [[1, 2, 3, 3], [1, 2, 2], [1, 1]];
    const CHROMA_DC_TOTAL_ZEROS_BITS = [[1, 1, 1, 0], [1, 1, 0], [1, 0]];
    // run_before indexed by [min(zerosLeft, 7) - 1][run_before]
    const RUN_BEFORE_LEN = [
        [1, 1], [1, 2, 2], [2, 2, 2, 2], [2, 2, 2, 3, 3], [2, 2, 3, 3, 3, 3], [2, 3, 3, 3, 3, 3, 3],
        [3, 3, 3, 3, 3, 3, 3, 4, 5, 6, 7, 8, 9, 10, 11]
    ];
    const RUN_BEFORE_BITS = [
        [1, 0], [1, 1, 0], [3, 2, 1, 0], [3, 2, 1, 1, 0], [3, 2, 3, 2, 1, 0], [3, 0, 1, 3, 2, 5, 4],
        [7, 6, 5, 4, 3, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1]
    ];

    class BitWriter {
        constructor(capacity = 4096) {
            this.buffer = new Uint8Array(capacity);
            this.length = 0;
            this.current = 0;
            this.count = 0;
        }

        get bitLength() {
            return this.length * 8 + this.count;
        }

        reserve(extra) {
            if (this.length + extra <= this.buffer.length) return;
            const next = new Uint8Array(Math.max(this.buffer.length * 2, this.length + extra));
            next.set(this.buffer.subarray(0, this.length));
            this.buffer = next;
        }

        bit(value) {
            this.current = (this.current << 1) | (value & 1);
            if (++this.count === 8) {
                this.reserve(1);
                this.buffer[this.length++] = this.current;
                this.current = 0;
                this.count = 0;
            }
        }

        bits(value, count) {
            for (let i = count - 1; i >= 0; i--) this.bit((value >>> i) & 1);
        }

        ue(value) {
            const code = value + 1;
            const length = 32 - Math.clz32(code);
            this.bits(0, length - 1);
            this.bits(code, length);
        }

        se(value) {
            this.ue(value > 0 ? value * 2 - 1 : -value * 2);
        }

        align() {
            while (this.count) this.bit(0);
        }

        bytes(data) {
            this.reserve(data.length);
            this.buffer.set(data, this.length);
            this.length += data.length;
        }

        append(other) {
            if (this.count) {
                for (let i = 0; i < other.length; i++) this.bits(other.buffer[i], 8);
            } else {
                this.bytes(other.buffer.subarray(0, other.length));
            }
            this.bits(other.current, other.count);
        }

        trailing() {
            this.bit(1);
            this.align();
        }
    }

    // NAL unit: header byte, then the payload with emulation-prevention bytes inserted.
    function nalUnit(header, payload) {
        const out = new Uint8Array(payload.length + (payload.length >> 1) + 2);
        out[0] = header;
        let length = 1;
        let zeros = 0;
        for (let i = 0; i < payload.length; i++) {
            const byte = payload[i];
            if (zeros >= 2 && byte <= 3) {
                out[length++] = 3;
                zeros = 0;
            }
            out[length++] = byte;
            zeros = byte === 0 ? zeros + 1 : 0;
        }
        return out.subarray(0, length);
    }

    function lengthPrefixed(nal) {
        const out = new Uint8Array(nal.length + 4);
        new DataView(out.buffer).setUint32(0, nal.length);
        out.set(nal, 4);
        return out;
    }

    function buildSps(width, height) {
        const mbCols = Math.ceil(width / 16);
        const mbRows = Math.ceil(height / 16);
        const cropRight = (mbCols * 16 - width) / 2;
        const cropBottom = (mbRows * 16 - height) / 2;
        const w = new BitWriter(64);
        w.bits(66, 8);
        w.bits(0xC0, 8);
        w.bits(LEVEL_IDC, 8);
        w.ue(0);
        w.ue(12);
        w.ue(2);
        w.ue(1);
        w.bit(0);
        w.ue(mbCols - 1);
        w.ue(mbRows - 1);
        w.bit(1);
        w.bit(1);
        if (cropRight || cropBottom) {
            w.bit(1);
            w.ue(0);
            w.ue(cropRight);
            w.ue(0);
            w.ue(cropBottom);
        } else {
            w.bit(0);
        }
        w.bit(1);
        w.bit(0);
        w.bit(0);
        w.bit(1);
        w.bits(5, 3);
        w.bit(0);
        w.bit(1);
        w.bits(1, 8);
        w.bits(1, 8);
        w.bits(1, 8);
        w.bits(0, 6);
        w.trailing();
        return nalUnit(0x67, w.buffer.subarray(0, w.length));
    }

    function buildPps() {
        const w = new BitWriter(16);
        w.ue(0);
        w.ue(0);
        w.bit(0);
        w.bit(0);
        w.ue(0);
        w.ue(0);
        w.ue(0);
        w.bit(0);
        w.bits(0, 2);
        w.se(0);
        w.se(0);
        w.se(0);
        w.bit(1);
        w.bit(0);
        w.bit(0);
        w.trailing();
        return nalUnit(0x68, w.buffer.subarray(0, w.length));
    }

    // One macroblock as 256 luma + 64 Cb + 64 Cr samples, BT.709 limited range, outside the picture is black.
    function fillSourceMacroblock(out, rgba, width, height, mx, my) {
        const x0 = mx * 16;
        const y0 = my * 16;
        for (let y = 0; y < 16; y++) {
            const py = y0 + y;
            for (let x = 0; x < 16; x++) {
                const px = x0 + x;
                let luma = 16;
                if (px < width && py < height) {
                    const i = (py * width + px) * 4;
                    luma = Math.round(16 + 0.18259 * rgba[i] + 0.61423 * rgba[i + 1] + 0.06201 * rgba[i + 2]);
                }
                out[y * 16 + x] = luma;
            }
        }
        for (let cy = 0; cy < 8; cy++) {
            for (let cx = 0; cx < 8; cx++) {
                let r = 0;
                let g = 0;
                let b = 0;
                for (let dy = 0; dy < 2; dy++) {
                    const py = y0 + cy * 2 + dy;
                    for (let dx = 0; dx < 2; dx++) {
                        const px = x0 + cx * 2 + dx;
                        if (px >= width || py >= height) continue;
                        const i = (py * width + px) * 4;
                        r += rgba[i];
                        g += rgba[i + 1];
                        b += rgba[i + 2];
                    }
                }
                r /= 4;
                g /= 4;
                b /= 4;
                out[256 + cy * 8 + cx] = Math.round(128 - 0.10067 * r - 0.33855 * g + 0.43922 * b);
                out[320 + cy * 8 + cx] = Math.round(128 + 0.43922 * r - 0.39897 * g - 0.04023 * b);
            }
        }
    }

    function macroblockChanged(pixels, previous, width, height, mx, my) {
        const yEnd = Math.min(height, my * 16 + 16);
        const xStart = mx * 16;
        const xEnd = Math.min(width, xStart + 16);
        for (let y = my * 16; y < yEnd; y++) {
            const row = y * width;
            for (let x = xStart; x < xEnd; x++) {
                if (pixels[row + x] !== previous[row + x]) return true;
            }
        }
        return false;
    }

    function clip(value) {
        return value < 0 ? 0 : (value > 255 ? 255 : value);
    }

    // Encoder-side forward core transform, only the inverse below is defined by the standard.
    function forwardTransform(block) {
        for (let y = 0; y < 16; y += 4) {
            const s03 = block[y] + block[y + 3];
            const d03 = block[y] - block[y + 3];
            const s12 = block[y + 1] + block[y + 2];
            const d12 = block[y + 1] - block[y + 2];
            block[y] = s03 + s12;
            block[y + 1] = 2 * d03 + d12;
            block[y + 2] = s03 - s12;
            block[y + 3] = d03 - 2 * d12;
        }
        for (let x = 0; x < 4; x++) {
            const s03 = block[x] + block[x + 12];
            const d03 = block[x] - block[x + 12];
            const s12 = block[x + 4] + block[x + 8];
            const d12 = block[x + 4] - block[x + 8];
            block[x] = s03 + s12;
            block[x + 4] = 2 * d03 + d12;
            block[x + 8] = s03 - s12;
            block[x + 12] = d03 - 2 * d12;
        }
    }

    // Decoder's inverse transform (rows, then columns), leaving the residual in place.
    function inverseTransform(block) {
        for (let y = 0; y < 16; y += 4) {
            const e0 = block[y] + block[y + 2];
            const e1 = block[y] - block[y + 2];
            const e2 = (block[y + 1] >> 1) - block[y + 3];
            const e3 = block[y + 1] + (block[y + 3] >> 1);
            block[y] = e0 + e3;
            block[y + 1] = e1 + e2;
            block[y + 2] = e1 - e2;
            block[y + 3] = e0 - e3;
        }
        for (let x = 0; x < 4; x++) {
            const g0 = block[x] + block[x + 8];
            const g1 = block[x] - block[x + 8];
            const g2 = (block[x + 4] >> 1) - block[x + 12];
            const g3 = block[x + 4] + (block[x + 12] >> 1);
            block[x] = (g0 + g3 + 32) >> 6;
            block[x + 4] = (g1 + g2 + 32) >> 6;
            block[x + 8] = (g1 - g2 + 32) >> 6;
            block[x + 12] = (g0 - g3 + 32) >> 6;
        }
    }

    function hadamard4(block) {
        for (let y = 0; y < 16; y += 4) {
            const a = block[y];
            const b = block[y + 1];
            const c = block[y + 2];
            const d = block[y + 3];
            block[y] = a + b + c + d;
            block[y + 1] = a + b - c - d;
            block[y + 2] = a - b - c + d;
            block[y + 3] = a - b + c - d;
        }
        for (let x = 0; x < 4; x++) {
            const a = block[x];
            const b = block[x + 4];
            const c = block[x + 8];
            const d = block[x + 12];
            block[x] = a + b + c + d;
            block[x + 4] = a + b - c - d;
            block[x + 8] = a - b - c + d;
            block[x + 12] = a - b + c - d;
        }
    }

    function hadamard2(c) {
        return [c[0] + c[1] + c[2] + c[3], c[0] - c[1] + c[2] - c[3], c[0] + c[1] - c[2] - c[3], c[0] - c[1] - c[2] + c[3]];
    }

    function quantize(value, scale, qbits, offset) {
        const magnitude = Math.floor((Math.abs(value) * scale + offset) / 2 ** qbits);
        return value < 0 ? -magnitude : magnitude;
    }

    function dequantize(level, qp, position) {
        if (!level) return 0;
        const scale = 16 * DEQUANT_SCALE[qp % 6][POSITION_CLASS[position]];
        const shift = Math.floor(qp / 6);
        return qp >= 24 ? (level * scale) << (shift - 4) : (level * scale + (1 << (3 - shift))) >> (4 - shift);
    }

    function countNonzero(levels) {
        let count = 0;
        for (let i = 0; i < levels.length; i++) if (levels[i]) count++;
        return count;
    }

    function sumOfAbsoluteDifferences(source, offset, prediction) {
        let sum = 0;
        for (let i = 0; i < prediction.length; i++) sum += Math.abs(source[offset + i] - prediction[i]);
        return sum;
    }

    // Intra_16x16 luma prediction: 0 vertical, 1 horizontal, 2 DC, 3 plane.
    function predictLuma(n, mode, out) {
        if (mode === 0) {
            for (let i = 0; i < 256; i++) out[i] = n.top[i & 15];
        } else if (mode === 1) {
            for (let i = 0; i < 256; i++) out[i] = n.left[i >> 4];
        } else if (mode === 2) {
            let sumTop = 0;
            let sumLeft = 0;
            for (let i = 0; i < 16; i++) {
                sumTop += n.top[i];
                sumLeft += n.left[i];
            }
            const dc = n.hasTop && n.hasLeft ? (sumTop + sumLeft + 16) >> 5
                : n.hasLeft ? (sumLeft + 8) >> 4
                    : n.hasTop ? (sumTop + 8) >> 4 : 128;
            out.fill(dc);
        } else {
            let h = 0;
            let v = 0;
            for (let i = 0; i < 8; i++) {
                h += (i + 1) * (n.top[8 + i] - (i < 7 ? n.top[6 - i] : n.corner));
                v += (i + 1) * (n.left[8 + i] - (i < 7 ? n.left[6 - i] : n.corner));
            }
            const a = 16 * (n.left[15] + n.top[15]);
            const b = (5 * h + 32) >> 6;
            const c = (5 * v + 32) >> 6;
            for (let y = 0; y < 16; y++) {
                for (let x = 0; x < 16; x++) out[y * 16 + x] = clip((a + b * (x - 7) + c * (y - 7) + 16) >> 5);
            }
        }
    }

    // Chroma prediction: 0 DC (per 4x4 block), 1 horizontal, 2 vertical, 3 plane.
    function predictChroma(n, mode, out) {
        if (mode === 0) {
            for (let block = 0; block < 4; block++) {
                const bx = block & 1;
                const by = block >> 1;
                let sumTop = 0;
                let sumLeft = 0;
                for (let i = 0; i < 4; i++) {
                    sumTop += n.top[bx * 4 + i];
                    sumLeft += n.left[by * 4 + i];
                }
                let dc;
                if (bx === by) {
                    dc = n.hasTop && n.hasLeft ? (sumTop + sumLeft + 4) >> 3
                        : n.hasLeft ? (sumLeft + 2) >> 2
                            : n.hasTop ? (sumTop + 2) >> 2 : 128;
                } else if (bx === 1) {
                    dc = n.hasTop ? (sumTop + 2) >> 2 : n.hasLeft ? (sumLeft + 2) >> 2 : 128;
                } else {
                    dc = n.hasLeft ? (sumLeft + 2) >> 2 : n.hasTop ? (sumTop + 2) >> 2 : 128;
                }
                for (let y = 0; y < 4; y++) {
                    for (let x = 0; x < 4; x++) out[(by * 4 + y) * 8 + bx * 4 + x] = dc;
                }
            }
        } else if (mode === 1) {
            for (let i = 0; i < 64; i++) out[i] = n.left[i >> 3];
        } else if (mode === 2) {
            for (let i = 0; i < 64; i++) out[i] = n.top[i & 7];
        } else {
            let h = 0;
            let v = 0;
            for (let i = 0; i < 4; i++) {
                h += (i + 1) * (n.top[4 + i] - (i < 3 ? n.top[2 - i] : n.corner));
                v += (i + 1) * (n.left[4 + i] - (i < 3 ? n.left[2 - i] : n.corner));
            }
            const a = 16 * (n.left[7] + n.top[7]);
            const b = (34 * h + 32) >> 6;
            const c = (34 * v + 32) >> 6;
            for (let y = 0; y < 8; y++) {
                for (let x = 0; x < 8; x++) out[y * 8 + x] = clip((a + b * (x - 3) + c * (y - 3) + 16) >> 5);
            }
        }
    }

    function writeLevel(w, levelCode, suffixLength) {
        let prefix;
        let suffix = 0;
        let suffixSize = 0;
        if (suffixLength === 0) {
            if (levelCode < 14) {
                prefix = levelCode;
            } else if (levelCode < 30) {
                prefix = 14;
                suffix = levelCode - 14;
                suffixSize = 4;
            } else {
                prefix = 15;
                suffix = levelCode - 30;
                suffixSize = 12;
            }
        } else if (levelCode < (15 << suffixLength)) {
            prefix = levelCode >> suffixLength;
            suffix = levelCode & ((1 << suffixLength) - 1);
            suffixSize = suffixLength;
        } else {
            prefix = 15;
            suffix = levelCode - (15 << suffixLength);
            suffixSize = 12;
        }
        if (suffix >= 4096) return false;
        w.bits(0, prefix);
        w.bit(1);
        w.bits(suffix, suffixSize);
        return true;
    }

    // residual_block_cavlc() with levels in scan order. Returns false if a level is too large for Baseline.
    function writeResidualBlock(w, levels, maxNumCoeff, nC) {
        const positions = [];
        for (let i = 0; i < maxNumCoeff; i++) if (levels[i]) positions.push(i);
        const total = positions.length;
        let trailingOnes = 0;
        for (let k = total - 1; k >= 0 && trailingOnes < 3 && Math.abs(levels[positions[k]]) === 1; k--) trailingOnes++;

        const token = 4 * total + trailingOnes;
        if (nC === -1) {
            w.bits(CHROMA_DC_TOKEN_BITS[token], CHROMA_DC_TOKEN_LEN[token]);
        } else if (nC >= 8) {
            w.bits(total ? ((total - 1) << 2) | trailingOnes : 3, 6);
        } else {
            const table = nC < 2 ? 0 : (nC < 4 ? 1 : 2);
            w.bits(COEFF_TOKEN_BITS[table][token], COEFF_TOKEN_LEN[table][token]);
        }
        if (!total) return true;

        for (let k = 0; k < trailingOnes; k++) w.bit(levels[positions[total - 1 - k]] < 0 ? 1 : 0);
        let suffixLength = total > 10 && trailingOnes < 3 ? 1 : 0;
        for (let k = trailingOnes; k < total; k++) {
            const level = levels[positions[total - 1 - k]];
            let levelCode = level > 0 ? 2 * level - 2 : -2 * level - 1;
            if (k === trailingOnes && trailingOnes < 3) levelCode -= 2;
            if (!writeLevel(w, levelCode, suffixLength)) return false;
            if (suffixLength === 0) suffixLength = 1;
            if (Math.abs(level) > (3 << (suffixLength - 1)) && suffixLength < 6) suffixLength++;
        }

        if (total < maxNumCoeff) {
            const totalZeros = positions[total - 1] + 1 - total;
            if (maxNumCoeff === 4) {
                w.bits(CHROMA_DC_TOTAL_ZEROS_BITS[total - 1][totalZeros], CHROMA_DC_TOTAL_ZEROS_LEN[total - 1][totalZeros]);
            } else {
                w.bits(TOTAL_ZEROS_BITS[total - 1][totalZeros], TOTAL_ZEROS_LEN[total - 1][totalZeros]);
            }
            let zerosLeft = totalZeros;
            for (let k = total - 1; k > 0 && zerosLeft > 0; k--) {
                const run = positions[k] - positions[k - 1] - 1;
                const table = Math.min(zerosLeft, 7) - 1;
                w.bits(RUN_BEFORE_BITS[table][run], RUN_BEFORE_LEN[table][run]);
                zerosLeft -= run;
            }
        }
        return true;
    }

    // Returns { description, encodeFrame(rgba, timeMs) -> { data, key } }, options.qp and options.keyframeIntervalMs
    // override QP and KEYFRAME_INTERVAL_MS.
    function createEncoder(width, height, options = {}) {
        if (width % 2 || height % 2) throw new Error('Video width and height must be even.');
        const qp = options.qp === undefined ? QP : options.qp;
        const keyframeIntervalMs = options.keyframeIntervalMs === undefined ? KEYFRAME_INTERVAL_MS : options.keyframeIntervalMs;
        if (qp !== null && !(Number.isInteger(qp) && qp >= 0 && qp <= 51)) throw new Error('QP must be 0-51 or null.');
        const mbCols = Math.ceil(width / 16);
        const mbRows = Math.ceil(height / 16);
        const lumaStride = mbCols * 16;
        const chromaStride = mbCols * 8;
        const recLuma = new Uint8Array(lumaStride * mbRows * 16);
        const recChroma = [new Uint8Array(chromaStride * mbRows * 8), new Uint8Array(chromaStride * mbRows * 8)];
        // TotalCoeff of each 4x4 block in the current picture, the CAVLC nC context
        const lumaCountStride = mbCols * 4;
        const chromaCountStride = mbCols * 2;
        const lumaCounts = new Uint8Array(lumaCountStride * mbRows * 4);
        const chromaCounts = [new Uint8Array(chromaCountStride * mbRows * 2), new Uint8Array(chromaCountStride * mbRows * 2)];
        const source = new Uint8Array(384);
        const sps = buildSps(width, height);
        const pps = buildPps();
        let previous = null;
        let frameNum = 0;
        let idrCount = 0;
        let lastIdrAt = -Infinity;

        function neighbours(samples, stride, size, mx, my) {
            const x0 = mx * size;
            const y0 = my * size;
            const n = { hasTop: my > 0, hasLeft: mx > 0, top: new Int32Array(size), left: new Int32Array(size), corner: 0 };
            if (n.hasTop) for (let i = 0; i < size; i++) n.top[i] = samples[(y0 - 1) * stride + x0 + i];
            if (n.hasLeft) for (let i = 0; i < size; i++) n.left[i] = samples[(y0 + i) * stride + x0 - 1];
            if (n.hasTop && n.hasLeft) n.corner = samples[(y0 - 1) * stride + x0 - 1];
            return n;
        }

        function bestPrediction(predict, n, modes, size, sources) {
            let best = null;
            for (const mode of modes) {
                const predictions = sources.map(({ neighbour }) => {
                    const out = new Int32Array(size * size);
                    predict(neighbour || n, mode, out);
                    return out;
                });
                let cost = 0;
                sources.forEach(({ offset }, i) => { cost += sumOfAbsoluteDifferences(source, offset, predictions[i]); });
                if (!best || cost < best.cost) best = { mode, cost, predictions };
            }
            return best;
        }

        function codeLuma(mx, my) {
            const n = neighbours(recLuma, lumaStride, 16, mx, my);
            const modes = [2];
            if (n.hasTop) modes.push(0);
            if (n.hasLeft) modes.push(1);
            if (n.hasTop && n.hasLeft) modes.push(3);
            const { mode, predictions: [prediction] } = bestPrediction(predictLuma, n, modes, 16, [{ offset: 0 }]);

            const qbits = 15 + Math.floor(qp / 6);
            const offset = Math.floor(2 ** qbits / 3);
            const scale = QUANT_SCALE[qp % 6];
            const blocks = [];
            const dc = new Int32Array(16);
            for (let blk = 0; blk < 16; blk++) {
                const block = new Int32Array(16);
                const x0 = BLOCK_X[blk] * 4;
                const y0 = BLOCK_Y[blk] * 4;
                for (let y = 0; y < 4; y++) {
                    for (let x = 0; x < 4; x++) {
                        const i = (y0 + y) * 16 + x0 + x;
                        block[y * 4 + x] = source[i] - prediction[i];
                    }
                }
                forwardTransform(block);
                dc[BLOCK_Y[blk] * 4 + BLOCK_X[blk]] = block[0];
                blocks.push(block);
            }
            hadamard4(dc);
            const dcLevels = new Int32Array(16);
            for (let i = 0; i < 16; i++) dcLevels[i] = quantize(dc[i] >> 1, scale[0], qbits + 1, 2 * offset);
            const dcScan = ZIGZAG.map(position => dcLevels[position]);
            let cbp = 0;
            const acScan = blocks.map(block => {
                const levels = new Int32Array(15);
                for (let k = 1; k < 16; k++) {
                    const position = ZIGZAG[k];
                    levels[k - 1] = quantize(block[position], scale[POSITION_CLASS[position]], qbits, offset);
                    if (levels[k - 1]) cbp = 15;
                }
                return levels;
            });

            const f = Int32Array.from(dcLevels);
            hadamard4(f);
            const dcScale = 16 * DEQUANT_SCALE[qp % 6][0];
            const shift = Math.floor(qp / 6);
            const recon = new Uint8Array(256);
            for (let blk = 0; blk < 16; blk++) {
                const raster = BLOCK_Y[blk] * 4 + BLOCK_X[blk];
                const coefficients = new Int32Array(16);
                coefficients[0] = qp >= 36 ? (f[raster] * dcScale) << (shift - 6) : (f[raster] * dcScale + (1 << (5 - shift))) >> (6 - shift);
                for (let k = 1; k < 16; k++) coefficients[ZIGZAG[k]] = dequantize(acScan[blk][k - 1], qp, ZIGZAG[k]);
                inverseTransform(coefficients);
                const x0 = BLOCK_X[blk] * 4;
                const y0 = BLOCK_Y[blk] * 4;
                for (let y = 0; y < 4; y++) {
                    for (let x = 0; x < 4; x++) {
                        const i = (y0 + y) * 16 + x0 + x;
                        recon[i] = clip(prediction[i] + coefficients[y * 4 + x]);
                    }
                }
            }
            return { mode, dcScan, acScan, cbp, recon };
        }

        function codeChroma(mx, my) {
            const planes = [0, 1].map(plane => neighbours(recChroma[plane], chromaStride, 8, mx, my));
            const modes = [0];
            if (planes[0].hasLeft) modes.push(1);
            if (planes[0].hasTop) modes.push(2);
            if (planes[0].hasTop && planes[0].hasLeft) modes.push(3);
            const { mode, predictions } = bestPrediction(predictChroma, planes[0], modes, 8,
                [{ offset: 256, neighbour: planes[0] }, { offset: 320, neighbour: planes[1] }]);

            const qpc = CHROMA_QP[qp];
            const qbits = 15 + Math.floor(qpc / 6);
            const offset = Math.floor(2 ** qbits / 3);
            const scale = QUANT_SCALE[qpc % 6];
            const dcScale = 16 * DEQUANT_SCALE[qpc % 6][0];
            const shift = Math.floor(qpc / 6);
            let cbp = 0;
            const coded = predictions.map((prediction, plane) => {
                const base = 256 + plane * 64;
                const blocks = [];
                for (let blk = 0; blk < 4; blk++) {
                    const block = new Int32Array(16);
                    const x0 = (blk & 1) * 4;
                    const y0 = (blk >> 1) * 4;
                    for (let y = 0; y < 4; y++) {
                        for (let x = 0; x < 4; x++) {
                            const i = (y0 + y) * 8 + x0 + x;
                            block[y * 4 + x] = source[base + i] - prediction[i];
                        }
                    }
                    forwardTransform(block);
                    blocks.push(block);
                }
                const dcLevels = hadamard2(blocks.map(block => block[0])).map(value => quantize(value, scale[0], qbits + 1, 2 * offset));
                if (dcLevels.some(Boolean)) cbp = Math.max(cbp, 1);
                const acScan = blocks.map(block => {
                    const levels = new Int32Array(15);
                    for (let k = 1; k < 16; k++) {
                        const position = ZIGZAG[k];
                        levels[k - 1] = quantize(block[position], scale[POSITION_CLASS[position]], qbits, offset);
                        if (levels[k - 1]) cbp = 2;
                    }
                    return levels;
                });
                return { prediction, dcLevels, acScan };
            });

            const recon = coded.map(({ prediction, dcLevels, acScan }) => {
                const dcValues = hadamard2(dcLevels).map(value => ((value * dcScale) << shift) >> 5);
                const out = new Uint8Array(64);
                for (let blk = 0; blk < 4; blk++) {
                    const coefficients = new Int32Array(16);
                    coefficients[0] = dcValues[blk];
                    for (let k = 1; k < 16; k++) coefficients[ZIGZAG[k]] = dequantize(acScan[blk][k - 1], qpc, ZIGZAG[k]);
                    inverseTransform(coefficients);
                    const x0 = (blk & 1) * 4;
                    const y0 = (blk >> 1) * 4;
                    for (let y = 0; y < 4; y++) {
                        for (let x = 0; x < 4; x++) {
                            const i = (y0 + y) * 8 + x0 + x;
                            out[i] = clip(prediction[i] + coefficients[y * 4 + x]);
                        }
                    }
                }
                return out;
            });
            return { mode, cbp, dcLevels: coded.map(plane => plane.dcLevels), acScan: coded.map(plane => plane.acScan), recon };
        }

        function setCounts(mx, my, luma, chroma) {
            for (let blk = 0; blk < 16; blk++) {
                const count = luma === 16 ? 16 : (luma.cbp ? countNonzero(luma.acScan[blk]) : 0);
                lumaCounts[(my * 4 + BLOCK_Y[blk]) * lumaCountStride + mx * 4 + BLOCK_X[blk]] = count;
            }
            for (let plane = 0; plane < 2; plane++) {
                for (let blk = 0; blk < 4; blk++) {
                    const count = chroma === 16 ? 16 : (chroma.cbp === 2 ? countNonzero(chroma.acScan[plane][blk]) : 0);
                    chromaCounts[plane][(my * 2 + (blk >> 1)) * chromaCountStride + mx * 2 + (blk & 1)] = count;
                }
            }
        }

        function predictedCount(counts, stride, gx, gy) {
            const hasLeft = gx > 0;
            const hasTop = gy > 0;
            const left = hasLeft ? counts[gy * stride + gx - 1] : 0;
            const top = hasTop ? counts[(gy - 1) * stride + gx] : 0;
            return hasLeft && hasTop ? (left + top + 1) >> 1 : (hasLeft ? left : top);
        }

        function writeIntraMacroblock(w, mx, my, luma, chroma, isIdr) {
            w.ue((isIdr ? 0 : 5) + 1 + luma.mode + 4 * chroma.cbp + (luma.cbp ? 12 : 0));
            w.ue(chroma.mode);
            w.se(0);
            if (!writeResidualBlock(w, luma.dcScan, 16, predictedCount(lumaCounts, lumaCountStride, mx * 4, my * 4))) return false;
            if (luma.cbp) {
                for (let blk = 0; blk < 16; blk++) {
                    const nC = predictedCount(lumaCounts, lumaCountStride, mx * 4 + BLOCK_X[blk], my * 4 + BLOCK_Y[blk]);
                    if (!writeResidualBlock(w, luma.acScan[blk], 15, nC)) return false;
                }
            }
            if (chroma.cbp) {
                for (let plane = 0; plane < 2; plane++) {
                    if (!writeResidualBlock(w, chroma.dcLevels[plane], 4, -1)) return false;
                }
            }
            if (chroma.cbp === 2) {
                for (let plane = 0; plane < 2; plane++) {
                    for (let blk = 0; blk < 4; blk++) {
                        const nC = predictedCount(chromaCounts[plane], chromaCountStride, mx * 2 + (blk & 1), my * 2 + (blk >> 1));
                        if (!writeResidualBlock(w, chroma.acScan[plane][blk], 15, nC)) return false;
                    }
                }
            }
            return true;
        }

        function storeReconstruction(mx, my, luma, cb, cr) {
            for (let y = 0; y < 16; y++) recLuma.set(luma.subarray(y * 16, y * 16 + 16), (my * 16 + y) * lumaStride + mx * 16);
            [cb, cr].forEach((samples, plane) => {
                for (let y = 0; y < 8; y++) recChroma[plane].set(samples.subarray(y * 8, y * 8 + 8), (my * 8 + y) * chromaStride + mx * 8);
            });
        }

        function encodeMacroblock(w, rgba, mx, my, isIdr) {
            fillSourceMacroblock(source, rgba, width, height, mx, my);
            if (qp !== null) {
                const luma = codeLuma(mx, my);
                const chroma = codeChroma(mx, my);
                setCounts(mx, my, luma, chroma);
                const coded = new BitWriter(1024);
                if (writeIntraMacroblock(coded, mx, my, luma, chroma, isIdr) && coded.bitLength < PCM_BITS) {
                    w.append(coded);
                    storeReconstruction(mx, my, luma.recon, chroma.recon[0], chroma.recon[1]);
                    return;
                }
            }
            setCounts(mx, my, 16, 16);
            w.ue(isIdr ? 25 : 30);
            w.align();
            w.bytes(source);
            storeReconstruction(mx, my, source.subarray(0, 256), source.subarray(256, 320), source.subarray(320, 384));
        }

        function encodeFrame(rgba, timeMs = 0) {
            const pixels = new Uint32Array(rgba.buffer, rgba.byteOffset, width * height);
            const isIdr = !previous || timeMs - lastIdrAt >= keyframeIntervalMs;
            if (isIdr) {
                frameNum = 0;
                lastIdrAt = timeMs;
            }
            lumaCounts.fill(0);
            chromaCounts[0].fill(0);
            chromaCounts[1].fill(0);
            const w = new BitWriter(isIdr ? mbCols * mbRows * 400 : 16384);
            w.ue(0);
            w.ue(isIdr ? 7 : 5);
            w.ue(0);
            w.bits(frameNum, 16);
            if (isIdr) {
                w.ue(idrCount % 2);
                w.bit(0);
                w.bit(0);
            } else {
                w.bit(0);
                w.bit(0);
                w.bit(0);
            }
            w.se((qp === null ? 26 : qp) - 26);
            w.ue(1);
            let skipRun = 0;
            for (let my = 0; my < mbRows; my++) {
                for (let mx = 0; mx < mbCols; mx++) {
                    if (!isIdr && !macroblockChanged(pixels, previous, width, height, mx, my)) {
                        skipRun++;
                        continue;
                    }
                    if (!isIdr) {
                        w.ue(skipRun);
                        skipRun = 0;
                    }
                    encodeMacroblock(w, rgba, mx, my, isIdr);
                }
            }
            if (skipRun) w.ue(skipRun);
            w.trailing();
            previous = pixels;
            if (isIdr) idrCount++;
            frameNum = (frameNum + 1) % 65536;
            return { data: lengthPrefixed(nalUnit(isIdr ? 0x65 : 0x41, w.buffer.subarray(0, w.length))), key: isIdr };
        }

        const description = new Uint8Array(11 + sps.length + pps.length);
        description.set([1, 66, 0xC0, LEVEL_IDC, 0xFF, 0xE1, sps.length >> 8, sps.length & 0xFF]);
        description.set(sps, 8);
        description.set([1, pps.length >> 8, pps.length & 0xFF], 8 + sps.length);
        description.set(pps, 11 + sps.length);
        return { description, encodeFrame };
    }

    window.VideoRecH264 = { createEncoder };
})();
