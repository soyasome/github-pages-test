// 案1: 波紋（2 次元の波動方程式）
//
// 水面の高さ h を格子で持ち、1 ステップごとに
//   h_next = (上下左右 4 つの和) / 2 − h_prev
// で更新する（波の速さ c² = 0.5 マス²/ステップ² の波動方程式の差分）。
// 端は「壁」として扱い、波が反射する。
// 描画は、高さの傾きで底のタイル模様をずらして屈折を表し、光の反射を足す。

const BASE_COLS = 256;          // この解像度を基準に、水滴の大きさなどを揃える
const STEPS_PER_SEC = 60;       // 「波の速さ 1」のときの 1 秒あたりのステップ数
const MAX_STEPS_PER_FRAME = 16;
const REFRACTION = 6;           // 傾き → 背景のずれ（マス）
const NORMAL_SCALE = 1.5;       // 傾き → 光の当たり方
const LIGHT = normalize([-0.5, -0.7, 0.6]);
const HALF = normalize([LIGHT[0], LIGHT[1], LIGHT[2] + 1]);

function normalize(v) {
    const l = Math.hypot(...v);
    return v.map((x) => x / l);
}

export default {
    description:
        '水面の高さを格子で持ち、波動方程式で波を伝えます。' +
        'タップで水滴を落とし、ドラッグで波を起こせます。波は壁で反射します。',
    context: '2d',
    contextOptions: { alpha: false },
    inputs: ['pointer'],
    params: [
        { key: 'resolution', label: '解像度（横のマス数）', type: 'select', options: [128, 256, 512], value: 256, reset: true },
        { key: 'speed', label: '波の速さ', type: 'range', min: 1, max: 4, step: 1, value: 2 },
        { key: 'damping', label: '波の持続', type: 'range', min: 0.95, max: 0.999, step: 0.001, value: 0.99 },
        { key: 'dropSize', label: '水滴の大きさ', type: 'range', min: 2, max: 20, step: 1, value: 6 },
        { key: 'rain', label: '雨（滴 / 秒）', type: 'range', min: 0, max: 20, step: 1, value: 1 },
        {
            key: 'view', label: '表示', type: 'select', value: 'water',
            options: [{ value: 'water', label: '水面（屈折＋光）' }, { value: 'height', label: '高さマップ' }],
        },
    ],
    create(canvas, ctx, params) {
        return new Ripple(canvas, ctx, params);
    },
};

class Ripple {
    constructor(canvas, ctx, params) {
        this.canvas = canvas;
        this.ctx = ctx;
        this.p = params;
        this.cols = 0;
        this.rows = 0;
        this.scale = params.resolution / BASE_COLS;
        this.cur = null;     // 現在の高さ
        this.prev = null;    // 1 ステップ前の高さ（更新時に次の高さで上書きして入れ替える）
        this.bg = null;      // 底の模様（RGB）
        this.off = document.createElement('canvas');
        this.offCtx = this.off.getContext('2d');
        this.img = null;
        this.stepAcc = 0;
        this.rainAcc = 0;
    }

    resize(width, height) {
        const cols = this.p.resolution;
        const rows = Math.max(2, Math.round(cols * height / width));
        if (cols === this.cols && rows === this.rows) return;

        const cur = new Float32Array(cols * rows);
        const prev = new Float32Array(cols * rows);
        // 画面サイズが変わっても波が消えないよう、前の格子から引き継ぐ
        if (this.cur) {
            for (let y = 0; y < rows; y++) {
                const sy = Math.min(this.rows - 1, Math.floor(y * this.rows / rows));
                for (let x = 0; x < cols; x++) {
                    const sx = Math.min(this.cols - 1, Math.floor(x * this.cols / cols));
                    cur[y * cols + x] = this.cur[sy * this.cols + sx];
                    prev[y * cols + x] = this.prev[sy * this.cols + sx];
                }
            }
        }
        this.cols = cols;
        this.rows = rows;
        this.cur = cur;
        this.prev = prev;
        this.off.width = cols;
        this.off.height = rows;
        this.img = this.offCtx.createImageData(cols, rows);
        this.bg = makeTiles(cols, rows, this.scale);
    }

