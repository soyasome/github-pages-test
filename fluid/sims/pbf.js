// 案4: PBF（Position Based Fluids）
//
// 計算は pbf-solver.js、ここでは入力（傾き・指・シェイク）の解釈と描画を受け持つ。
// 箱の縦横比は canvas に合わせ、面積は粒子数から決める（水が箱の約 35% を占める）。
// 描画は今のところ粒子をそのまま点で描く（速さ・密度で色分け）。

import { PBFSolver, SPACING, PARTICLE_RADIUS } from './pbf-solver.js';

const FILL_RATIO = 0.35;        // 箱の面積に対する水の割合
const BASE_GRAVITY = 40;        // 重力の強さ 1 のときの加速度（粒子間隔 0.5 の単位系）
const FRAME = 1 / 60;
const STIR_STRENGTH = 0.25;     // かき混ぜるとき、指の速度にどれだけ近づけるか（1 ステップあたり）
const SHAKE_THRESHOLD = 12;     // この強さ（m/s²）を超えた揺れで水を揺さぶる
const SHAKE_COOLDOWN = 0.2;     // 秒
const SHAKE_IMPULSE = 1.5;      // 揺れの強さ → 速度の変化
const COLOR_STEPS = 24;
const SPEED_REF = 40;           // この速さで色が最も明るくなる
const DENSITY_REF = 0.08;       // 密度のずれ ±8% で色が最も濃くなる
// ImageData を Uint32Array で見たときの色の並び（大半の環境はリトルエンディアンで ABGR）
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const BG_COLOR = rgba32(13, 17, 23);

export default {
    description:
        'PBF（Position Based Fluids）で、粒子の密度が一定になるよう位置を補正しながら水の流れを計算します。' +
        '指でかき混ぜたり押しのけたりできます。「傾きセンサーを使う」を押すと端末の傾きで重力の向きが変わります' +
        '（平らに置くと画面内の重力は弱まります）。PC では矢印キーで重力の向きを変えられます。',
    context: '2d',
    contextOptions: { alpha: false },
    inputs: ['pointer', 'tilt'],
    params: [
        { key: 'count', label: '粒子数', type: 'select', options: [1000, 2000, 4000, 8000], value: 2000, reset: true },
        { key: 'gravity', label: '重力の強さ', type: 'range', min: 0, max: 2, step: 0.1, value: 1 },
        { key: 'substeps', label: '計算の細かさ（ステップ / フレーム）', type: 'range', min: 1, max: 4, step: 1, value: 3 },
        { key: 'iterations', label: '反復回数', type: 'range', min: 1, max: 6, step: 1, value: 3 },
        { key: 'viscosity', label: '粘性', type: 'range', min: 0, max: 0.5, step: 0.01, value: 0.05 },
        { key: 'cohesion', label: '表面張力', type: 'range', min: 0, max: 1, step: 0.05, value: 0.3 },
        { key: 'vorticity', label: '渦の強さ', type: 'range', min: 0, max: 20, step: 1, value: 2 },
        {
            key: 'tool', label: '指の操作', type: 'select', value: 'stir',
            options: [{ value: 'stir', label: 'かき混ぜる' }, { value: 'push', label: '押しのける' }],
        },
        { key: 'toolSize', label: '指の大きさ（箱の短辺に対する %）', type: 'range', min: 5, max: 25, step: 1, value: 10 },
        {
            key: 'view', label: '表示', type: 'select', value: 'speed',
            options: [{ value: 'speed', label: '粒子（速さで色分け）' }, { value: 'density', label: '粒子（密度で色分け）' }],
        },
    ],
    create(canvas, ctx, params) {
        return new PBF(canvas, ctx, params);
    },
};

function boxSize(count, width, height) {
    const area = count * SPACING * SPACING / FILL_RATIO;
    const w = Math.sqrt(area * width / height);
    return [w, area / w];
}

class PBF {
    constructor(canvas, ctx, params) {
        this.canvas = canvas;
        this.ctx = ctx;
        this.p = params;
        const [w, h] = boxSize(params.count, canvas.width, canvas.height);
        this.solver = new PBFSolver(params.count, w, h);
        this.applySolverParams();
        this.solver.initDamBreak();
        this.acc = 0;
        this.shakeCooldown = 0;
        this.gravity = { x: 0, y: 1 };
        this.off = document.createElement('canvas');    // 描画用の縮小画像（CSS ピクセル相当）
        this.offCtx = this.off.getContext('2d');
        this.img = null;
        this.pixels = null;                              // img の中身を 1 ピクセル 32 ビットで見たもの
        this.palettes = { speed: makeSpeedPalette(), density: makeDensityPalette() };
    }

