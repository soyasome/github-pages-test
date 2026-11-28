// 入力（ポインタ・傾き・シェイク・キーボード）を、シミュレーションが使いやすい形にまとめる。
//
// シミュレーションの step(dt, input) に渡る input:
//   pointers: [{ id, x, y, px, py, vx, vy, down, pressed, released, type }]
//       x, y   : canvas 上の位置（0〜1 に正規化。左上が 0, 0）
//       px, py : 前のフレームでの位置（ドラッグの軌跡を補間するのに使う）
//       vx, vy : 速度（正規化座標 / 秒）
//       pressed: このフレームで押された / released: このフレームで離された
//   gravity: { x, y, z } 重力の向き（長さ 1）。x: 右, y: 下, z: 画面の手前
//   gravitySource: 'default' | 'keyboard' | 'sensor'
//   shake: 揺れの強さ（重力を除いた加速度 m/s²。時間とともに減衰）

const DEG = Math.PI / 180;
const GRAVITY_SMOOTH = 0.3;     // 傾きの値をなめらかにする割合（1 で生の値）
const SHAKE_DECAY = 5;          // shake が減衰する速さ（/秒）
const SENSOR_TIMEOUT = 3000;    // 許可後この時間データが来なければ 'nodata'

const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

function screenAngle() {
    if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
    if (typeof window.orientation === 'number') return window.orientation;
    return 0;
}

export class Input {
    constructor() {
        this.canvas = null;
        this.pointers = new Map();
        this.gravity = { x: 0, y: 1, z: 0 };
        this.gravitySource = 'default';
        this.shake = 0;
        this.useKeyboard = false;
        this.keys = new Set();
        this.sensorReceived = false;

        this._onPointerDown = this._onPointerDown.bind(this);
        this._onPointerMove = this._onPointerMove.bind(this);
        this._onPointerUp = this._onPointerUp.bind(this);
        this._onContextMenu = (e) => e.preventDefault();
        this._onOrientation = this._onOrientation.bind(this);
        this._onMotion = this._onMotion.bind(this);

        window.addEventListener('keydown', (e) => this._onKey(e, true));
        window.addEventListener('keyup', (e) => this._onKey(e, false));
    }

    // シミュレーションが使う入力の種類（'pointer', 'tilt' など）を設定する
    configure(inputs) {
        this.useKeyboard = inputs.includes('tilt');
    }

    attach(canvas) {
        this.detach();
        this.canvas = canvas;
        canvas.addEventListener('pointerdown', this._onPointerDown);
        canvas.addEventListener('pointermove', this._onPointerMove);
        canvas.addEventListener('pointerup', this._onPointerUp);
        canvas.addEventListener('pointercancel', this._onPointerUp);
        canvas.addEventListener('lostpointercapture', this._onPointerUp);
        canvas.addEventListener('contextmenu', this._onContextMenu);
    }

    detach() {
        const c = this.canvas;
        if (!c) return;
        c.removeEventListener('pointerdown', this._onPointerDown);
        c.removeEventListener('pointermove', this._onPointerMove);
        c.removeEventListener('pointerup', this._onPointerUp);
        c.removeEventListener('pointercancel', this._onPointerUp);
        c.removeEventListener('lostpointercapture', this._onPointerUp);
        c.removeEventListener('contextmenu', this._onContextMenu);
        this.canvas = null;
        this.pointers.clear();
    }

    // 毎フレームの先頭で呼ぶ。シミュレーションに渡す値を返す
    frame(dt) {
        for (const p of this.pointers.values()) {
            p.vx = dt > 0 ? (p.x - p.px) / dt : 0;
            p.vy = dt > 0 ? (p.y - p.py) / dt : 0;
        }
        this.shake *= Math.exp(-SHAKE_DECAY * dt);
        return {
            pointers: [...this.pointers.values()],
            gravity: this.gravity,
            gravitySource: this.gravitySource,
            shake: this.shake,
        };
    }

    // 毎フレームの最後に呼ぶ
    endFrame() {
        for (const [id, p] of this.pointers) {
            if (p.released) { this.pointers.delete(id); continue; }
            p.px = p.x;
            p.py = p.y;
            p.pressed = false;
        }
    }

    // ---------- ポインタ（マウス・タッチ・ペン） ----------
    _pos(e) {
        const r = this.canvas.getBoundingClientRect();
        return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
    }

    _onPointerDown(e) {
        e.preventDefault();
        try { this.canvas.setPointerCapture(e.pointerId); } catch { /* 古いブラウザ */ }
        const [x, y] = this._pos(e);
        this.pointers.set(e.pointerId, {
            id: e.pointerId, x, y, px: x, py: y, vx: 0, vy: 0,
            down: true, pressed: true, released: false, type: e.pointerType,
        });
    }

