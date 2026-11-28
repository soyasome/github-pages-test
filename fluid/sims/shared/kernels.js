// 2 次元用の SPH カーネル関数（影響半径 h）。粒子法（SPH / PBF など）で共用する。
//
//   poly6:       W(r)  = 4 / (π h⁸) · (h² − r²)³          … 密度の計算に使う
//   spiky の勾配: ∇W(r) = −30 / (π h⁵) · (h − r)² · r̂      … 圧力（位置の補正）の向きに使う
//
// 内側のループでは関数呼び出しを避けるため、係数（poly6K, spikyGradK）を取り出して直接計算してよい。
// ∇W(pᵢ − pⱼ) は spikyGradK · (h − r)² / r · (pᵢ − pⱼ) で、係数が負なので pⱼ の方を向く。

export function kernels2D(h) {
    const h2 = h * h;
    const poly6K = 4 / (Math.PI * h ** 8);
    const spikyGradK = -30 / (Math.PI * h ** 5);
    return {
        h,
        h2,
        poly6K,
        spikyGradK,
        poly6(r2) {
            if (r2 >= h2) return 0;
            const d = h2 - r2;
            return poly6K * d * d * d;
        },
    };
}
