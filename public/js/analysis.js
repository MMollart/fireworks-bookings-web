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
    performanceId: '',
    mode: 'sales',
    visible: null, // 'analysis' | 'discounts'
    req: { sales: 0, compare: 0, discounts: 0 },
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
    const text = measure === 'gross' || measure === 'net' ? moneyCell(side[measure], currency) : esc(num(side[measure]));
    return side.coverage === 'partial' ? `${text} <span class="partial-tag" title="The download of this period is incomplete">partial</span>` : text;
  }

  function numericValue(measure, side, currency) {
    if (!side || side.coverage === 'none') return null;
    const v = side[measure];
    if (v === null || v === undefined) return null;
    if (measure === 'gross' || measure === 'net') return v[currency] ?? 0;
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

  function renderChart(container, { labels, series, format, title }) {
    const W = 920, H = 320, L = 64, R = 12, T = 12, B = 72;
    const plotW = W - L - R, plotH = H - T - B;
    const all = series.flatMap((s) => s.values).filter((v) => v !== null);
    const max = niceMax(Math.max(0, ...all));
    const n = labels.length;
    const groupW = plotW / Math.max(1, n);
    const k = series.length;
    const barW = Math.max(1, (groupW * 0.78) / k);
    const y = (v) => T + plotH - (v / max) * plotH;

    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}" class="chart">`;
    svg += `<defs><pattern id="nodata" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="3" height="6" fill="#d9cfe3"/></pattern></defs>`;
    for (let i = 0; i <= 4; i++) {
      const v = (max / 4) * i;
      svg += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#d9cfe3" stroke-width="1"/>`;
      svg += `<text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="#5c5558">${esc(format(v))}</text>`;
    }
    const step = Math.max(1, Math.ceil(n / 14));
    labels.forEach((label, i) => {
      const gx = L + i * groupW;
      series.forEach((s, j) => {
        const v = s.values[i];
        const x = gx + (groupW - barW * k) / 2 + j * barW;
        if (v === null) {
          svg += `<rect x="${x}" y="${T}" width="${Math.max(1, barW - 1)}" height="${plotH}" fill="url(#nodata)" opacity="0.7"><title>${esc(label)} - ${esc(s.name)}: No data (not downloaded)</title></rect>`;
        } else {
          const h = Math.max(v === 0 ? 0 : 1, (v / max) * plotH);
          svg += `<rect x="${x}" y="${T + plotH - h}" width="${Math.max(1, barW - 1)}" height="${h}" fill="${s.color}"><title>${esc(label)} - ${esc(s.name)}: ${esc(format(v))}</title></rect>`;
        }
      });
      if (i % step === 0) {
        svg += `<text transform="translate(${gx + groupW / 2},${H - B + 14}) rotate(-35)" text-anchor="end" font-size="11" fill="#5c5558">${esc(label.length > 24 ? `${label.slice(0, 23)}…` : label)}</text>`;
      }
    });
    svg += `<line x1="${L}" x2="${W - R}" y1="${T + plotH}" y2="${T + plotH}" stroke="#8a7a99"/></svg>`;

    const legend = series
      .map((s) => `<span class="legend-item"><span class="legend-swatch" style="background:${s.color}"></span>${esc(s.name)}</span>`)
      .join('');
    container.innerHTML = `${svg}<div class="legend">${legend}<span class="legend-item"><span class="legend-swatch legend-nodata"></span>No data</span></div>`;
  }

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
      state.performanceId = '';
    }
    for (const id of ['analysisEvent', 'discountEvent']) {
      fillEventSelect($(id), events, state.eventId);
      $(id).disabled = events.length === 0;
    }
    const ev = (state.options?.events || []).find((e) => e.id === state.eventId);
    const perfOptions =
      '<option value="">All performances</option>' +
      (ev?.performances || []).map((p) => `<option value="${esc(p.id)}">${esc(dateOnly(p.starts_at))}${p.complete ? '' : ' (incomplete download)'}</option>`).join('');
    for (const id of ['analysisPerformance', 'discountPerformance']) {
      $(id).innerHTML = perfOptions;
      $(id).value = state.performanceId;
      $(id).disabled = !ev;
    }
    const others = events.filter((e) => e.id !== state.eventId);
    const prev = $('compareEvent').value;
    fillEventSelect($('compareEvent'), others, prev);
  }

  function scopeQuery() {
    const q = new URLSearchParams({ eventId: state.eventId });
    if (state.performanceId) q.set('performanceId', state.performanceId);
    return q;
  }

  async function loadOptions() {
    state.options = await getJson('/api/analysis/options');
    syncSelectors();
  }

  function setupEmpty() {
    return !state.options || !state.options.hasDownloadedBookings || !state.eventId;
  }

  // ---------- sales over time ----------
  const MEASURE_LABEL = { tickets: 'Active tickets', bookings: 'Total bookings', gross: 'Gross revenue', net: 'Net revenue' };

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
    setStatus('analysisStatus', 'loading', kind === 'compare' ? 'Loading comparison…' : 'Loading analysis…');
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
    note.push('Bookings are placed by their original creation date, but show their current tickets and financial status (not figures as at that date).');
    notices(note);

    // totals
    const t = data.totals;
    $('analysisTotals').innerHTML = [
      ['Active tickets', esc(num(t.tickets))],
      ['Total bookings', esc(num(t.bookings))],
      ['Gross revenue', moneyCell(t.gross)],
      ['Net revenue', moneyCell(t.net)],
    ].map(([label, value]) => `<div class="kpi-card"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div><div class="kpi-sub">Whole event${data.undated ? ' (includes undated bookings)' : ''}</div></div>`).join('');

    // chart
    const rows = data.rows;
    const fmt = measure === 'gross' || measure === 'net' ? (v) => money(currency, v) : (v) => num(v);
    $('analysisChartTitle').textContent = `${MEASURE_LABEL[measure]}${data.group === 'whole' ? '' : ` by ${data.group === 'daily' ? 'day' : data.group === 'weekly' ? 'week' : 'month'}`}`;
    renderChart($('analysisChart'), {
      title: `${MEASURE_LABEL[measure]} chart`,
      labels: rows.map((r) => r.label.replace(/^Week of /, '')),
      series: [{ name: MEASURE_LABEL[measure], color: '#4d2176', values: rows.map((r) => numericValue(measure, r, currency)) }],
      format: fmt,
    });

    // table
    $('analysisTable').querySelector('thead').innerHTML = '<tr><th>Period</th><th>Active tickets</th><th>Total bookings</th><th>Gross revenue</th><th>Net revenue</th></tr>';
    const body = rows
      .map((r) => `<tr><td>${esc(r.label)}</td><td>${valueCell('tickets', r)}</td><td>${valueCell('bookings', r)}</td><td>${valueCell('gross', r)}</td><td>${valueCell('net', r)}</td></tr>`)
      .join('');
    const total = `<tr class="total-row"><td>Whole event total</td><td>${esc(num(t.tickets))}</td><td>${esc(num(t.bookings))}</td><td>${moneyCell(t.gross)}</td><td>${moneyCell(t.net)}</td></tr>`;
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
      if ($('compareAverage').checked) q.set('average', '1');
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
      { name: sel, color: '#4d2176', values: data.rows.map((r) => numericValue(measure, r.selected, currency)) },
      { name: cmp, color: '#e1a313', values: data.rows.map((r) => numericValue(measure, r.comparison, currency)) },
    ];
    if (data.includeAverage) series.push({ name: `Average of ${data.averageEvents} events`, color: '#8a7a99', values: data.rows.map((r) => numericValue(measure, r.average, currency)) });
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
        if (state.performanceId) q.set('performanceId', state.performanceId);
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
    return state.mode === 'sales' ? loadSales() : loadCompare();
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
    reload();
  }

  function onScopeChange(source) {
    if (source === 'event') {
      state.eventId = $(state.visible === 'discounts' ? 'discountEvent' : 'analysisEvent').value;
      state.performanceId = '';
    } else {
      state.performanceId = $(state.visible === 'discounts' ? 'discountPerformance' : 'analysisPerformance').value;
    }
    syncSelectors();
    reload();
  }

  function daysUntilPerformance() {
    const ev = (state.options?.events || []).find((e) => e.id === state.eventId);
    if (!ev) return null;
    const perfs = ev.performances.filter((p) => p.starts_at && (!state.performanceId || p.id === state.performanceId));
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
    $('analysisEvent').addEventListener('change', () => onScopeChange('event'));
    $('discountEvent').addEventListener('change', () => onScopeChange('event'));
    $('analysisPerformance').addEventListener('change', () => onScopeChange('performance'));
    $('discountPerformance').addEventListener('change', () => onScopeChange('performance'));
    document.querySelectorAll('.mode-btn').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

    // data-affecting controls reload; presentation-only controls (measure, currency) re-render from a fresh request
    ['salesGroup', 'salesMeasure', 'salesCurrency'].forEach((id) => $(id).addEventListener('change', loadSales));
    ['compareEvent', 'compareGroup', 'compareMeasure', 'compareCurrency', 'compareCutoff', 'compareAverage'].forEach((id) => $(id).addEventListener('change', loadCompare));
    $('compareCutoffToday').addEventListener('click', () => {
      const d = daysUntilPerformance();
      if (d === null) {
        window.alert('The selected performance has already happened, so there is no "today" point to compare to. Leave the field empty to compare all sales.');
        return;
      }
      $('compareCutoff').value = String(d);
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
