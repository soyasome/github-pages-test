// シミュレーションの params 定義から、パラメータ操作パネルを自動生成する。
//
// params の書き方:
//   { key, label, type: 'range',    min, max, step, value, reset? }
//   { key, label, type: 'select',   options: [値 | { value, label }], value, reset? }
//   { key, label, type: 'checkbox', value, reset? }
// reset: true の項目は、変更時にシミュレーションを作り直す（粒子数など）。
// それ以外は instance.onParam(key, value) で即時に反映される。

function decimals(step) {
    const s = String(step);
    const dot = s.indexOf('.');
    return dot < 0 ? 0 : s.length - dot - 1;
}

function formatValue(def, value) {
    if (def.format) return def.format(value);
    if (def.type === 'range') return Number(value).toFixed(decimals(def.step ?? 1));
    return String(value);
}

function normalizeOption(opt) {
    return (opt !== null && typeof opt === 'object') ? opt : { value: opt, label: String(opt) };
}

export function buildParamPanel(container, defs, values, onChange) {
    container.replaceChildren();

    for (const def of defs) {
        const row = document.createElement('label');
        row.className = 'param';

        const head = document.createElement('span');
        head.className = 'param-head';
        const name = document.createElement('span');
        name.textContent = def.label;
        const out = document.createElement('output');
        head.append(name, out);

        let control;
        const value = values[def.key];

        if (def.type === 'range') {
            control = document.createElement('input');
            control.type = 'range';
            control.min = def.min;
            control.max = def.max;
            control.step = def.step ?? 1;
            control.value = value;
            out.textContent = formatValue(def, value);
            // 作り直しが必要な項目は、つまみを離したときだけ反映する
            control.addEventListener('input', () => {
                out.textContent = formatValue(def, Number(control.value));
                if (!def.reset) onChange(def, Number(control.value));
            });
            if (def.reset) control.addEventListener('change', () => onChange(def, Number(control.value)));
        } else if (def.type === 'select') {
            control = document.createElement('select');
            const options = def.options.map(normalizeOption);
            options.forEach((opt, i) => {
                const o = document.createElement('option');
                o.value = String(i);
                o.textContent = opt.label;
                if (opt.value === value) o.selected = true;
                control.append(o);
            });
            control.addEventListener('change', () => onChange(def, options[Number(control.value)].value));
        } else if (def.type === 'checkbox') {
            control = document.createElement('input');
            control.type = 'checkbox';
            control.checked = Boolean(value);
            row.classList.add('param-checkbox');
            control.addEventListener('change', () => onChange(def, control.checked));
        } else {
            console.warn('未対応のパラメータ type:', def.type);
            continue;
        }

        row.append(head, control);
        container.append(row);
    }
}