    _onPointerMove(e) {
        const p = this.pointers.get(e.pointerId);
        if (!p || !p.down) return;
        [p.x, p.y] = this._pos(e);
    }

    _onPointerUp(e) {
        const p = this.pointers.get(e.pointerId);
        if (!p || !p.down) return;
        if (e.type === 'pointerup') [p.x, p.y] = this._pos(e);
        p.down = false;
        p.released = true;
    }

    // ---------- キーボード（PC で重力の向きを変える） ----------
    _onKey(e, isDown) {
        if (!this.useKeyboard || !(e.key in ARROWS)) return;
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
        e.preventDefault();
        if (!isDown) { this.keys.delete(e.key); return; }
        this.keys.add(e.key);
        let x = 0, y = 0;
        for (const k of this.keys) { x += ARROWS[k][0]; y += ARROWS[k][1]; }
        const len = Math.hypot(x, y);
        if (len === 0) return;
        this.gravity = { x: x / len, y: y / len, z: 0 };
        this.gravitySource = 'keyboard';
    }

    // ---------- センサー（傾き・シェイク） ----------
    // iPhone では requestPermission をタップ処理の中で同期的に呼ぶ必要があるため、
    // ボタンの click ハンドラから直接呼ぶこと。
    // 結果: 'active' | 'denied' | 'unsupported' | 'insecure' | 'nodata' | 'error'
    enableSensors() {
        if (!window.isSecureContext) return Promise.resolve('insecure');
        const hasO = 'DeviceOrientationEvent' in window;
        const hasM = 'DeviceMotionEvent' in window;
        if (!hasO && !hasM) return Promise.resolve('unsupported');

        const reqs = [];
        if (hasO && typeof DeviceOrientationEvent.requestPermission === 'function') {
            reqs.push(DeviceOrientationEvent.requestPermission());
        }
        if (hasM && typeof DeviceMotionEvent.requestPermission === 'function') {
            reqs.push(DeviceMotionEvent.requestPermission());
        }

        return Promise.all(reqs).then((results) => {
            if (results.some((s) => s !== 'granted')) return 'denied';
            if (hasO) window.addEventListener('deviceorientation', this._onOrientation);
            if (hasM) window.addEventListener('devicemotion', this._onMotion);
            return new Promise((resolve) => {
                this._sensorResolve = resolve;
                setTimeout(() => {
                    if (!this.sensorReceived) { this._sensorResolve = null; resolve('nodata'); }
                }, SENSOR_TIMEOUT);
            });
        }, (err) => {
            console.error(err);
            return 'error';
        });
    }

    // beta/gamma から「真下」の向きを求める（センサー情報ビューアの水準器と同じ考え方）。
    // 端末座標（x: 右, y: 上端, z: 手前）での真上 up = (-cosβ·sinγ, sinβ, cosβ·cosγ)。
    // 重力はその逆向きで、画面座標（y: 下）にすると (cosβ·sinγ, sinβ, -cosβ·cosγ)。
    // 最後に画面の回転（横向き表示など）の分だけ回す。
    _onOrientation(e) {
        if (e.beta === null || e.gamma === null) return;
        const b = e.beta * DEG, g = e.gamma * DEG;
        const px = Math.cos(b) * Math.sin(g);
        const py = Math.sin(b);
        const pz = -Math.cos(b) * Math.cos(g);
        const a = screenAngle() * DEG;
        const c = Math.cos(a), s = Math.sin(a);
        const nx = c * px + s * py;
        const ny = -s * px + c * py;

        const k = this.gravitySource === 'sensor' ? GRAVITY_SMOOTH : 1;
        const gx = this.gravity.x + (nx - this.gravity.x) * k;
        const gy = this.gravity.y + (ny - this.gravity.y) * k;
        const gz = this.gravity.z + (pz - this.gravity.z) * k;
        const len = Math.hypot(gx, gy, gz) || 1;
        this.gravity = { x: gx / len, y: gy / len, z: gz / len };
        this.gravitySource = 'sensor';

        if (!this.sensorReceived) {
            this.sensorReceived = true;
            if (this._sensorResolve) { this._sensorResolve('active'); this._sensorResolve = null; }
        }
    }

    _onMotion(e) {
        const a = e.acceleration;
        if (!a || a.x === null) return;
        this.shake = Math.max(this.shake, Math.hypot(a.x, a.y, a.z));
    }
}