    onParam(key, value) {
        this.p[key] = value;
    }

    // 位置 (x, y)（マス単位）に、なめらかなくぼみを加える
    drop(x, y, radius, strength) {
        const { cols, rows, cur } = this;
        const x0 = Math.max(0, Math.floor(x - radius)), x1 = Math.min(cols - 1, Math.ceil(x + radius));
        const y0 = Math.max(0, Math.floor(y - radius)), y1 = Math.min(rows - 1, Math.ceil(y + radius));
        for (let j = y0; j <= y1; j++) {
            for (let i = x0; i <= x1; i++) {
                const d = Math.hypot(i - x, j - y);
                if (d < radius) cur[j * cols + i] -= strength * 0.5 * (1 + Math.cos(Math.PI * d / radius));
            }
        }
    }

    step(dt, input) {
        if (!this.cur) return;
        const { cols, rows, scale, p } = this;
        const radius = p.dropSize * scale;

        for (const ptr of input.pointers) {
            const x = ptr.x * cols, y = ptr.y * rows;
            if (ptr.pressed) this.drop(x, y, radius, scale);
            if (ptr.down && !ptr.pressed) {
                // 前フレームの位置から線状に並べて、速く動かしても途切れないようにする
                const px = ptr.px * cols, py = ptr.py * rows;
                const dist = Math.hypot(x - px, y - py);
                const n = Math.ceil(dist / (radius * 0.5));
                for (let k = 1; k <= n; k++) {
                    const t = k / n;
                    this.drop(px + (x - px) * t, py + (y - py) * t, radius, 0.25 * scale);
                }
            }
        }

        this.rainAcc += dt * p.rain;
        while (this.rainAcc >= 1) {
            this.rainAcc -= 1;
            const r = radius * (0.4 + Math.random() * 0.6);
            this.drop(Math.random() * cols, Math.random() * rows, r, 0.6 * scale);
        }

        this.stepAcc += dt * STEPS_PER_SEC * p.speed;
        const n = Math.min(Math.floor(this.stepAcc), MAX_STEPS_PER_FRAME);
        this.stepAcc = Math.min(this.stepAcc - n, 1);
        for (let k = 0; k < n; k++) this.simulate();
    }

    simulate() {
        const { cols, rows, cur, prev } = this;
        const damp = this.p.damping;
        for (let y = 0; y < rows; y++) {
            const row = y * cols;
            const up = y > 0 ? row - cols : row;          // 端では自分自身を隣とみなす（反射壁）
            const dn = y < rows - 1 ? row + cols : row;
            for (let x = 0; x < cols; x++) {
                const i = row + x;
                const l = x > 0 ? i - 1 : i;
                const r = x < cols - 1 ? i + 1 : i;
                prev[i] = ((cur[l] + cur[r] + cur[up + x] + cur[dn + x]) * 0.5 - prev[i]) * damp;
            }
        }
        this.prev = cur;
        this.cur = prev;
    }

    render() {
        if (!this.cur) return;
        if (this.p.view === 'height') this.renderHeight();
        else this.renderWater();
        this.offCtx.putImageData(this.img, 0, 0);
        const ctx = this.ctx;
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(this.off, 0, 0, this.canvas.width, this.canvas.height);
    }

