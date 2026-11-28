// カメラ映像を、シミュレーションの格子サイズに合わせた RGBA として取り出す共通部品。
//
//   const cam = new Camera();
//   await cam.start('environment');   // 'environment'（背面）| 'user'（前面）
//                                     // 待っている間に stop / start し直されたら false を返す
//   const data = cam.sample(cols, rows); // Uint8ClampedArray（RGBA）。準備中は null
//   cam.stop();
//
// 映像は比率を保ったまま全体を覆うように切り取る。前面カメラは鏡のように左右反転する。

const ERROR_MESSAGES = {
    NotAllowedError: 'カメラが許可されませんでした',
    SecurityError: 'カメラが許可されませんでした',
    NotFoundError: 'カメラが見つかりません',
    OverconstrainedError: 'カメラが見つかりません',
    NotReadableError: 'カメラを使用できません（他のアプリが使用中の可能性があります）',
};

export class Camera {
    static isSupported() {
        return Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    }

    constructor() {
        this.video = document.createElement('video');
        this.video.muted = true;
        this.video.playsInline = true;              // iPhone で全画面再生にならないように
        this.video.setAttribute('playsinline', '');
        this.stream = null;
        this.facing = null;
        this.generation = 0;      // start / stop のたびに増やし、古い start の結果を捨てる
        this.canvas = document.createElement('canvas');
        this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    }

    get ready() {
        return Boolean(this.stream) && this.video.readyState >= 2 && this.video.videoWidth > 0;
    }

    // 失敗したときは、画面に出せる日本語のメッセージを持つ Error を投げる
    async start(facing) {
        this.stop();
        const gen = this.generation;
        if (!window.isSecureContext) throw new Error('HTTPS でないためカメラを使えません');
        if (!Camera.isSupported()) throw new Error('このブラウザはカメラに対応していません');
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: { ideal: facing }, width: { ideal: 640 }, height: { ideal: 480 } },
                audio: false,
            });
        } catch (err) {
            console.error(err);
            if (gen !== this.generation) return false;
            throw new Error(ERROR_MESSAGES[err.name] ?? 'カメラの起動に失敗しました');
        }
        if (gen !== this.generation) {
            for (const t of stream.getTracks()) t.stop();
            return false;
        }
        this.stream = stream;
        this.facing = facing;
        this.video.srcObject = stream;
        try {
            await this.video.play();
        } catch (err) {
            if (gen !== this.generation) return false;
            this.stop();
            console.error(err);
            throw new Error('カメラ映像を再生できませんでした');
        }
        return gen === this.generation;
    }

    stop() {
        this.generation++;
        if (this.stream) {
            for (const t of this.stream.getTracks()) t.stop();
        }
        this.stream = null;
        this.facing = null;
        this.video.srcObject = null;
    }

    sample(width, height) {
        if (!this.ready) return null;
        const c = this.canvas;
        if (c.width !== width || c.height !== height) {
            c.width = width;
            c.height = height;
        }
        const vw = this.video.videoWidth, vh = this.video.videoHeight;
        // 比率を保って全体を覆う（はみ出した部分を切り取る）
        const scale = Math.max(width / vw, height / vh);
        const sw = width / scale, sh = height / scale;
        const sx = (vw - sw) / 2, sy = (vh - sh) / 2;

        const ctx = this.ctx;
        if (this.facing === 'user') ctx.setTransform(-1, 0, 0, 1, width, 0);
        else ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(this.video, sx, sy, sw, sh, 0, 0, width, height);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        return ctx.getImageData(0, 0, width, height).data;
    }
}
