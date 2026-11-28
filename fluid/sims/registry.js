// シミュレーションの一覧。新しい案を追加するときは、sims/ にファイルを作ってここに 1 行足す。
// load は選ばれたときに初めて呼ばれる（使わない案のファイルは読み込まない）。
export const SIMS = [
    { id: 'ripple', name: '① 波紋（波動方程式）', load: () => import('./ripple.js') },
    // { id: 'shallow', name: '② 浅水方程式', load: () => import('./shallow.js') },
    // { id: 'sph',     name: '③ SPH（粒子法）', load: () => import('./sph.js') },
    { id: 'pbf', name: '④ PBF（Position Based Fluids）', load: () => import('./pbf.js') },
];
