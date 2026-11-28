// PBF（Position Based Fluids, Macklin & Müller 2013）の 2 次元ソルバー。
// DOM に依存しない純粋な計算のみ（Node.js での確認や、Web Worker への移動ができる）。
//
// 単位: カーネルの影響半径 h = 1、粒子の初期間隔 SPACING = 0.5。質量はすべて 1。
// 座標は x: 右、y: 下（画面と同じ向き）。箱は [0, width] × [0, height]。
//
// 1 ステップの流れ（step）:
//   1. 外力（重力・かき混ぜ・衝撃）を速度に加える
//   2. 位置を予測する  p* = x + dt·v
//   3. 予測位置で近傍探索
//   4. 密度の制約を反復して解く（λ を求める → 位置の補正 Δp → 壁・障害物との衝突）
//   5. 速度を求め直す v = (p* − x) / dt、渦の補強・XSPH 粘性をかける
//   6. x = p*

import { kernels2D } from './shared/kernels.js';
import { NeighborGrid } from './shared/grid.js';

export const H = 1;
export const SPACING = 0.5;
export const PARTICLE_RADIUS = SPACING / 2;

const EPSILON = 0.1;            // λ の分母に足す緩和項（小さいほど硬い）
const SCORR_K = 0.05;           // 粒子が固まるのを防ぐ反発の強さ（論文の s_corr）
const SCORR_DQ = 0.25 * H;      // s_corr の基準距離
const MAX_MOVE = 0.5 * H;       // 1 ステップで動ける最大距離（爆発防止）
const MAX_DELTA = 0.1 * H;      // 1 回の反復で補正できる最大距離（爆発防止）

export class PBFSolver {
    constructor(count, width, height) {
        this.n = count;
        this.width = width;
        this.height = height;
        this.k = kernels2D(H);
        this.grid = new NeighborGrid(H);

        const f = () => new Float32Array(count);
        this.x = f(); this.y = f();          // 位置
        this.px = f(); this.py = f();        // 予測位置
        this.vx = f(); this.vy = f();        // 速度
        this.lambda = f();
        this.density = f();
        this.omega = f();                    // 渦度
        this.tvx = f(); this.tvy = f();      // 速度の作業用

        this.params = { iterations: 3, viscosity: 0.05, cohesion: 0.3, vorticity: 0 };
        this.colliders = [];                 // [{ x, y, r }] 円形の障害物
        this.rho0 = this.restDensity();
        this.wDq = this.k.poly6(SCORR_DQ * SCORR_DQ);
        this.densityError = { avg: 0, max: 0 };
    }

    // 粒子を間隔 SPACING の正方格子に並べたときの密度を基準密度にする
    restDensity() {
        let rho = 0;
        const r = Math.ceil(H / SPACING);
        for (let j = -r; j <= r; j++) {
            for (let i = -r; i <= r; i++) {
                rho += this.k.poly6((i * SPACING) ** 2 + (j * SPACING) ** 2);
            }
        }
        return rho;
    }

    setBox(width, height) {
        this.width = width;
        this.height = height;
        for (let i = 0; i < this.n; i++) this.clampToBox(i, this.x, this.y);
    }

    // 箱の左下に水の塊を置く（ダム崩壊）
    initDamBreak(widthRatio = 0.45) {
        const { n, width, height } = this;
        let cols = Math.max(1, Math.floor((width * widthRatio - SPACING) / SPACING));
        let rows = Math.ceil(n / cols);
        const maxRows = Math.floor((height - SPACING) / SPACING);
        if (rows > maxRows) {
            rows = maxRows;
            cols = Math.ceil(n / rows);
        }
        for (let i = 0; i < n; i++) {
            const c = i % cols, r = Math.floor(i / cols);
            const jitter = () => (Math.random() - 0.5) * 0.02 * SPACING;
            this.x[i] = PARTICLE_RADIUS + SPACING * 0.5 + c * SPACING + jitter();
            this.y[i] = height - PARTICLE_RADIUS - SPACING * 0.5 - r * SPACING + jitter();
            this.vx[i] = 0;
            this.vy[i] = 0;
            this.clampToBox(i, this.x, this.y);
        }
    }

    clampToBox(i, xs, ys) {
        const r = PARTICLE_RADIUS;
        const xMax = this.width - r, yMax = this.height - r;
        if (xs[i] < r) xs[i] = r; else if (xs[i] > xMax) xs[i] = xMax;
        if (ys[i] < r) ys[i] = r; else if (ys[i] > yMax) ys[i] = yMax;
    }

