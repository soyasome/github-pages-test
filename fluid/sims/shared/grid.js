// 一様格子による近傍探索（粒子法で共用）。
//
// 1 辺 cellSize のマスに粒子を振り分け（計数ソート）、各粒子について周囲 3×3 マスだけを調べて
// 距離 radius 未満の粒子を集める。cellSize ≥ radius であること。
//
// 結果は「粒子ごとの開始位置」と「近傍の番号を並べた配列」の 2 つで持つ:
//   粒子 i の近傍は list[start[i]] 〜 list[start[i + 1] − 1]（自分自身は含まない）

export class NeighborGrid {
    constructor(cellSize) {
        this.cellSize = cellSize;
        this.cols = 0;
        this.rows = 0;
        this.cellStart = new Int32Array(1);
        this.cursor = new Int32Array(1);
        this.cellX = new Int32Array(0);
        this.cellY = new Int32Array(0);
        this.sorted = new Int32Array(0);
        this.start = new Int32Array(1);
        this.list = new Int32Array(1024);
    }

    build(xs, ys, n, width, height, radius) {
        const cs = this.cellSize;
        const cols = Math.max(1, Math.ceil(width / cs));
        const rows = Math.max(1, Math.ceil(height / cs));
        const cells = cols * rows;
        if (this.cellStart.length < cells + 1) {
            this.cellStart = new Int32Array(cells + 1);
            this.cursor = new Int32Array(cells + 1);
        }
        if (this.sorted.length < n) {
            this.cellX = new Int32Array(n);
            this.cellY = new Int32Array(n);
            this.sorted = new Int32Array(n);
            this.start = new Int32Array(n + 1);
        }
        this.cols = cols;
        this.rows = rows;
        const { cellStart, cursor, cellX, cellY, sorted, start } = this;

        // マスごとの粒子数を数え、累積和で各マスの開始位置にする
        cellStart.fill(0, 0, cells + 1);
        for (let i = 0; i < n; i++) {
            let cx = Math.floor(xs[i] / cs), cy = Math.floor(ys[i] / cs);
            cx = cx < 0 ? 0 : cx >= cols ? cols - 1 : cx;
            cy = cy < 0 ? 0 : cy >= rows ? rows - 1 : cy;
            cellX[i] = cx;
            cellY[i] = cy;
            cellStart[cy * cols + cx + 1]++;
        }
        for (let c = 0; c < cells; c++) cellStart[c + 1] += cellStart[c];
        cursor.set(cellStart.subarray(0, cells));
        for (let i = 0; i < n; i++) sorted[cursor[cellY[i] * cols + cellX[i]]++] = i;

        // 周囲 3×3 マスから近傍を集める
        const r2 = radius * radius;
        let list = this.list;
        let k = 0;
        for (let i = 0; i < n; i++) {
            start[i] = k;
            const xi = xs[i], yi = ys[i];
            const cx = cellX[i], cy = cellY[i];
            const y0 = cy > 0 ? cy - 1 : 0, y1 = cy < rows - 1 ? cy + 1 : cy;
            const x0 = cx > 0 ? cx - 1 : 0, x1 = cx < cols - 1 ? cx + 1 : cx;
            for (let gy = y0; gy <= y1; gy++) {
                const rowBase = gy * cols;
                const s0 = cellStart[rowBase + x0], s1 = cellStart[rowBase + x1 + 1];
                for (let s = s0; s < s1; s++) {
                    const j = sorted[s];
                    if (j === i) continue;
                    const dx = xi - xs[j], dy = yi - ys[j];
                    if (dx * dx + dy * dy >= r2) continue;
                    if (k >= list.length) {
                        const grown = new Int32Array(list.length * 2);
                        grown.set(list);
                        list = this.list = grown;
                    }
                    list[k++] = j;
                }
            }
        }
        start[n] = k;
        return k;
    }
}
