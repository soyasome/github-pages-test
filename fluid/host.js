// ホスト：シミュレーションの読み込み・切り替え、canvas の管理、描画ループ、
// 入力やパラメータ操作パネルなど、どの案でも共通の部分を受け持つ。
//
// 各シミュレーション（sims/*.js）は次の形のオブジェクトを default export する:
//   {
//     description: 'ページに表示する説明',
//     context: '2d' | 'webgl2' | 'webgpu',
//     contextOptions: { ... },            // getContext の第 2 引数（省略可）
//     inputs: ['pointer', 'tilt'],        // 'tilt' を含むとセンサー許可ボタンを表示
//     params: [ ... ],                    // ui.js を参照
//     isSupported() { return true; },     // 省略可。false / Promise<false> なら動かさない
//     unsupportedMessage: '...',          // 省略可
//     create(canvas, ctx, params, host) { // インスタンスを返す（Promise でもよい）
//       return {
//         resize(width, height, dpr) {},  // canvas のピクセルサイズ。create の直後にも呼ばれる
//         step(dt, input) {},             // dt 秒進める（一時停止中は呼ばれない）
//         render() {},
//         onParam(key, value) {},         // reset: true 以外のパラメータ変更時
//         dispose() {},                   // 切り替え・作り直しの前に呼ばれる
//       };
//     },
//   }
//
// create の第 4 引数 host で、シミュレーション側からホストに頼めること:
//   host.showMessage(text)    // ページ上部に案内を出す（'' で消す）
//   host.setParam(key, value) // パラメータの値と画面上の表示を変える（onParam は呼ばれない）

import { SIMS } from './sims/registry.js';
import { Input } from './input.js';
import { buildParamPanel } from './ui.js';

const MAX_DT = 1 / 30;      // これより長いフレーム間隔は切り詰める（タブ復帰時の暴走防止）
const MAX_DPR = 2;          // 高解像度端末での描画負荷を抑える

const SENSOR_LABEL = {
    active: '傾きセンサー動作中',
    denied: 'センサーが許可されませんでした',
    unsupported: 'センサー非対応',
    insecure: 'HTTPS でないため使えません',
    nodata: 'センサーのデータがありません',
    error: 'センサーの開始に失敗しました',
};