    // forces: { gx, gy, impulseX, impulseY, stirs: [{ x, y, r, vx, vy, strength }] }
    step(dt, forces) {
        const { n, x, y, px, py, vx, vy } = this;
        const { gx = 0, gy = 0, impulseX = 0, impulseY = 0, stirs = [] } = forces;

        // 1〜2. 外力と位置の予測
        for (let i = 0; i < n; i++) {
            let ux = vx[i] + (gx * dt) + impulseX;
            let uy = vy[i] + (gy * dt) + impulseY;
            for (const s of stirs) {
                const dx = x[i] - s.x, dy = y[i] - s.y;
                const d2 = dx * dx + dy * dy;
                if (d2 < s.r * s.r) {
                    const w = s.strength * (1 - Math.sqrt(d2) / s.r);
                    ux += (s.vx - ux) * w;
                    uy += (s.vy - uy) * w;
                }
            }
            vx[i] = ux;
            vy[i] = uy;
            let mx = ux * dt, my = uy * dt;
            const m2 = mx * mx + my * my;
            if (m2 > MAX_MOVE * MAX_MOVE) {
                const s = MAX_MOVE / Math.sqrt(m2);
                mx *= s;
                my *= s;
            }
            px[i] = x[i] + mx;
            py[i] = y[i] + my;
            this.clampToBox(i, px, py);
        }

        // 3. 近傍探索
        this.grid.build(px, py, n, this.width, this.height, H);

        // 4. 密度の制約を反復して解く
        for (let it = 0; it < this.params.iterations; it++) {
            this.computeLambda(it === this.params.iterations - 1);
            this.applyDelta();
        }

        // 5〜6. 速度の更新
        const inv = 1 / dt;
        const vMax = MAX_MOVE * inv;
        for (let i = 0; i < n; i++) {
            let ux = (px[i] - x[i]) * inv, uy = (py[i] - y[i]) * inv;
            const u2 = ux * ux + uy * uy;
            if (u2 > vMax * vMax) {
                const k = vMax / Math.sqrt(u2);
                ux *= k;
                uy *= k;
            }
            vx[i] = ux;
            vy[i] = uy;
        }
        if (this.params.vorticity > 0) this.applyVorticity(dt);
        if (this.params.viscosity > 0) this.applyXSPH();
        x.set(px);
        y.set(py);
    }

    computeLambda(recordError) {
        const { n, px, py, lambda, density, rho0 } = this;
        const { start, list } = this.grid;
        const { h2, poly6K, spikyGradK } = this.k;
        const cohesion = this.params.cohesion;
        const self = poly6K * h2 * h2 * h2;
        const invRho0 = 1 / rho0;
        let errSum = 0, errMax = 0;

        for (let i = 0; i < n; i++) {
            const xi = px[i], yi = py[i];
            let rho = self, sx = 0, sy = 0, sumG2 = 0;
            for (let s = start[i], e = start[i + 1]; s < e; s++) {
                const j = list[s];
                const dx = xi - px[j], dy = yi - py[j];
                const r2 = dx * dx + dy * dy;
                if (r2 >= h2) continue;
                const d = h2 - r2;
                rho += poly6K * d * d * d;
                const r = Math.sqrt(r2);
                if (r < 1e-6) continue;
                const hr = H - r;
                const c = spikyGradK * hr * hr / r * invRho0;
                const gxj = c * dx, gyj = c * dy;
                sx += gxj;
                sy += gyj;
                sumG2 += gxj * gxj + gyj * gyj;
            }
            density[i] = rho;
            let C = rho * invRho0 - 1;
            if (recordError) {
                const e = C > 0 ? C : 0;
                errSum += e;
                if (e > errMax) errMax = e;
            }
            // 密度が足りない（表面付近）ときは、表面張力の強さに応じて引き寄せる
            if (C < 0) C *= cohesion;
            lambda[i] = -C / (sx * sx + sy * sy + sumG2 + EPSILON);
        }
        if (recordError) this.densityError = { avg: errSum / n, max: errMax };
    }