    applySolverParams() {
        const sp = this.solver.params;
        sp.iterations = this.p.iterations;
        sp.viscosity = this.p.viscosity;
        sp.cohesion = this.p.cohesion;
        sp.vorticity = this.p.vorticity;
    }

    resize(width, height, dpr) {
        const [w, h] = boxSize(this.p.count, width, height);
        if (Math.abs(w - this.solver.width) > 1e-6 || Math.abs(h - this.solver.height) > 1e-6) {
            this.solver.setBox(w, h);
        }
        // 縮小画像は CSS ピクセル相当の解像度にする
        const offW = Math.max(1, Math.round(width / dpr));
        const offH = Math.max(1, Math.round(height / dpr));
        this.off.width = offW;
        this.off.height = offH;
        this.offW = offW;
        this.offH = offH;
        this.img = this.offCtx.createImageData(offW, offH);
        this.pixels = new Uint32Array(this.img.data.buffer);
        // 粒子 1 個分の円に含まれるピクセルの位置を前もって求めておく
        const r = Math.max(1, PARTICLE_RADIUS * (offW / w) * 1.15);
        const ri = Math.ceil(r);
        const dx = [], dy = [];
        for (let y = -ri; y <= ri; y++) {
            for (let x = -ri; x <= ri; x++) {
                if (x * x + y * y <= r * r) { dx.push(x); dy.push(y); }
            }
        }
        this.discX = Int32Array.from(dx);
        this.discY = Int32Array.from(dy);
        this.discRadius = ri;
    }

    onParam(key, value) {
        this.p[key] = value;
        this.applySolverParams();
    }

    step(dt, input) {
        const s = this.solver;
        const W = s.width, H = s.height;
        const g = BASE_GRAVITY * this.p.gravity;
        // 画面に平行な成分だけを使う（平らに置くと弱まる）
        this.gravity = { x: input.gravity.x, y: input.gravity.y };

        // シェイク: ランダムな向きに水全体を揺さぶる
        let impulseX = 0, impulseY = 0;
        this.shakeCooldown -= dt;
        if (input.shake > SHAKE_THRESHOLD && this.shakeCooldown <= 0) {
            const a = Math.random() * Math.PI * 2;
            const m = (input.shake - SHAKE_THRESHOLD * 0.5) * SHAKE_IMPULSE;
            impulseX = Math.cos(a) * m;
            impulseY = Math.sin(a) * m;
            this.shakeCooldown = SHAKE_COOLDOWN;
        }

        // 指: 正規化座標 → 箱の座標
        const toolR = this.p.toolSize / 100 * Math.min(W, H);
        const fingers = input.pointers.filter((ptr) => ptr.down).map((ptr) => ({
            x0: ptr.px * W, y0: ptr.py * H, x1: ptr.x * W, y1: ptr.y * H,
            vx: ptr.vx * W, vy: ptr.vy * H,
        }));

        const substeps = this.p.substeps;
        const sdt = FRAME / substeps;
        this.acc = Math.min(this.acc + dt, FRAME * 2);
        const steps = Math.floor(this.acc / sdt);
        this.acc -= steps * sdt;

        for (let k = 0; k < steps; k++) {
            // 指の位置はフレーム内で補間して、速く動かしても粒子をすり抜けないようにする
            const t = (k + 1) / steps;
            const at = (f) => ({ x: f.x0 + (f.x1 - f.x0) * t, y: f.y0 + (f.y1 - f.y0) * t });
            let stirs = [];
            if (this.p.tool === 'push') {
                s.colliders = fingers.map((f) => ({ ...at(f), r: toolR }));
            } else {
                s.colliders = [];
                stirs = fingers.map((f) => ({ ...at(f), r: toolR, vx: f.vx, vy: f.vy, strength: STIR_STRENGTH }));
            }
            s.step(sdt, {
                gx: this.gravity.x * g,
                gy: this.gravity.y * g,
                impulseX: k === 0 ? impulseX : 0,
                impulseY: k === 0 ? impulseY : 0,
                stirs,
            });
        }
        if (fingers.length === 0) s.colliders = [];
    }

