/**
 * Minimal SVG bar chart: one series, magnitude on the y-axis.
 *
 * Single-hue blue (the sequential role), thin marks with rounded data-ends
 * anchored to the baseline, a surface gap between bars, recessive grid, and a
 * hover tooltip on every mark. Rendered in real pixel units and re-rendered on
 * resize, so labels never stretch.
 */

const NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/** Rounded-top bar path, flat against the baseline. */
function barPath(x, y, w, h, r) {
  if (h <= 0.5) return `M${x},${y + h} L${x},${y} L${x + w},${y} L${x + w},${y + h} Z`;
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h} Z`;
}

function niceTicks(max, count = 4) {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || mag * 10;
  const ticks = [];
  for (let v = 0; v < max - 1e-9; v += step) ticks.push(Number(v.toFixed(6)));
  // The top tick must sit at or above the tallest bar, or bars overflow the plot.
  ticks.push(Number((Math.ceil(max / step) * step).toFixed(6)));
  return ticks;
}

/**
 * @param {HTMLElement} container
 * @param {Array<{label: string|number, value: number, tip?: string, dim?: boolean}>} data
 * @param {object} opts
 */
export function barChart(container, data, opts = {}) {
  container._chartState = { data, opts };

  if (!container._chartObserver) {
    let last = -1;
    const ro = new ResizeObserver(() => {
      const w = container.clientWidth;
      if (w > 0 && Math.abs(w - last) > 4) {
        last = w;
        render(container);
      }
    });
    ro.observe(container);
    container._chartObserver = ro;
  }

  // A hidden panel measures 0 wide; rendering there would bake in a bogus
  // geometry. The observer fires as soon as the panel is shown.
  if (container.clientWidth > 0) render(container);
}

function render(container) {
  const { data, opts } = container._chartState;
  const {
    height = 200,
    valueFormat = (v) => String(v),
    emptyText = 'No data',
    ariaLabel = 'bar chart',
  } = opts;

  container.classList.add('chart');
  container.innerHTML = '';

  if (!data.length) {
    container.innerHTML = `<p class="muted" style="padding:24px 0;text-align:center">${emptyText}</p>`;
    return;
  }

  const W = Math.max(280, container.clientWidth);
  const padL = 40;
  const padR = 8;
  const padT = 10;
  const padB = 22;
  const plotW = W - padL - padR;
  const plotH = height - padT - padB;

  const maxVal = Math.max(...data.map((d) => d.value), 0);
  const ticks = niceTicks(maxVal);
  const top = ticks[ticks.length - 1] || 1;
  const yOf = (v) => padT + plotH - (v / top) * plotH;
  const y0 = yOf(0);

  const slot = plotW / data.length;
  const gap = Math.max(2, Math.min(5, slot * 0.22));
  const barW = Math.max(1.5, slot - gap);

  const svg = el('svg', {
    width: W,
    height,
    viewBox: `0 0 ${W} ${height}`,
    role: 'img',
    'aria-label': ariaLabel,
  });

  for (const t of ticks) {
    const y = yOf(t);
    svg.append(el('line', { class: 'grid-line', x1: padL, x2: W - padR, y1: y, y2: y }));
    const lbl = el('text', { x: padL - 6, y: y + 3.5, 'text-anchor': 'end' });
    lbl.textContent = valueFormat(t);
    svg.append(lbl);
  }
  svg.append(el('line', { class: 'axis-line', x1: padL, x2: W - padR, y1: y0, y2: y0 }));

  const every = Math.max(1, Math.ceil(data.length / Math.floor(plotW / 26)));

  const tip = document.createElement('div');
  tip.className = 'tooltip';

  data.forEach((d, i) => {
    const x = padL + i * slot + gap / 2;
    const y = yOf(d.value);
    const h = y0 - y;

    const bar = el('path', { class: d.dim ? 'bar dim' : 'bar', d: barPath(x, y, barW, h, 4) });
    svg.append(bar);

    const hit = el('rect', { class: 'hit', x: padL + i * slot, y: padT, width: slot, height: plotH });
    const show = () => {
      bar.classList.add('hover');
      tip.innerHTML = d.tip || `<b>${d.label}</b> &middot; ${valueFormat(d.value)}`;
      tip.classList.add('show');
      const cx = padL + i * slot + slot / 2;
      tip.style.left = `${Math.max(70, Math.min(W - 70, cx))}px`;
      tip.style.top = `${y}px`;
    };
    const hide = () => {
      bar.classList.remove('hover');
      tip.classList.remove('show');
    };
    hit.addEventListener('pointerenter', show);
    hit.addEventListener('pointerleave', hide);
    svg.append(hit);

    if (i % every === 0 || data.length <= 16) {
      const lbl = el('text', { x: padL + i * slot + slot / 2, y: height - 6, 'text-anchor': 'middle' });
      lbl.textContent = d.label;
      svg.append(lbl);
    }
  });

  container.append(svg, tip);
}