    applyDelta() {
        const { n, px, py, lambda, rho0, wDq } = this;
        const { start, list } = this.grid;
        const { h2, poly6K, spikyGradK } = this.k;
        const dxs = this.tvx, dys = this.tvy;
        const invRho0 = 1 / rho0;
        const invWDq = 1 / wDq;

        for (let i = 0; i < n; i++) {
            const xi = px[i], yi = py[i], li = lambda[i];
            let ax = 0, ay = 0;
            for (let s = start[i], e = start[i + 1]; s < e; s++) {
                const j = list[s];
                const dx = xi - px[j], dy = yi - py[j];
                const r2 = dx * dx + dy * dy;
                if (r2 >= h2) continue;
                const r = Math.sqrt(r2);
                if (r < 1e-6) continue;
                const d = h2 - r2;
                const ratio = poly6K * d * d * d * invWDq;
                const r4 = ratio * ratio * ratio * ratio;
                const scorr = -SCORR_K * r4;
                const hr = H - r;
                const c = (li + lambda[j] + scorr) * spikyGradK * hr * hr / r;
                ax += c * dx;
                ay += c * dy;
            }
            ax *= invRho0;
            ay *= invRho0;
            const a2 = ax * ax + ay * ay;
            if (a2 > MAX_DELTA * MAX_DELTA) {
                const k = MAX_DELTA / Math.sqrt(a2);
                ax *= k;
                ay *= k;
            }
            dxs[i] = ax;
            dys[i] = ay;
        }

        const colliders = this.colliders;
        for (let i = 0; i < n; i++) {
            px[i] += dxs[i];
            py[i] += dys[i];
            for (const c of colliders) {
                const dx = px[i] - c.x, dy = py[i] - c.y;
                const d2 = dx * dx + dy * dy;
                const rr = c.r + PARTICLE_RADIUS;
                if (d2 < rr * rr) {
                    const d = Math.sqrt(d2);
                    if (d < 1e-6) { px[i] += rr; continue; }
                    const s = rr / d;
                    px[i] = c.x + dx * s;
                    py[i] = c.y + dy * s;
                }
            }
            this.clampToBox(i, px, py);
        }
    }

    // 渦の補強（vorticity confinement）: 数値計算で失われがちな小さな渦を強める
    applyVorticity(dt) {
        const { n, px, py, vx, vy, omega, rho0 } = this;
        const { start, list } = this.grid;
        const { h2, spikyGradK } = this.k;
        const eps = this.params.vorticity;
        const invRho0 = 1 / rho0;

        for (let i = 0; i < n; i++) {
            let w = 0;
            for (let s = start[i], e = start[i + 1]; s < e; s++) {
                const j = list[s];
                const dx = px[i] - px[j], dy = py[i] - py[j];
                const r2 = dx * dx + dy * dy;
                if (r2 >= h2) continue;
                const r = Math.sqrt(r2);
                if (r < 1e-6) continue;
                const hr = H - r;
                const c = spikyGradK * hr * hr / r;
                w += (c * dx) * (vy[j] - vy[i]) - (c * dy) * (vx[j] - vx[i]);
            }
            omega[i] = w * invRho0;
        }
        for (let i = 0; i < n; i++) {
            const wi = Math.abs(omega[i]);
            let ex = 0, ey = 0;
            for (let s = start[i], e = start[i + 1]; s < e; s++) {
                const j = list[s];
                const dx = px[i] - px[j], dy = py[i] - py[j];
                const r2 = dx * dx + dy * dy;
                if (r2 >= h2) continue;
                const r = Math.sqrt(r2);
                if (r < 1e-6) continue;
                const hr = H - r;
                const c = spikyGradK * hr * hr / r * (Math.abs(omega[j]) - wi);
                ex += c * dx;
                ey += c * dy;
            }
            const len = Math.hypot(ex, ey);
            if (len < 1e-6) continue;
            const nx = ex / len, ny = ey / len;
            vx[i] += dt * eps * ny * omega[i];
            vy[i] -= dt * eps * nx * omega[i];
        }
    }

    // XSPH 粘性: 周りの粒子と速度をならす（値が大きいほどどろっとする）
    applyXSPH() {
        const { n, px, py, vx, vy, density, tvx, tvy } = this;
        const { start, list } = this.grid;
        const { h2, poly6K } = this.k;
        const c = this.params.viscosity;

        for (let i = 0; i < n; i++) {
            let ax = 0, ay = 0;
            for (let s = start[i], e = start[i + 1]; s < e; s++) {
                const j = list[s];
                const dx = px[i] - px[j], dy = py[i] - py[j];
                const r2 = dx * dx + dy * dy;
                if (r2 >= h2) continue;
                const d = h2 - r2;
                const w = poly6K * d * d * d;
                ax += (vx[j] - vx[i]) * w;
                ay += (vy[j] - vy[i]) * w;
            }
            const inv = c / density[i];
            tvx[i] = vx[i] + ax * inv;
            tvy[i] = vy[i] + ay * inv;
        }
        vx.set(tvx);
        vy.set(tvy);
    }
}
