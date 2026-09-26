// Vanilla-TS interactivity for the price-history chart island.
// The SVG itself is rendered server-side (build time) in PriceChart.astro;
// this script only wires up the hover/focus tooltip and keeps it positioned.
// See docs/chart-spec.md "Interaction".

function formatDateLabel(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${iso}T00:00:00Z`));
}

function formatPriceLabel(price: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(price);
}

function buildTooltipContent(dot: HTMLElement): DocumentFragment {
  const frag = document.createDocumentFragment();
  const date = dot.dataset.date ?? '';
  const price = Number(dot.dataset.price ?? '0');
  const qty = dot.dataset.qty;
  const supplier = dot.dataset.supplier || 'Unknown supplier';
  const cage = dot.dataset.cage;
  const agency = dot.dataset.agency || 'Unknown agency';
  const spike = dot.dataset.spike;

  const dateEl = document.createElement('div');
  dateEl.textContent = formatDateLabel(date);
  frag.appendChild(dateEl);

  const priceEl = document.createElement('div');
  priceEl.className = 'tt-price';
  priceEl.textContent = qty ? `${formatPriceLabel(price)} × ${qty} units` : formatPriceLabel(price);
  frag.appendChild(priceEl);

  const supplierEl = document.createElement('div');
  supplierEl.textContent = cage ? `${supplier} (CAGE ${cage})` : supplier;
  frag.appendChild(supplierEl);

  const agencyEl = document.createElement('div');
  agencyEl.textContent = agency;
  frag.appendChild(agencyEl);

  if (spike) {
    const spikeEl = document.createElement('div');
    spikeEl.style.color = 'var(--red)';
    spikeEl.textContent = `${Number(spike).toFixed(1)}× trailing median`;
    frag.appendChild(spikeEl);
  }

  const linkEl = document.createElement('div');
  linkEl.className = 'tt-link';
  linkEl.textContent = 'View government record →';
  frag.appendChild(linkEl);

  return frag;
}

function positionTooltip(tooltip: HTMLElement, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  const ttRect = tooltip.getBoundingClientRect();
  let top = rect.top - ttRect.height - 10;
  if (top < 8) top = rect.bottom + 10;
  let left = rect.left + rect.width / 2 - ttRect.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - ttRect.width - 8));
  tooltip.style.top = `${top}px`;
  tooltip.style.left = `${left}px`;
}

function initChart(chart: HTMLElement): void {
  const tooltip = chart.querySelector<HTMLElement>('[data-tooltip]');
  if (!tooltip) return;
  const dots = chart.querySelectorAll<HTMLElement>('.price-dot');

  const show = (dot: HTMLElement) => {
    tooltip.replaceChildren(buildTooltipContent(dot));
    tooltip.classList.add('visible');
    positionTooltip(tooltip, dot);
  };
  const hide = () => {
    tooltip.classList.remove('visible');
  };

  dots.forEach((dot) => {
    dot.addEventListener('mouseenter', () => show(dot));
    dot.addEventListener('mouseleave', hide);
    dot.addEventListener('focus', () => show(dot));
    dot.addEventListener('blur', hide);
  });
}

function init(): void {
  document.querySelectorAll<HTMLElement>('.price-chart[data-chart-root]').forEach(initChart);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