    render() {
        const { ctx, canvas, solver: s } = this;
        if (!this.pixels) return;
        const n = s.n;
        const byDensity = this.p.view === 'density';
        const palette = byDensity ? this.palettes.density : this.palettes.speed;

        // 粒子を縮小した画像に円として直接書き込み、最後に拡大して描く（arc を大量に描くより速い）
        const { pixels, offW, offH, discX, discY } = this;
        const dl = discX.length;
        const rs = offW / s.width;
        const rad = this.discRadius;
        pixels.fill(BG_COLOR);
        for (let i = 0; i < n; i++) {
            let t;
            if (byDensity) t = 0.5 + (s.density[i] / s.rho0 - 1) / DENSITY_REF * 0.5;
            else t = Math.hypot(s.vx[i], s.vy[i]) / SPEED_REF;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const color = palette[Math.min(COLOR_STEPS - 1, (t * COLOR_STEPS) | 0)];
            const cx = (s.x[i] * rs) | 0, cy = (s.y[i] * rs) | 0;
            if (cx >= rad && cy >= rad && cx < offW - rad && cy < offH - rad) {
                const base = cy * offW + cx;
                for (let k = 0; k < dl; k++) pixels[base + discY[k] * offW + discX[k]] = color;
            } else {
                for (let k = 0; k < dl; k++) {
                    const x = cx + discX[k], y = cy + discY[k];
                    if (x >= 0 && y >= 0 && x < offW && y < offH) pixels[y * offW + x] = color;
                }
            }
        }
        this.offCtx.putImageData(this.img, 0, 0);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(this.off, 0, 0, canvas.width, canvas.height);
        const scale = canvas.width / s.width;

        // 押しのけるときの指の円
        ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        ctx.lineWidth = Math.max(1, scale * 0.1);
        for (const c of s.colliders) {
            ctx.beginPath();
            ctx.arc(c.x * scale, c.y * scale, c.r * scale, 0, Math.PI * 2);
            ctx.stroke();
        }

        this.drawOverlay();
    }

    // 左上に状態、右上に重力の向き
    drawOverlay() {
        const { ctx, canvas, solver: s } = this;
        const dpr = Math.max(1, canvas.width / canvas.clientWidth || 1);
        ctx.font = `${12 * dpr}px monospace`;
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.textBaseline = 'top';
        const e = s.densityError;
        ctx.fillText(`${s.n} 粒子  密度誤差 平均 ${(e.avg * 100).toFixed(1)}% / 最大 ${(e.max * 100).toFixed(0)}%`, 8 * dpr, 8 * dpr);

        const R = 18 * dpr;
        const cx = canvas.width - R - 10 * dpr, cy = R + 10 * dpr;
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = 1.5 * dpr;
        ctx.beginPath();
        ctx.arc(cx, cy, R, 0, Math.PI * 2);
        ctx.stroke();
        const gx = this.gravity.x, gy = this.gravity.y;
        const len = Math.hypot(gx, gy);
        if (len > 0.02) {
            const ex = cx + gx * R * 0.9, ey = cy + gy * R * 0.9;
            const ux = gx / len, uy = gy / len;
            const head = 6 * dpr;
            ctx.strokeStyle = 'rgba(255,255,255,0.85)';
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(ex, ey);
            ctx.moveTo(ex, ey);
            ctx.lineTo(ex - ux * head - uy * head * 0.6, ey - uy * head + ux * head * 0.6);
            ctx.moveTo(ex, ey);
            ctx.lineTo(ex - ux * head + uy * head * 0.6, ey - uy * head - ux * head * 0.6);
            ctx.stroke();
        } else {
            ctx.fillStyle = 'rgba(255,255,255,0.85)';
            ctx.beginPath();
            ctx.arc(cx, cy, 2.5 * dpr, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    dispose() {
        this.solver = null;
    }
}

function rgba32(r, g, b) {
    return LITTLE_ENDIAN
        ? ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0
        : ((r << 24) | (g << 16) | (b << 8) | 255) >>> 0;
}

function lerpColor(stops, t) {
    const seg = Math.min(stops.length - 2, Math.floor(t * (stops.length - 1)));
    const u = t * (stops.length - 1) - seg;
    const a = stops[seg], b = stops[seg + 1];
    const c = a.map((v, i) => Math.round(v + (b[i] - v) * u));
    return rgba32(c[0], c[1], c[2]);
}

// 遅い: 濃い青 → 速い: 水色 → 白
function makeSpeedPalette() {
    const stops = [[22, 70, 160], [40, 140, 220], [120, 210, 245], [235, 250, 255]];
    return Array.from({ length: COLOR_STEPS }, (_, i) => lerpColor(stops, i / (COLOR_STEPS - 1)));
}

// 疎: 青 → 基準: 白 → 密: 赤
function makeDensityPalette() {
    const stops = [[50, 110, 230], [235, 240, 245], [230, 70, 50]];
    return Array.from({ length: COLOR_STEPS }, (_, i) => lerpColor(stops, i / (COLOR_STEPS - 1)));
}