    renderWater() {
        const { cols, rows, cur, bg, scale } = this;
        const out = this.img.data;
        const refr = REFRACTION * scale;
        const maxX = cols - 1.001, maxY = rows - 1.001;   // 補間で右下の隣を読むため、端の 1 マス手前まで
        const [lx, ly, lz] = LIGHT;
        const [hx, hy, hz] = HALF;
        for (let y = 0; y < rows; y++) {
            const row = y * cols;
            const up = y > 0 ? row - cols : row;
            const dn = y < rows - 1 ? row + cols : row;
            for (let x = 0; x < cols; x++) {
                const i = row + x;
                const gx = cur[x < cols - 1 ? i + 1 : i] - cur[x > 0 ? i - 1 : i];
                const gy = cur[dn + x] - cur[up + x];

                // 屈折：傾きの分だけずれた位置の底を見る（周囲 4 マスを補間してなめらかに）
                let sx = x + gx * refr;
                let sy = y + gy * refr;
                sx = sx < 0 ? 0 : sx > maxX ? maxX : sx;
                sy = sy < 0 ? 0 : sy > maxY ? maxY : sy;
                const ix = sx | 0, iy = sy | 0;
                const tx = sx - ix, ty = sy - iy;
                const b00 = (iy * cols + ix) * 3, b10 = b00 + 3;
                const b01 = b00 + cols * 3, b11 = b01 + 3;
                const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;

                // 水面の法線から、明るさとハイライトを求める
                const nx = -gx * NORMAL_SCALE, ny = -gy * NORMAL_SCALE;
                const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
                const diffuse = 1 + ((nx * lx + ny * ly + lz) * inv - lz) * 1.2;
                const nh = (nx * hx + ny * hy + hz) * inv;
                let spec = nh > 0 ? nh ** 64 : 0;
                spec *= 255;

                const o = i * 4;
                for (let c = 0; c < 3; c++) {
                    const v = bg[b00 + c] * w00 + bg[b10 + c] * w10 + bg[b01 + c] * w01 + bg[b11 + c] * w11;
                    out[o + c] = v * diffuse + spec;
                }
                out[o + 3] = 255;
            }
        }
    }

    renderHeight() {
        const { cur, scale } = this;
        const out = this.img.data;
        const range = 0.8 * scale;
        for (let i = 0; i < cur.length; i++) {
            let t = cur[i] / range;
            t = t > 1 ? 1 : t < -1 ? -1 : t;
            const o = i * 4;
            if (t >= 0) {           // 高い所: 暖色
                out[o] = 24 + 231 * t;
                out[o + 1] = 28 + 112 * t;
                out[o + 2] = 36 + 24 * t;
            } else {                // 低い所: 寒色
                out[o] = 24 + 36 * -t;
                out[o + 1] = 28 + 132 * -t;
                out[o + 2] = 36 + 219 * -t;
            }
            out[o + 3] = 255;
        }
    }

    dispose() {
        this.cur = this.prev = this.bg = this.img = null;
    }
}

// プールの底のタイル模様（RGB, 1 マス 3 バイト）
function makeTiles(cols, rows, scale) {
    const bg = new Uint8ClampedArray(cols * rows * 3);
    const tile = Math.max(6, Math.round(22 * scale));
    const grout = Math.max(1, Math.round(tile * 0.08));
    const cx = cols / 2, cy = rows / 2;
    const maxD = Math.hypot(cx, cy);
    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
            const tx = Math.floor(x / tile), ty = Math.floor(y / tile);
            const onGrout = x % tile < grout || y % tile < grout;
            // タイルごとの色むら（座標から作る疑似乱数）
            const h = Math.sin(tx * 12.9898 + ty * 78.233) * 43758.5453;
            const jitter = (h - Math.floor(h) - 0.5) * 14;
            // 周辺を少し暗くして奥行きを出す
            const vignette = 1 - 0.35 * (Math.hypot(x - cx, y - cy) / maxD) ** 2;
            const o = (y * cols + x) * 3;
            if (onGrout) {
                bg[o] = 150 * vignette;
                bg[o + 1] = 205 * vignette;
                bg[o + 2] = 225 * vignette;
            } else {
                bg[o] = (40 + jitter) * vignette;
                bg[o + 1] = (140 + jitter) * vignette;
                bg[o + 2] = (190 + jitter) * vignette;
            }
        }
    }
    return bg;
}
