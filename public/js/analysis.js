/**
 * Analysis (sales over time, compare events) and Discount Codes views.
 * All numbers come from /api/analysis/*, which derives them from the locally stored TicketSource download.
 * Every request is tagged; a response that arrives after the scope changed is discarded so stale results never show.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (v) =>
    String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');

  const state = {
    options: null,
    eventId: '',
    mode: 'compare',
    cutoffFollowsToday: true, // the sales-to-date cutoff tracks the selected event's "today" point until the user edits it
    visible: null, // 'analysis' | 'discounts'
    req: { sales: 0, compare: 0, years: 0, discounts: 0 },
  };

  const SETUP_MESSAGE =
    'No events have been downloaded yet. Open Events, choose "Retrieve events from TicketSource", then download an event\'s bookings from the TicketSource tab.';

  // ---------- formatting ----------
  const num = (n) => Number(n).toLocaleString('en-GB', { maximumFractionDigits: 2 });
  const money = (cur, v) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: cur }).format(v);
  const NO_DATA = '<span class="no-data" title="Not downloaded: this is not the same as zero">No data</span>';
  const UNKNOWN = '<span class="no-data" title="TicketSource did not supply an amount: this is not the same as zero">Unknown</span>';

  function moneyCell(map, onlyCurrency) {
    if (map === null || map === undefined) return NO_DATA;
    const entries = Object.entries(map).filter(([c]) => !onlyCurrency || c === onlyCurrency);
    if (entries.length === 0) return onlyCurrency ? money(onlyCurrency, 0) : '£0.00';
    return entries.map(([c, v]) => esc(money(c, v))).join('<br>');
  }

  function valueCell(measure, side, currency) {
    if (!side || side.coverage === 'none' || side[measure] === null || side[measure] === undefined) return NO_DATA;
    const text = MONEY_MEASURES.includes(measure) ? moneyCell(side[measure], currency) : esc(num(side[measure]));
    return side.coverage === 'partial' ? `${text} <span class="partial-tag" title="The download of this period is incomplete">partial</span>` : text;
  }

  function numericValue(measure, side, currency) {
    if (!side || side.coverage === 'none') return null;
    const v = side[measure];
    if (v === null || v === undefined) return null;
    if (MONEY_MEASURES.includes(measure)) return v[currency] ?? 0;
    return v;
  }

  async function getJson(url) {
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.message || `Request failed (${res.status})`);
    return data;
  }

  // ---------- status boxes ----------
  function setStatus(id, kind, message, retry) {
    const box = $(id);
    box.className = `status-box status-${kind}`;
    box.hidden = false;
    box.innerHTML = `<span>${esc(message)}</span>${retry ? ' <button class="btn btn-secondary btn-sm" data-retry="1">Try again</button>' : ''}`;
    if (retry) box.querySelector('[data-retry]').addEventListener('click', retry);
  }
  function clearStatus(id) {
    const box = $(id);
    box.hidden = true;
    box.innerHTML = '';
    box.className = 'status-box';
  }

  // ---------- chart (inline SVG, no dependencies) ----------
  function niceMax(v) {
    if (v <= 0) return 1;
    const pow = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= v) return m * pow;
    return 10 * pow;
  }

  // Design system colours: the selected event is spark orange, comparison is night purple.
  const COLOR = { selected: '#ed5202', comparison: '#4d2176', average: '#8a7a99' };
  const MAX_BAR_CATEGORIES = 6; // more date-based categories than this are drawn as a line

  let lastChart = null;

  function renderChart(container, opts) {
    lastChart = { container, opts };
    draw(container, opts);
  }

  function draw(container, { labels, series, format, title, forceBar = false, legend: legendItems = null }) {
    const W = Math.max(280, Math.floor(container.getBoundingClientRect().width || container.parentElement?.getBoundingClientRect().width || 640));
    const narrow = W < 520;
    const H = narrow ? 300 : 340;
    const L = narrow ? 52 : 64, R = 14, T = 14, B = narrow ? 84 : 76;
    const plotW = W - L - R, plotH = H - T - B;
    const all = series.flatMap((s) => s.values).filter((v) => v !== null);
    const max = niceMax(Math.max(0, ...all));
    const n = labels.length;
    const asLine = !forceBar && n > MAX_BAR_CATEGORIES;
    const y = (v) => T + plotH - (v / max) * plotH;
    const slot = plotW / Math.max(1, n); // one category's width (bars) / spacing basis (labels)
    const xCentre = (i) => (asLine ? (n === 1 ? L + plotW / 2 : L + (i * plotW) / (n - 1)) : L + i * slot + slot / 2);
    const fontSize = narrow ? 12 : 12;

    let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}" class="chart">`;
    svg += `<defs><pattern id="nodata" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="3" height="6" fill="#d9cfe3"/></pattern></defs>`;
    for (let i = 0; i <= 4; i++) {
      const v = (max / 4) * i;
      svg += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#d9cfe3" stroke-width="1"/>`;
      svg += `<text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" font-size="${fontSize}" fill="#5c5558">${esc(format(v))}</text>`;
    }

    // no-data spans (not downloaded: shown hatched, never as zero)
    const spanW = asLine ? plotW / Math.max(1, n - 1) : slot;
    labels.forEach((label, i) => {
      if (series.some((s) => s.values[i] === null)) {
        svg += `<rect x="${xCentre(i) - spanW / 2}" y="${T}" width="${spanW}" height="${plotH}" fill="url(#nodata)" opacity="0.6"><title>${esc(label)}: No data (not downloaded)</title></rect>`;
      }
    });

    if (asLine) {
      series.forEach((s) => {
        const segments = [];
        let cur = [];
        s.values.forEach((v, i) => {
          if (v === null) { if (cur.length) segments.push(cur); cur = []; } else cur.push([xCentre(i), y(v)]);
        });
        if (cur.length) segments.push(cur);
        for (const seg of segments) {
          if (series.length === 1 && seg.length > 1) {
            svg += `<path d="M${seg[0][0]},${T + plotH} ${seg.map((p) => `L${p[0]},${p[1]}`).join(' ')} L${seg[seg.length - 1][0]},${T + plotH} Z" fill="${s.color}" opacity="0.12"/>`;
          }
          svg += `<path d="${seg.map((p, k) => `${k ? 'L' : 'M'}${p[0]},${p[1]}`).join(' ')}" fill="none" stroke="${s.color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
          if (seg.length === 1) svg += `<circle cx="${seg[0][0]}" cy="${seg[0][1]}" r="3.5" fill="${s.color}"/>`;
        }
      });
    } else {
      const k = series.length;
      const barW = Math.min(72, (slot * 0.7) / k);
      labels.forEach((label, i) => {
        series.forEach((s, j) => {
          const v = s.values[i];
          if (v === null) return;
          const x = xCentre(i) - (barW * k) / 2 + j * barW;
          const h = Math.max(v === 0 ? 0 : 1, (v / max) * plotH);
          svg += `<rect x="${x}" y="${T + plotH - h}" width="${Math.max(1, barW - 2)}" height="${h}" fill="${s.colors ? s.colors[i] : s.color}"><title>${esc(label)} - ${esc(s.name)}: ${esc(format(v))}</title></rect>`;
        });
      });
    }

    // x labels, thinned so they never overlap
    const labelStep = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 54))));
    labels.forEach((label, i) => {
      if (i % labelStep !== 0 && i !== n - 1) return;
      if (i !== n - 1 && n - 1 - i < labelStep / 2) return;
      svg += `<text transform="translate(${xCentre(i)},${T + plotH + 14}) rotate(-40)" text-anchor="end" font-size="${fontSize}" fill="#5c5558">${esc(label.length > 22 ? `${label.slice(0, 21)}…` : label)}</text>`;
    });
    svg += `<line x1="${L}" x2="${W - R}" y1="${T + plotH}" y2="${T + plotH}" stroke="#8a7a99"/>`;
    svg += `<line class="chart-marker" x1="0" x2="0" y1="${T}" y2="${T + plotH}" stroke="#231f20" stroke-width="1" stroke-dasharray="3 3" visibility="hidden"/>`;
    svg += `<rect class="chart-hit" x="${L}" y="${T}" width="${plotW}" height="${plotH}" fill="transparent"/></svg>`;

    const legend = (legendItems || series)
      .map((s) => `<span class="legend-item"><span class="legend-swatch" style="background:${s.color}"></span>${esc(s.name)}</span>`)
      .join('');
    container.innerHTML = `<div class="chart-readout" role="status" aria-live="polite">Tap or hover the chart to read values</div>${svg}<div class="legend">${legend}<span class="legend-item"><span class="legend-swatch legend-nodata"></span>No data</span></div>`;

    // Touch / mouse readout (a tooltip needs hover, which phones do not have)
    const hit = container.querySelector('.chart-hit');
    const marker = container.querySelector('.chart-marker');
    const readout = container.querySelector('.chart-readout');
    const show = (ev) => {
      const box = hit.getBoundingClientRect();
      const px = ev.clientX - box.left;
      const i = Math.max(0, Math.min(n - 1, asLine ? Math.round((px / plotW) * (n - 1)) : Math.floor(px / slot)));
      marker.setAttribute('x1', xCentre(i));
      marker.setAttribute('x2', xCentre(i));
      marker.setAttribute('visibility', 'visible');
      readout.innerHTML = `<strong>${esc(labels[i])}</strong>: ${series
        .map((s) => `<span class="readout-item"><span class="legend-swatch" style="background:${s.color}"></span>${esc(s.name)} ${s.values[i] === null ? 'No data' : esc(format(s.values[i]))}</span>`)
        .join(' ')}`;
    };
    hit.addEventListener('pointerdown', show);
    hit.addEventListener('pointermove', show);
  }

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (lastChart && document.body.contains(lastChart.container) && lastChart.container.offsetParent !== null) draw(lastChart.container, lastChart.opts);
    }, 150);
  });

  // ---------- shared scope ----------
  const dateOnly = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric' }) : 'date unknown');

  function eventsWithBookings() {
    return (state.options?.events || []).filter((e) => e.bookings > 0);
  }

  function fillEventSelect(sel, events, value) {
    sel.innerHTML = events.map((e) => `<option value="${esc(e.id)}">${esc(e.name || e.id)}</option>`).join('');
    if (events.some((e) => e.id === value)) sel.value = value;
  }

  function syncSelectors() {
    const events = eventsWithBookings();
    if (!events.some((e) => e.id === state.eventId)) {
      state.eventId = events[0]?.id || '';
    }
    for (const id of ['analysisEvent', 'discountEvent']) {
      fillEventSelect($(id), events, state.eventId);
      $(id).disabled = events.length === 0;
    }
    const others = events.filter((e) => e.id !== state.eventId);
    const prev = $('compareEvent').value;
    fillEventSelect($('compareEvent'), others, prev);
    if (others.length) $('compareEvent').insertAdjacentHTML('beforeend', '<option value="average">Average of all events</option>');
    if (prev === 'average' && others.length) $('compareEvent').value = 'average';
    if (state.cutoffFollowsToday) {
      const d = daysUntilPerformance();
      $('compareCutoff').value = d === null ? '' : String(d);
    }
  }

  function scopeQuery() {
    return new URLSearchParams({ eventId: state.eventId });
  }

  async function loadOptions() {
    state.options = await getJson('/api/analysis/options');
    syncSelectors();
  }

  function setupEmpty() {
    return !state.options || !state.options.hasDownloadedBookings || !state.eventId;
  }

  // ---------- sales over time ----------
  const MONEY_MEASURES = ['gross', 'net', 'donations'];
  const MEASURE_LABEL = { tickets: 'Active tickets', bookings: 'Total bookings', gross: 'Gross revenue', net: 'Net revenue', donations: 'Donations' };

  function currencySelector(sel, currencies) {
    const prev = sel.value;
    sel.innerHTML = currencies.map((c) => `<option>${esc(c)}</option>`).join('');
    sel.style.display = currencies.length > 1 ? '' : 'none';
    if (currencies.includes(prev)) sel.value = prev;
    return sel.value || currencies[0] || 'GBP';
  }

  function notices(html) {
    $('analysisNotices').innerHTML = html.map((n) => `<div class="notice">${n}</div>`).join('');
  }

  function showAnalysisLoading(kind) {
    $('analysisResults').style.display = 'none';
    notices([]);
    setStatus('analysisStatus', 'loading', kind === 'compare' ? 'Loading comparison…' : kind === 'years' ? 'Loading all years…' : 'Loading analysis…');
  }

  async function loadSales() {
    const id = ++state.req.sales;
    if (setupEmpty()) return showSetup('analysisStatus', 'analysisResults');
    showAnalysisLoading('sales');
    try {
      const q = scopeQuery();
      q.set('group', $('salesGroup').value);
      const data = await getJson(`/api/analysis/sales?${q}`);
      if (id !== state.req.sales || state.mode !== 'sales') return;
      renderSales(data);
    } catch (err) {
      if (id !== state.req.sales) return;
      $('analysisResults').style.display = 'none';
      setStatus('analysisStatus', 'error', `Could not load the analysis: ${err.message}`, loadSales);
    }
  }

  function showSetup(statusId, resultsId) {
    $(resultsId).style.display = 'none';
    if (statusId === 'analysisStatus') notices([]);
    setStatus(statusId, 'empty', SETUP_MESSAGE);
  }

  function renderSales(data) {
    if (!data.hasData) {
      $('analysisResults').style.display = 'none';
      notices([]);
      return setStatus(
        'analysisStatus',
        'empty',
        data.incompletePerformances
          ? 'No bookings have been downloaded for this selection yet, and its download is not complete. Download bookings from the TicketSource tab.'
          : 'This selection has no bookings.'
      );
    }
    clearStatus('analysisStatus');

    const currency = currencySelector($('salesCurrency'), data.currencies);
    const measure = $('salesMeasure').value;
    const note = [];
    if (data.incompletePerformances) {
      note.push(`${data.incompletePerformances} of ${data.performances} performance${data.performances === 1 ? '' : 's'} not fully downloaded. Values may be partial, and periods that were not downloaded show <strong>No data</strong>, not zero.`);
    }
    if (data.undated) {
      note.push(
        data.group === 'whole'
          ? `${data.undated} booking${data.undated === 1 ? ' has' : 's have'} no creation date. They are included in these whole-event totals but cannot be placed in daily, weekly or monthly rows.`
          : `${data.undated} booking${data.undated === 1 ? ' has' : 's have'} no creation date and ${data.undated === 1 ? 'is' : 'are'} not in the rows below. They are included in the whole-event totals.`
      );
    }
    note.push('Bookings are placed by their original creation date, but show their current tickets and financial status (not figures as at that date). Revenue excludes donations, which are shown separately.');
    notices(note);

    // totals
    const t = data.totals;
    $('analysisTotals').innerHTML = [
      ['Active tickets', esc(num(t.tickets))],
      ['Total bookings', esc(num(t.bookings))],
      ['Gross revenue', moneyCell(t.gross)],
      ['Net revenue', moneyCell(t.net)],
      ['Donations', moneyCell(t.donations)],
    ].map(([label, value]) => `<div class="kpi-card"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div><div class="kpi-sub">Whole event${data.undated ? ' (includes undated bookings)' : ''}</div></div>`).join('');

    $('analysisResults').style.display = '';

    // chart
    const rows = data.rows;
    const fmt = MONEY_MEASURES.includes(measure) ? (v) => money(currency, v) : (v) => num(v);
    $('analysisChartTitle').textContent = `${MEASURE_LABEL[measure]}${data.group === 'whole' ? '' : ` by ${data.group === 'daily' ? 'day' : data.group === 'weekly' ? 'week' : 'month'}`}`;
    renderChart($('analysisChart'), {
      title: `${MEASURE_LABEL[measure]} chart`,
      labels: rows.map((r) => r.label.replace(/^Week of /, '')),
      series: [{ name: MEASURE_LABEL[measure], color: COLOR.selected, values: rows.map((r) => numericValue(measure, r, currency)) }],
      format: fmt,
    });

    // table
    $('analysisTable').querySelector('thead').innerHTML = '<tr><th>Period</th><th>Active tickets</th><th>Total bookings</th><th>Gross revenue</th><th>Net revenue</th><th>Donations</th></tr>';
    const body = rows
      .map((r) => `<tr><td>${esc(r.label)}</td><td>${valueCell('tickets', r)}</td><td>${valueCell('bookings', r)}</td><td>${valueCell('gross', r)}</td><td>${valueCell('net', r)}</td><td>${valueCell('donations', r)}</td></tr>`)
      .join('');
    const total = `<tr class="total-row"><td>Whole event total</td><td>${esc(num(t.tickets))}</td><td>${esc(num(t.bookings))}</td><td>${moneyCell(t.gross)}</td><td>${moneyCell(t.net)}</td><td>${moneyCell(t.donations)}</td></tr>`;
    $('analysisTable').querySelector('tbody').innerHTML = body + (data.group === 'whole' ? '' : total);
    $('analysisResults').style.display = '';
  }

  // ---------- compare events ----------
  async function loadCompare() {
    const id = ++state.req.compare;
    if (setupEmpty()) return showSetup('analysisStatus', 'analysisResults');
    const other = $('compareEvent').value;
    if (!other) {
      $('analysisResults').style.display = 'none';
      notices([]);
      return setStatus('analysisStatus', 'empty', 'Download bookings for at least two events to compare them.');
    }
    showAnalysisLoading('compare');
    try {
      const q = scopeQuery();
      q.set('compareEventId', other);
      q.set('group', $('compareGroup').value);
      const cutoff = $('compareCutoff').value.trim();
      if (cutoff !== '') q.set('cutoff', cutoff);
      const versusAverage = other === 'average';
      $('compareAverageLabel').style.display = versusAverage ? 'none' : ''; // the average is already the comparison
      if (!versusAverage && $('compareAverage').checked) q.set('average', '1');
      const data = await getJson(`/api/analysis/compare?${q}`);
      if (id !== state.req.compare || state.mode !== 'compare') return;
      renderCompare(data);
    } catch (err) {
      if (id !== state.req.compare) return;
      $('analysisResults').style.display = 'none';
      setStatus('analysisStatus', 'error', `Could not load the comparison: ${err.message}`, loadCompare);
    }
  }

  function renderCompare(data) {
    clearStatus('analysisStatus');
    const currency = currencySelector($('compareCurrency'), data.currencies);
    const measure = $('compareMeasure').value;
    const sel = data.names.selected;
    const cmp = data.names.comparison;

    const note = [];
    if (data.excluded.total) {
      note.push(`${data.excluded.total} booking${data.excluded.total === 1 ? ' was' : 's were'} excluded because the creation date or the performance start date is missing (${esc(sel)}: ${data.excluded.selected}, ${esc(cmp)}: ${data.excluded.comparison}).`);
    }
    if (data.incomplete.selected || data.incomplete.comparison) {
      note.push(`Some performances are not fully downloaded (${esc(sel)}: ${data.incomplete.selected}, ${esc(cmp)}: ${data.incomplete.comparison}). Bands that were not downloaded show <strong>No data</strong>, not zero.`);
    }
    if (data.cutoff !== null) note.push(`Showing sales made at least ${data.cutoff} day${data.cutoff === 1 ? '' : 's'} before each performance.`);
    note.push('Bookings are aligned by the number of days between their creation date and their own performance start (Europe/London days).');
    notices(note);

    const card = (title, side, diff) => {
      const lines = (m) => (m === null ? NO_DATA : moneyCell(m));
      const d = diff ? (n) => (n > 0 ? `+${num(n)}` : num(n)) : null;
      return `<div class="kpi-card"><div class="kpi-label">${esc(title)}</div>
        <div class="kpi-sub">Active tickets: <strong>${d ? d(side.tickets) : esc(num(side.tickets))}</strong></div>
        <div class="kpi-sub">Bookings: <strong>${d ? d(side.bookings) : esc(num(side.bookings))}</strong></div>
        <div class="kpi-sub">Gross: <strong>${diff ? signedMoney(side.gross) : lines(side.gross)}</strong></div>
        <div class="kpi-sub">Net: <strong>${diff ? signedMoney(side.net) : lines(side.net)}</strong></div></div>`;
    };
    const signedMoney = (m) => Object.entries(m).map(([c, v]) => esc((v > 0 ? '+' : '') + money(c, v))).join('<br>') || '£0.00';
    $('analysisTotals').innerHTML =
      card(`${sel} (selected)`, data.totals.selected) +
      card(cmp, data.totals.comparison) +
      (data.totals.difference ? card('Difference (selected − comparison)', data.totals.difference, true) : '');

    const fmt = measure === 'gross' || measure === 'net' ? (v) => money(currency, v) : (v) => num(v);
    const series = [
      { name: sel, color: COLOR.selected, values: data.rows.map((r) => numericValue(measure, r.selected, currency)) },
      { name: cmp, color: COLOR.comparison, values: data.rows.map((r) => numericValue(measure, r.comparison, currency)) },
    ];
    if (data.includeAverage) series.push({ name: `Average of ${data.averageEvents} events`, color: COLOR.average, values: data.rows.map((r) => numericValue(measure, r.average, currency)) });
    $('analysisResults').style.display = '';
    $('analysisChartTitle').textContent = `${MEASURE_LABEL[measure]}: ${sel} vs ${cmp}`;
    renderChart($('analysisChart'), { title: `${MEASURE_LABEL[measure]} comparison chart`, labels: data.rows.map((r) => r.label), series, format: fmt });

    const diffCell = (r) => {
      if (!r.difference) return NO_DATA;
      const v = r.difference[measure];
      if (measure === 'gross' || measure === 'net') {
        const n = v[currency] ?? 0;
        return esc((n > 0 ? '+' : '') + money(currency, n));
      }
      return esc(v > 0 ? `+${num(v)}` : num(v));
    };
    $('analysisTable').querySelector('thead').innerHTML =
      `<tr><th>Days before performance</th><th>${esc(sel)}</th><th>${esc(cmp)}</th><th>Difference</th>${data.includeAverage ? `<th>Average (${data.averageEvents} events)</th>` : ''}</tr>`;
    $('analysisTable').querySelector('tbody').innerHTML = data.rows
      .map(
        (r) =>
          `<tr><td>${esc(r.label)}</td><td>${valueCell(measure, r.selected, currency)}</td><td>${valueCell(measure, r.comparison, currency)}</td><td>${diffCell(r)}</td>${
            data.includeAverage ? `<td>${r.average && r.average.coverage !== 'none' ? valueCell(measure, r.average, currency) : NO_DATA}</td>` : ''
          }</tr>`
      )
      .join('');
    $('analysisResults').style.display = '';
  }

  // ---------- all years ----------
  async function loadYears() {
    const id = ++state.req.years;
    if (setupEmpty()) return showSetup('analysisStatus', 'analysisResults');
    showAnalysisLoading('years');
    try {
      const q = scopeQuery();
      q.set('mode', $('yearsMode').value);
      const data = await getJson(`/api/analysis/years?${q}`);
      if (id !== state.req.years || state.mode !== 'years') return;
      renderYears(data);
    } catch (err) {
      if (id !== state.req.years) return;
      $('analysisResults').style.display = 'none';
      setStatus('analysisStatus', 'error', `Could not load the yearly comparison: ${err.message}`, loadYears);
    }
  }

  function renderYears(data) {
    clearStatus('analysisStatus');
    const currency = currencySelector($('yearsCurrency'), data.currencies);
    const measure = $('yearsMeasure').value;
    const selected = data.rows.find((r) => r.selected);

    const note = [];
    if (data.mode === 'equivalent') {
      note.push(
        data.equivalent
          ? `Showing sales made at least ${data.cutoff} day${data.cutoff === 1 ? '' : 's'} before each year's performance: the same point in the sales cycle as ${esc(selected?.label || 'the selected year')} is at today.`
          : `${esc(selected?.label || 'The selected year')}'s performance has already happened, so there is no equivalent date. All sales are shown.`
      );
    }
    const partial = data.rows.filter((r) => r.incomplete);
    if (partial.length) note.push(`The download is not complete for ${partial.map((r) => esc(r.label)).join(', ')}; those bars may be understated.`);
    const excluded = data.rows.reduce((n, r) => n + r.excluded, 0);
    if (data.mode === 'equivalent' && excluded) note.push(`${excluded} booking${excluded === 1 ? ' was' : 's were'} left out because the creation date or performance date is missing.`);
    note.push('Revenue excludes donations, which are shown separately. Years are the year of the performance, earliest to most recent.');
    notices(note);

    $('analysisTotals').innerHTML = '';
    $('analysisResults').style.display = '';
    const fmt = MONEY_MEASURES.includes(measure) ? (v) => money(currency, v) : (v) => num(v);
    $('analysisChartTitle').textContent = `${MEASURE_LABEL[measure]} by year${data.mode === 'equivalent' && data.equivalent ? ' (to the equivalent date)' : ''}`;
    const values = data.rows.map((r) => numericValue(measure, { coverage: 'complete', [measure]: r[measure] }, currency));
    renderChart($('analysisChart'), {
      title: `${MEASURE_LABEL[measure]} by year`,
      labels: data.rows.map((r) => r.label),
      forceBar: true,
      series: [{ name: MEASURE_LABEL[measure], color: COLOR.comparison, colors: data.rows.map((r) => (r.selected ? COLOR.selected : COLOR.comparison)), values }],
      legend: [{ name: 'Selected year', color: COLOR.selected }, { name: 'Other years', color: COLOR.comparison }],
      format: fmt,
    });

    $('analysisTable').querySelector('thead').innerHTML = '<tr><th>Year</th><th>Active tickets</th><th>Total bookings</th><th>Gross revenue</th><th>Net revenue</th><th>Donations</th></tr>';
    $('analysisTable').querySelector('tbody').innerHTML = data.rows
      .map((r) => {
        const tag = r.incomplete ? ' <span class="partial-tag" title="The download of this year is incomplete">partial</span>' : '';
        return `<tr${r.selected ? ' class="row-selected"' : ''}><td>${esc(r.label)}${tag}</td><td>${esc(num(r.tickets))}</td><td>${esc(num(r.bookings))}</td><td>${moneyCell(r.gross, currency)}</td><td>${moneyCell(r.net, currency)}</td><td>${moneyCell(r.donations, currency)}</td></tr>`;
      })
      .join('');
  }

  // ---------- discount codes ----------
  async function loadDiscounts() {
    const id = ++state.req.discounts;
    $('discountResults').style.display = 'none';
    const scope = $('discountScope').value;
    $('discountEventControls').style.display = scope === 'event' ? '' : 'none';
    if (!state.options?.hasDownloadedBookings || (scope === 'event' && !state.eventId)) return setStatus('discountStatus', 'empty', SETUP_MESSAGE);
    setStatus('discountStatus', 'loading', 'Loading discount codes…');
    try {
      const q = new URLSearchParams({ scope });
      if (scope === 'event') {
        q.set('eventId', state.eventId);
      }
      const data = await getJson(`/api/analysis/discounts?${q}`);
      if (id !== state.req.discounts) return;
      renderDiscounts(data);
    } catch (err) {
      if (id !== state.req.discounts) return;
      setStatus('discountStatus', 'error', `Could not load discount codes: ${err.message}`, loadDiscounts);
    }
  }

  function renderDiscounts(data) {
    if (data.state === 'no_bookings') return setStatus('discountStatus', 'empty', 'No bookings have been downloaded for this scope yet. Download bookings from the TicketSource tab.');
    if (data.state === 'empty') {
      return setStatus('discountStatus', 'empty', `No downloaded booking in this scope used a discount code (${data.bookingsInScope} booking${data.bookingsInScope === 1 ? '' : 's'} checked).${data.incompletePerformances ? ' Part of the download is incomplete.' : ''}`);
    }
    clearStatus('discountStatus');
    const multi = new Set(data.rows.map((r) => r.currency)).size > 1;
    const rows = data.rows
      .map((r) => {
        const total = r.total === null ? UNKNOWN : esc(money(r.currency, r.total));
        const notes = r.notes.length ? `<ul class="notes">${r.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : '<span class="muted">-</span>';
        return `<tr><td>${esc(r.yearLabel)}</td><td><code>${esc(r.code)}</code></td><td>${esc(num(r.uses))}</td><td>${total}${multi ? ` <small>${esc(r.currency)}</small>` : ''}</td><td>${notes}</td></tr>`;
      })
      .join('');
    $('discountTable').querySelector('tbody').innerHTML = rows;
    $('discountResults').style.display = '';
    if (data.incompletePerformances) {
      setStatus('discountStatus', 'warning', `${data.incompletePerformances} performance${data.incompletePerformances === 1 ? ' is' : 's are'} not fully downloaded, so uses and totals may be partial.`);
    }
  }

  // ---------- wiring ----------
  function reload() {
    if (state.visible === 'discounts') return loadDiscounts();
    return state.mode === 'sales' ? loadSales() : state.mode === 'compare' ? loadCompare() : loadYears();
  }

  function setMode(mode) {
    state.mode = mode;
    document.querySelectorAll('.mode-btn').forEach((b) => {
      const on = b.dataset.mode === mode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    });
    $('analysisSalesControls').style.display = mode === 'sales' ? '' : 'none';
    $('analysisCompareControls').style.display = mode === 'compare' ? '' : 'none';
    $('analysisYearsControls').style.display = mode === 'years' ? '' : 'none';
    reload();
  }

  function onScopeChange() {
    state.eventId = $(state.visible === 'discounts' ? 'discountEvent' : 'analysisEvent').value;
    syncSelectors();
    reload();
  }

  function daysUntilPerformance() {
    const ev = (state.options?.events || []).find((e) => e.id === state.eventId);
    if (!ev) return null;
    const perfs = ev.performances.filter((p) => p.starts_at);
    if (!perfs.length) return null;
    const dayNum = (d) => {
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
      return Date.UTC(p.year, p.month - 1, p.day) / 86400000;
    };
    const today = dayNum(new Date());
    const upcoming = perfs.map((p) => dayNum(new Date(p.starts_at))).filter((d) => d >= today).sort((a, b) => a - b);
    return upcoming.length ? upcoming[0] - today : null;
  }

  function init() {
    $('analysisEvent').addEventListener('change', onScopeChange);
    $('discountEvent').addEventListener('change', onScopeChange);
    document.querySelectorAll('.mode-btn').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

    // data-affecting controls reload; presentation-only controls (measure, currency) re-render from a fresh request
    ['salesGroup', 'salesMeasure', 'salesCurrency'].forEach((id) => $(id).addEventListener('change', loadSales));
    ['yearsMeasure', 'yearsMode', 'yearsCurrency'].forEach((id) => $(id).addEventListener('change', loadYears));
    ['compareEvent', 'compareGroup', 'compareMeasure', 'compareCurrency', 'compareCutoff', 'compareAverage'].forEach((id) => $(id).addEventListener('change', loadCompare));
    $('compareCutoff').addEventListener('input', () => { state.cutoffFollowsToday = false; });
    $('compareCutoffToday').addEventListener('click', () => {
      const d = daysUntilPerformance();
      if (d === null) {
        window.alert('The selected performance has already happened, so there is no "today" point to compare to. Leave the field empty to compare all sales.');
        return;
      }
      $('compareCutoff').value = String(d);
      state.cutoffFollowsToday = true;
      loadCompare();
    });
    $('discountScope').addEventListener('change', loadDiscounts);
  }

  async function show(tab) {
    state.visible = tab;
    const statusId = tab === 'discounts' ? 'discountStatus' : 'analysisStatus';
    setStatus(statusId, 'loading', 'Loading…');
    try {
      await loadOptions();
    } catch (err) {
      return setStatus(statusId, 'error', `Could not load events: ${err.message}`, () => show(tab));
    }
    reload();
  }

  document.addEventListener('DOMContentLoaded', init);
  window.FWAnalysis = { show };
})();