export function startHost(el) {
    // el: { select, stage, desc, panel, resetParams, message, pause, reset, sensor, fps }
    const input = new Input();
    const paramStore = new Map();   // シミュレーションごとのパラメータ（切り替えても保持）
    let current = null;             // { id, mod, params, canvas, ctx, instance }
    let loadToken = 0;              // 切り替えが重なったとき、古い読み込みを捨てるため
    let paused = false;

    for (const s of SIMS) {
        const o = document.createElement('option');
        o.value = s.id;
        o.textContent = s.name;
        el.select.append(o);
    }

    const idFromHash = () => {
        const id = decodeURIComponent(location.hash.slice(1));
        return SIMS.some((s) => s.id === id) ? id : SIMS[0].id;
    };

    function showMessage(text) {
        el.message.textContent = text;
        el.message.hidden = !text;
    }

    function fail(text, err) {
        if (err) console.error(err);
        showMessage(text + (err ? `（${err.message ?? err}）` : ''));
        if (current?.instance) {
            try { current.instance.dispose?.(); } catch (e) { console.error(e); }
            current.instance = null;
        }
    }

    // ---------- canvas ----------
    function canvasSize() {
        const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
        const w = Math.max(1, Math.round(el.stage.clientWidth * dpr));
        const h = Math.max(1, Math.round(el.stage.clientHeight * dpr));
        return { w, h, dpr };
    }

    // canvas 1 つにつき使える描画方式は 1 種類なので、切り替えのたびに作り直す
    function createCanvas(mod) {
        const canvas = document.createElement('canvas');
        canvas.className = 'sim-canvas';
        el.stage.replaceChildren(canvas);
        const { w, h } = canvasSize();
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext(mod.context, mod.contextOptions);
        if (!ctx) throw new Error(`${mod.context} の描画コンテキストを取得できません`);
        return { canvas, ctx };
    }

    function applySize() {
        if (!current?.canvas) return;
        const { w, h, dpr } = canvasSize();
        const c = current.canvas;
        if (c.width !== w || c.height !== h) {
            c.width = w;
            c.height = h;
        }
        current.instance?.resize?.(w, h, dpr);
    }

    new ResizeObserver(() => {
        const c = current?.canvas;
        if (!c) return;
        const { w, h } = canvasSize();
        if (c.width !== w || c.height !== h) applySize();
    }).observe(el.stage);

    // ---------- インスタンスの作成・破棄 ----------
    async function startInstance(token) {
        const cur = current;
        let instance;
        try {
            instance = await cur.mod.create(cur.canvas, cur.ctx, { ...cur.params }, hostApi(cur, token));
        } catch (err) {
            if (token === loadToken) fail('シミュレーションの初期化に失敗しました', err);
            return;
        }
        if (token !== loadToken || current !== cur) { instance?.dispose?.(); return; }
        cur.instance = instance;
        applySize();
    }

    // シミュレーションに渡す窓口。切り替え後に古いインスタンスから呼ばれても無視する
    function hostApi(cur, token) {
        const alive = () => current === cur && token === loadToken;
        return {
            showMessage(text) { if (alive()) showMessage(text); },
            setParam(key, value) {
                if (!alive()) return;
                cur.params[key] = value;
                buildPanel();
            },
        };
    }

    function stopInstance() {
        if (!current?.instance) return;
        try { current.instance.dispose?.(); } catch (e) { console.error(e); }
        current.instance = null;
    }

    function restartInstance() {
        if (!current) return;
        showMessage('');
        stopInstance();
        startInstance(++loadToken);
    }

    // ---------- 切り替え ----------
    async function switchTo(id) {
        const entry = SIMS.find((s) => s.id === id) ?? SIMS[0];
        const token = ++loadToken;
        el.select.value = entry.id;
        showMessage('');
        stopInstance();
        current = null;
        input.detach();
        el.panel.replaceChildren();
        el.sensor.hidden = true;
        el.desc.textContent = '読み込み中…';

        let mod;
        try {
            mod = (await entry.load()).default;
            if (token !== loadToken) return;
            if (mod.isSupported && !(await mod.isSupported())) {
                if (token !== loadToken) return;
                el.desc.textContent = mod.description ?? '';
                el.stage.replaceChildren();
                showMessage(mod.unsupportedMessage ?? 'この端末・ブラウザでは動作しません');
                return;
            }
        } catch (err) {
            if (token !== loadToken) return;
            el.desc.textContent = '';
            fail('シミュレーションの読み込みに失敗しました', err);
            return;
        }
        if (token !== loadToken) return;

        el.desc.textContent = mod.description ?? '';
        const defs = mod.params ?? [];
        if (!paramStore.has(entry.id)) {
            paramStore.set(entry.id, Object.fromEntries(defs.map((d) => [d.key, d.value])));
        }
        const params = paramStore.get(entry.id);

        let canvas, ctx;
        try {
            ({ canvas, ctx } = createCanvas(mod));
        } catch (err) {
            fail('描画の準備に失敗しました', err);
            return;
        }
        current = { id: entry.id, mod, params, canvas, ctx, instance: null };

        const inputs = mod.inputs ?? [];
        input.attach(canvas);
        input.configure(inputs);
        el.sensor.hidden = !inputs.includes('tilt');
        buildPanel();

        await startInstance(token);
    }

    function buildPanel() {
        const { mod, params } = current;
        const defs = mod.params ?? [];
        el.panel.closest('section').hidden = defs.length === 0;
        buildParamPanel(el.panel, defs, params, (def, value) => {
            params[def.key] = value;
            if (def.reset) restartInstance();
            else current.instance?.onParam?.(def.key, value);
        });
    }

    // ---------- 操作ボタン ----------
    el.select.addEventListener('change', () => { location.hash = el.select.value; });
    window.addEventListener('hashchange', () => {
        if (idFromHash() !== current?.id) switchTo(idFromHash());
    });

    el.pause.addEventListener('click', () => {
        paused = !paused;
        el.pause.textContent = paused ? '▶ 再開' : '⏸ 一時停止';
    });
    el.reset.addEventListener('click', restartInstance);

    el.resetParams.addEventListener('click', () => {
        if (!current) return;
        const defs = current.mod.params ?? [];
        const needsRestart = defs.some((d) => d.reset && current.params[d.key] !== d.value);
        for (const d of defs) current.params[d.key] = d.value;
        buildPanel();
        if (needsRestart) restartInstance();
        else for (const d of defs) current.instance?.onParam?.(d.key, d.value);
    });

    el.sensor.addEventListener('click', () => {
        el.sensor.disabled = true;
        // requestPermission はこのハンドラ内で同期的に呼ばれる
        input.enableSensors().then((status) => {
            el.sensor.textContent = SENSOR_LABEL[status] ?? status;
            el.sensor.disabled = status === 'active';
        });
    });

    // ---------- 描画ループ ----------
    let last = performance.now();
    let fpsFrames = 0, fpsTime = last;

    function frame(now) {
        requestAnimationFrame(frame);
        const dt = Math.min(Math.max((now - last) / 1000, 0), MAX_DT);
        last = now;

        fpsFrames++;
        if (now - fpsTime >= 500) {
            el.fps.textContent = `${Math.round(fpsFrames * 1000 / (now - fpsTime))} FPS`;
            fpsFrames = 0;
            fpsTime = now;
        }

        const inst = current?.instance;
        if (!inst) return;
        const state = input.frame(dt);
        try {
            if (!paused) inst.step(dt, state);
            inst.render();
        } catch (err) {
            fail('実行中にエラーが発生しました', err);
        }
        input.endFrame();
    }
    requestAnimationFrame(frame);

    switchTo(idFromHash());
}
