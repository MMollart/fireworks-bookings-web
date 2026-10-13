/**
 * Fireworks Bookings - Main Client Application
 * Modeled on the Scout Budget application pattern.
 */

document.addEventListener('DOMContentLoaded', async () => {
  let currentUser = null;
  let allEvents = [];

  // ----------------------------------------------------
  // Toast notifications
  // ----------------------------------------------------
  function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  // ----------------------------------------------------
  // Helpers
  // ----------------------------------------------------
  function formatCurrency(val) {
    const num = Number(val) || 0;
    return `£${num.toFixed(2)}`;
  }

  function formatDate(val) {
    if (!val) return '—';
    try {
      const d = new Date(val);
      return d.toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch {
      return val;
    }
  }

  function getStatusBadge(status) {
    const map = {
      confirmed: 'badge-success',
      active: 'badge-success',
      checked_in: 'badge-success',
      completed: 'badge-success',
      pending: 'badge-warning',
      draft: 'badge-neutral',
      disabled: 'badge-danger',
      cancelled: 'badge-danger',
      refunded: 'badge-danger',
      error: 'badge-danger',
    };
    const cls = map[status] || 'badge-neutral';
    return `<span class="badge ${cls}">${escapeHtml(status)}</span>`;
  }

  // ----------------------------------------------------
  // Modal Utilities
  // ----------------------------------------------------
  function openModal(modalId) {
    const m = document.getElementById(modalId);
    if (m) m.classList.add('active');
  }

  function closeModal(modalId) {
    const m = document.getElementById(modalId);
    if (m) m.classList.remove('active');
  }

  document.querySelectorAll('.close-modal').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active'));
    });
  });

  window.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-overlay')) {
      e.target.classList.remove('active');
    }
  });

  // ----------------------------------------------------
  // Auth Check
  // ----------------------------------------------------
  async function checkAuth() {
    try {
      const res = await fetch('/api/auth/me');
      if (!res.ok) {
        window.location.href = '/login';
        return false;
      }
      const data = await res.json();
      currentUser = data.user;
      
      document.getElementById('navUsername').textContent = currentUser.username;
      const rolePill = document.getElementById('navRole');
      rolePill.textContent = currentUser.role;

      if (currentUser.role === 'admin') {
        document.getElementById('adminTab').style.display = 'inline-block';
        document.getElementById('configTab').style.display = 'inline-block';
      }

      return true;
    } catch {
      window.location.href = '/login';
      return false;
    }
  }

  // Logout
  document.getElementById('logoutBtn').addEventListener('click', async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // Continue redirect
    }
    window.location.href = '/login';
  });

  // ----------------------------------------------------
  // Tab Navigation
  // ----------------------------------------------------
  const tabs = document.querySelectorAll('.nav-tab');
  const sections = document.querySelectorAll('.page-section');

  tabs.forEach(tab => {
    tab.addEventListener('click', (e) => {
      e.preventDefault();
      const target = tab.dataset.tab;
      
      tabs.forEach(t => t.classList.remove('active'));
      sections.forEach(s => s.classList.remove('active'));

      tab.classList.add('active');
      const activeSection = document.getElementById(`section-${target}`);
      if (activeSection) {
        activeSection.classList.add('active');
        loadTabContent(target);
      }
    });
  });

  function loadTabContent(tab) {
    switch(tab) {
      case 'overview':
        loadDashboard();
        break;
      case 'events':
        loadTsEventsPanel();
        break;
      case 'bookings':
        loadEvents();
        loadBookings();
        break;
      case 'customers':
        loadCustomers();
        break;
      case 'reports':
        loadReports();
        break;
      case 'sync':
        loadSync();
        break;
      case 'analysis':
      case 'discounts':
        if (window.FWAnalysis) window.FWAnalysis.show(tab);
        break;
      case 'config':
        if (currentUser && currentUser.role === 'admin') {
          loadTicketTypes();
        }
        break;
      case 'admin':
        if (currentUser && currentUser.role === 'admin') {
          loadUsers();
        }
        break;
    }
  }

  // ----------------------------------------------------
  // 1. Dashboard / Overview
  // ----------------------------------------------------
  // The event is chosen here; the first load shows the latest event.
  let dashboardEventId = '';

  async function loadDashboard() {
    try {
      const res = await fetch(`/api/reports/dashboard${dashboardEventId ? `?eventId=${encodeURIComponent(dashboardEventId)}` : ''}`);
      if (!res.ok) return;
      const data = await res.json();

      const select = document.getElementById('dashboardEvent');
      const events = data.events || [];
      select.innerHTML = events.map(ev => `<option value="${escapeHtml(ev.id)}">${escapeHtml(ev.name)}</option>`).join('')
        || '<option value="">No events yet</option>';
      dashboardEventId = data.selectedEventId || '';
      select.value = dashboardEventId;
      select.disabled = !events.length;

      const rev = data.financials?.gross_revenue || 0;
      const disc = data.financials?.total_discounts || 0;
      const aov = data.financials?.aov || 0;
      const bCount = data.financials?.confirmed_bookings || 0;

      document.getElementById('kpiRevenue').textContent = formatCurrency(rev);
      document.getElementById('kpiDiscounts').textContent = `Discounts: ${formatCurrency(disc)}`;
      document.getElementById('kpiBookings').textContent = bCount;
      document.getElementById('kpiAov').textContent = `Average Order: ${formatCurrency(aov)}`;
      document.getElementById('kpiTickets').textContent = data.tickets?.tickets_sold || 0;
      document.getElementById('kpiTicketBreakdown').textContent =
        (data.tickets?.breakdown || []).slice(0, 4).map(t => `${t.ticket_type} ${t.count}`).join(' · ') || '\u00a0';
      document.getElementById('kpiCustomers').textContent = data.customers?.total || 0;

      renderOverviewEvents(events, dashboardEventId);
      renderOverviewBookings(data.recentBookings || []);
    } catch (err) {
      console.error('Error loading dashboard:', err);
    }
  }

  function renderOverviewEvents(events, selectedId) {
    const tbody = document.querySelector('#overviewEventsTable tbody');
    if (!events.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">No events yet. Use "Retrieve events from TicketSource" on the Events tab.</td></tr>';
      return;
    }

    tbody.innerHTML = events.map(ev => `
      <tr${ev.id === selectedId ? ' class="row-selected"' : ''}>
        <td><strong>${escapeHtml(ev.name)}</strong></td>
        <td>${formatDate(ev.starts_at)}</td>
        <td>${ev.bookings}</td>
        <td>${ev.tickets_sold}</td>
        <td>${formatCurrency(ev.gross_revenue || 0)}</td>
      </tr>
    `).join('');
  }

  function renderOverviewBookings(bookings) {
    const tbody = document.querySelector('#overviewRecentBookingsTable tbody');
    if (!bookings.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted);">No bookings found.</td></tr>';
      return;
    }

    tbody.innerHTML = bookings.map(b => `
      <tr>
        <td><code>${escapeHtml(b.reference)}</code></td>
        <td>${escapeHtml(b.event_name || '—')}</td>
        <td>${escapeHtml(b.customer_name || 'Guest')}</td>
        <td>${b.ticket_count || 0}</td>
        <td>${formatCurrency(b.total_price)}</td>
        <td>${formatDate(b.booking_date)}</td>
        <td>${getStatusBadge(b.status)}</td>
      </tr>
    `).join('');
  }

  document.getElementById('dashboardEvent').addEventListener('change', (e) => {
    dashboardEventId = e.target.value;
    loadDashboard();
  });

  document.getElementById('refreshDashboardBtn').addEventListener('click', () => {
    loadDashboard();
    showToast('Dashboard refreshed');
  });

  // ----------------------------------------------------
  // 2. Events (TicketSource events are listed by the TicketSource panel below)
  // ----------------------------------------------------
  async function loadEvents() {
    try {
      const res = await fetch('/api/events');
      if (!res.ok) return;
      allEvents = (await res.json()).events || [];
      const filter = document.getElementById('bookingEventFilter');
      if (filter) {
        const chosen = filter.value;
        filter.innerHTML = '<option value="">All Events</option>' + allEvents.map(e => `<option value="${escapeHtml(e.id)}">${escapeHtml(e.name)}</option>`).join('');
        filter.value = chosen;
      }
    } catch (err) {
      console.error('Error loading events:', err);
    }
  }

  // ----------------------------------------------------
  // 3. Bookings
  // ----------------------------------------------------
  let allBookings = [];

  async function loadBookings() {
    try {
      const search = document.getElementById('bookingSearchInput').value.trim();
      const status = document.getElementById('bookingStatusFilter').value;
      const eventId = document.getElementById('bookingEventFilter').value;

      let url = '/api/bookings?limit=100';
      if (search) url += `&search=${encodeURIComponent(search)}`;
      if (status) url += `&status=${encodeURIComponent(status)}`;
      if (eventId) url += `&event_id=${encodeURIComponent(eventId)}`;

      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      allBookings = data.bookings || [];
      document.getElementById('bookingSearchHint').hidden = !data.tooShort;

      const tbody = document.querySelector('#bookingsTable tbody');
      if (!allBookings.length) {
        tbody.innerHTML = '<tr><td colspan="10" style="text-align: center; color: var(--text-muted);">No bookings matching criteria.</td></tr>';
        return;
      }

      tbody.innerHTML = allBookings.map(b => `
        <tr>
          <td><code>${escapeHtml(b.reference)}</code></td>
          <td>${escapeHtml(b.event_name || '—')}</td>
          <td>${escapeHtml(b.customer_name || 'Guest')}</td>
          <td>${b.ticket_count || 0}</td>
          <td>${formatCurrency(b.subtotal)}</td>
          <td>${b.discount_amount > 0 ? `-${formatCurrency(b.discount_amount)}` : '£0.00'}</td>
          <td><strong>${formatCurrency(b.total_price)}</strong></td>
          <td><span class="badge badge-neutral">${escapeHtml(b.payment_method || 'other')}</span></td>
          <td>${getStatusBadge(b.status)}</td>
          <td>
            <button class="btn btn-secondary btn-sm view-booking-btn" data-id="${escapeHtml(b.id)}">View</button>
          </td>
        </tr>
      `).join('');

      document.querySelectorAll('.view-booking-btn').forEach(btn => {
        btn.addEventListener('click', () => viewBookingDetails(btn.dataset.id));
      });
    } catch (err) {
      console.error('Error loading bookings:', err);
    }
  }

  document.getElementById('bookingSearchInput').addEventListener('input', debounce(loadBookings, 300));
  document.getElementById('bookingStatusFilter').addEventListener('change', loadBookings);
  document.getElementById('bookingEventFilter').addEventListener('change', loadBookings);

  async function viewBookingDetails(bookingId) {
    const content = document.getElementById('bookingDetailContent');
    content.innerHTML = 'Loading booking details...';
    openModal('bookingDetailModal');

    try {
      const res = await fetch(`/api/bookings/${bookingId}`);
      if (!res.ok) {
        content.innerHTML = '<p class="text-danger">Failed to load booking details.</p>';
        return;
      }
      const data = await res.json();
      const b = data.booking;
      const cust = b.customer;
      const tickets = b.tickets || [];

      document.getElementById('bookingDetailTitle').textContent = `Booking: ${b.reference}`;

      let ticketListHtml = tickets.map(t => `
        <div style="padding: 0.5rem 0; border-bottom: 1px solid var(--border-color);">
          <strong>${escapeHtml(String(t.ticket_type || '').replace(/\s+/g, ' ').trim())}</strong>${
            t.attendee ? ` — ${escapeHtml([t.attendee.first_name, t.attendee.last_name].filter(Boolean).join(' ') || t.attendee.email || '')}` : ''
          }
        </div>
      `).join('');

      const transactions = b.transactions || [];
      const txHtml = transactions.length
        ? `<table class="data-table"><thead><tr><th>Type</th><th>Method</th><th>Gross</th><th>Fee</th><th>Net</th><th>Discount</th></tr></thead><tbody>${transactions.map((x) => `
            <tr>
              <td>${escapeHtml(x.line_type || '—')}${x.is_refund ? ' <span class="badge badge-danger">refund</span>' : ''}</td>
              <td>${escapeHtml(x.payment_method || '—')}</td>
              <td>${x.is_refund ? '-' : ''}${formatCurrency(x.gross)}</td>
              <td>${formatCurrency((x.fee || 0) + (x.fee_vat || 0))}</td>
              <td>${formatCurrency(x.net)}</td>
              <td>${formatCurrency((x.discount_automatic || 0) + (x.discount_code_amount || 0))}${x.discount_code_description ? ` (${escapeHtml(x.discount_code_description)})` : ''}</td>
            </tr>`).join('')}</tbody></table>`
        : '<p style="color: var(--text-muted);">No transaction records.</p>';

      content.innerHTML = `
        <div style="margin-bottom: 1.25rem;">
          <h4 style="margin-bottom: 0.5rem; font-size: 1rem;">Customer Information</h4>
          <p><strong>Name:</strong> ${escapeHtml(cust?.name || 'Guest')}</p>
          <p><strong>Email:</strong> ${escapeHtml(cust?.email || '—')}</p>
          <p><strong>Phone:</strong> ${escapeHtml(cust?.phone || '—')}</p>
          <p><strong>Postcode:</strong> ${escapeHtml(cust?.postcode || '—')}</p>
        </div>

        <div style="margin-bottom: 1.25rem;">
          <h4 style="margin-bottom: 0.5rem; font-size: 1rem;">Order Summary</h4>
          <p><strong>Event:</strong> ${escapeHtml(b.event_name || '—')}</p>
          <p><strong>Status:</strong> ${getStatusBadge(b.status)}</p>
          <p><strong>Payment Method:</strong> ${escapeHtml(b.payment_method || '—')}</p>
          <p><strong>Subtotal:</strong> ${formatCurrency(b.subtotal)}</p>
          <p><strong>Discount:</strong> -${formatCurrency(b.discount_amount)} ${b.discount_code ? `(${escapeHtml(b.discount_code)})` : ''}</p>
          <p><strong>Total:</strong> <strong>${formatCurrency(b.total_price)}</strong></p>
        </div>

        <div>
          <h4 style="margin-bottom: 0.5rem; font-size: 1rem;">Tickets (${tickets.length})</h4>
          <div>${ticketListHtml || '<p style="color: var(--text-muted);">No ticket records found.</p>'}</div>
        </div>

        <div style="margin-top: 1.25rem;">
          <h4 style="margin-bottom: 0.5rem; font-size: 1rem;">Transactions</h4>
          ${txHtml}
        </div>
      `;
    } catch {
      content.innerHTML = '<p class="text-danger">Error fetching booking details.</p>';
    }
  }

  // ----------------------------------------------------
  // 5. Customers
  // ----------------------------------------------------
  async function loadCustomers() {
    try {
      const search = document.getElementById('customerSearchInput').value.trim();
      let url = '/api/customers?limit=100';
      if (search) url += `&search=${encodeURIComponent(search)}`;

      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      const customers = data.customers || [];
      document.getElementById('customerSearchHint').hidden = !data.tooShort;

      const tbody = document.querySelector('#customersTable tbody');
      if (!customers.length) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted);">No customers found.</td></tr>';
        return;
      }

      tbody.innerHTML = customers.map(c => `
        <tr>
          <td><strong>${escapeHtml(c.name || '—')}</strong></td>
          <td>${escapeHtml(c.email || '—')}</td>
          <td>${escapeHtml(c.phone || '—')}</td>
          <td><code>${escapeHtml(c.postcode || '—')}</code></td>
          <td>${c.total_bookings || 0}</td>
          <td>${formatCurrency(c.total_spent || 0)}</td>
          <td>${formatDate(c.created_at)}</td>
        </tr>
      `).join('');
    } catch (err) {
      console.error('Error loading customers:', err);
    }
  }

  document.getElementById('customerSearchInput').addEventListener('input', debounce(loadCustomers, 300));

  // ----------------------------------------------------
  // 6. Reports
  // ----------------------------------------------------
  let reportsEventId = '';

  async function loadReports() {
    try {
      // Event selector: newest first, "All events" last. The first visit shows the latest event.
      const select = document.getElementById('reportsEvent');
      if (!select.options.length) {
        const eRes = await fetch('/api/reports/events');
        if (eRes.ok) {
          const events = (await eRes.json()).events || [];
          select.innerHTML = events.map(ev => `<option value="${escapeHtml(ev.id)}">${escapeHtml(ev.name)}</option>`).join('')
            + '<option value="all">All events</option>';
          reportsEventId = events[0]?.id || 'all';
          select.value = reportsEventId;
        }
      }
      const eventId = select.value || 'all';
      document.getElementById('exportBookingsLink').href = `/api/reports/export.csv?eventId=${encodeURIComponent(eventId)}`;

      // 1. Ticket categories (ticket type dictionary)
      const tRes = await fetch(`/api/reports/tickets?eventId=${encodeURIComponent(eventId)}`);
      if (tRes.ok) {
        const breakdown = (await tRes.json()).breakdown || [];
        const tbody = document.querySelector('#ticketTypeBreakdownTable tbody');
        if (!breakdown.length) {
          tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted);">No ticket sales downloaded for this selection.</td></tr>';
        } else {
          tbody.innerHTML = breakdown.map(item => `
            <tr>
              <td><strong>${escapeHtml(item.ticket_type)}</strong>${item.unmapped ? ' <span class="badge badge-warning" title="Not in the ticket type dictionary">not mapped</span>' : ''}</td>
              <td>${item.count}</td>
              <td>${formatCurrency(item.total_revenue)}</td>
              <td><small>${item.types.map(escapeHtml).join('<br>')}</small></td>
            </tr>
          `).join('');
        }
      }

      // 2. Discount codes (from the downloaded transaction lines)
      const dRes = await fetch(`/api/reports/discounts?eventId=${encodeURIComponent(eventId)}`);
      if (dRes.ok) {
        const d = await dRes.json();
        const tbody = document.querySelector('#discountsTable tbody');
        if (d.state !== 'ok') {
          tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">${
            d.state === 'no_bookings' ? 'No bookings downloaded for this selection.' : 'No booking in this selection used a discount code.'
          }</td></tr>`;
        } else {
          tbody.innerHTML = d.rows.map(r => `
            <tr>
              <td>${escapeHtml(r.yearLabel)}</td>
              <td><code>${escapeHtml(r.code)}</code></td>
              <td>${r.uses}</td>
              <td>${r.total === null ? '<span class="no-data" title="TicketSource did not supply an amount">Unknown</span>' : formatCurrency(r.total)}</td>
              <td>${r.notes.length ? `<ul class="notes">${r.notes.map(n => `<li>${escapeHtml(n)}</li>`).join('')}</ul>` : '—'}</td>
            </tr>
          `).join('');
        }
      }
    } catch (err) {
      console.error('Error loading reports:', err);
    }
  }

  document.getElementById('reportsEvent').addEventListener('change', loadReports);

  // ----------------------------------------------------
  // 7. TicketSource (read-only import)
  // ----------------------------------------------------
  const TS_STATE_HELP = {
    unsettled: 'Unsettled events pull only bookings changed since the last checkpoint.',
    settled: 'Settled events are re-read in full when you refresh them.',
    archived: 'Archived events are re-read in full when you refresh them.',
  };
  let tsBusy = false;

  function tsSetStatus(label, detail) {
    document.getElementById('tsSyncStatus').textContent = label;
    document.getElementById('tsSyncDetail').textContent = detail || '\u00a0';
  }

  async function tsPost(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.message || `Request failed (${res.status})`);
    return data;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function loadSync() {
    try {
      const state = document.getElementById('tsStateFilter').value;
      const res = await fetch(`/api/ticketsource/events${state ? `?state=${encodeURIComponent(state)}` : ''}`);
      if (!res.ok) return;
      const data = await res.json();

      document.getElementById('tsConnection').textContent = data.configured ? 'Connected' : 'Not configured';
      document.getElementById('tsConnectionSub').textContent = data.configured
        ? 'Read-only API key set'
        : 'Set the TICKETSOURCE_API_KEY secret';
      document.getElementById('tsRateUsed').textContent = `${data.rate.usedLastMinute} / ${data.rate.limitPerMinute}`;
      document.getElementById('tsRateSub').textContent = data.rate.blockedUntil
        ? `Paused by TicketSource until ${formatDate(data.rate.blockedUntil)}`
        : 'Limit is 240 calls/min; this app stays below it';
      const auto = data.autoRefresh;
      const autoResult = auto && auto.lastResult;
      document.getElementById('tsAutoRefresh').textContent = auto
        ? `Unsettled events are refreshed automatically every ${auto.everyMinutes} minutes. ${
            auto.lastRunAt
              ? `Last run ${formatDate(auto.lastRunAt)}${autoResult ? `: ${autoResult.status === 'ok' ? `${autoResult.imported} bookings imported or updated` : autoResult.status === 'skipped' ? `skipped (${autoResult.reason})` : `${autoResult.status}${autoResult.error ? ` (${autoResult.error})` : ''}`}` : ''}.`
              : 'It has not run yet.'
          }`
        : '';
      document.getElementById('tsStateHelp').textContent =
        'Status comes from TicketSource: unsettled, settled (its own settled flag) or archived. Settled events are hidden by TicketSource unless asked for; refreshing the list asks for them.';

      const canSync = currentUser && currentUser.role !== 'viewer';
      const tbody = document.querySelector('#tsEventsTable tbody');
      if (!data.events.length) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">${
          data.configured ? 'No events cached yet. Click "Refresh event list".' : 'TicketSource is not configured.'
        }</td></tr>`;
        return;
      }

      const badge = { unsettled: 'badge-warning', settled: 'badge-success', archived: 'badge-neutral' };
      tbody.innerHTML = data.events.map((ev) => {
        const dates = ev.dates.length
          ? ev.dates.map((d) => formatDate(d.starts_at)).join('<br>')
          : '<span style="color: var(--text-muted);">not loaded</span>';
        const mode = ev.state === 'unsettled' ? 'since checkpoint' : 'full';
        return `
          <tr>
            <td><strong>${escapeHtml(ev.name || ev.id)}</strong><br><small style="color: var(--text-muted);">${escapeHtml(ev.id)}</small></td>
            <td><span class="badge ${badge[ev.state] || 'badge-neutral'}">${escapeHtml(ev.state)}</span>${ev.state_pinned ? ' <small>(pinned)</small>' : ''}</td>
            <td>${dates}</td>
            <td>${ev.bookings_imported}</td>
            <td>${ev.last_synced_at ? formatDate(ev.last_synced_at) : 'Never'}${ev.sync_in_progress ? '<br><small>in progress</small>' : ''}</td>
            <td>
              ${canSync ? `<button class="btn btn-primary btn-sm ts-sync-btn" data-id="${escapeHtml(ev.id)}" data-mode="">Refresh bookings (${mode})</button>
              <button class="btn btn-secondary btn-sm ts-sync-btn" data-id="${escapeHtml(ev.id)}" data-mode="force" title="Re-read every booking and customer, ignoring the checkpoint and caches">Full re-sync</button>` : ''}
            </td>
          </tr>`;
      }).join('');

      document.querySelectorAll('.ts-sync-btn').forEach((btn) => {
        btn.addEventListener('click', () => syncTsEvent(btn.dataset.id, btn.dataset.mode));
      });
    } catch (err) {
      console.error('Error loading TicketSource events:', err);
    }
  }

  // Keeps calling the resumable step endpoint until the event is fully synced, waiting out rate limits.
  async function syncTsEvent(eventId, mode) {
    if (tsBusy) return;
    tsBusy = true;
    document.querySelectorAll('.ts-sync-btn, #tsRefreshEventsBtn').forEach((b) => (b.disabled = true));
    let imported = 0;
    let seen = 0;
    try {
      for (let step = 0; step < 2000; step++) {
        let r;
        for (let attempt = 0; ; attempt++) {
          try {
            r = await tsPost(`/api/ticketsource/events/${encodeURIComponent(eventId)}/sync`, { mode: mode || undefined, start: step === 0 });
            break;
          } catch (err) {
            // Cloudflare occasionally aborts a step that runs long; progress is saved, so just try the step again.
            if (attempt >= 4 || !/\(5\d\d\)/.test(err.message)) throw err;
            tsSetStatus('Syncing...', `Retrying after a temporary error (${attempt + 1}/4)`);
            await sleep(2000);
          }
        }
        imported += r.imported || 0;
        seen += r.seen || 0;
        if (r.done) {
          tsSetStatus('Complete', `${imported} bookings imported or updated (${seen} checked)`);
          showToast(`Sync complete: ${imported} bookings imported or updated`, 'success');
          break;
        }
        const waitMs = Math.max(500, r.retryAfterMs || 0);
        const why = r.waiting === 'budget' ? 'working' : r.waiting === 'rate_limited' ? 'TicketSource asked us to pause' : 'waiting for API allowance';
        tsSetStatus('Syncing...', `${imported} imported so far - ${why}${waitMs > 2000 ? ` (${Math.round(waitMs / 1000)}s)` : ''}`);
        await sleep(r.waiting === 'budget' ? 300 : waitMs);
      }
    } catch (err) {
      tsSetStatus('Failed', err.message);
      showToast(err.message, 'error');
    } finally {
      tsBusy = false;
      document.querySelectorAll('.ts-sync-btn, #tsRefreshEventsBtn').forEach((b) => (b.disabled = false));
      loadSync();
    }
  }

  document.getElementById('tsStateFilter').addEventListener('change', loadSync);

  // Read-only: downloads every event from TicketSource (settled and archived included) into the local cache.
  async function refreshTsEvents(label) {
    if (tsBusy) return false;
    tsBusy = true;
    const buttons = ['tsRefreshEventsBtn', 'retrieveEventsBtn'].map((id) => document.getElementById(id));
    buttons.forEach((b) => (b.disabled = true));
    tsSetStatus('Refreshing events...', '');
    let ok = false;
    try {
      for (let i = 0; i < 100; i++) {
        const r = await tsPost('/api/ticketsource/events/refresh', { force: i === 0 });
        if (r.done) break;
        await sleep(Math.max(500, r.retryAfterMs || 0));
      }
      tsSetStatus('Idle', 'Event list refreshed');
      ok = true;
    } catch (err) {
      tsSetStatus('Failed', err.message);
      showToast(err.message, 'error');
    } finally {
      tsBusy = false;
      buttons.forEach((b) => (b.disabled = false));
    }
    return ok;
  }

  document.getElementById('tsRefreshEventsBtn').addEventListener('click', async () => {
    if (await refreshTsEvents()) showToast('Event list refreshed', 'success');
    loadSync();
    loadTsEventsPanel();
  });

  // ----- Events tab: TicketSource events with the archive filter -----
  let tsEventsCache = [];

  async function loadTsEventsPanel() {
    try {
      const res = await fetch('/api/ticketsource/events');
      if (!res.ok) return;
      const data = await res.json();
      tsEventsCache = data.events || [];
      renderTsEventsPanel();
    } catch (err) {
      console.error('Error loading TicketSource events panel:', err);
    }
  }

  function renderTsEventsPanel() {
    const filter = document.getElementById('eventsArchiveFilter').value;
    const rows = tsEventsCache.filter((e) => (filter === 'archived' ? e.archived : filter === 'active' ? !e.archived : true));
    const tbody = document.querySelector('#tsEventsOnEventsTable tbody');
    if (!tsEventsCache.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">Use "Retrieve events from TicketSource" to load the list.</td></tr>';
      return;
    }
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">No events match this filter.</td></tr>';
      return;
    }
    const canSync = currentUser && currentUser.role !== 'viewer';
    const badge = { unsettled: 'badge-warning', settled: 'badge-success', archived: 'badge-neutral' };
    tbody.innerHTML = rows.map((ev) => `
      <tr>
        <td><strong>${escapeHtml(ev.name || ev.id)}</strong><br><small style="color: var(--text-muted);">${escapeHtml(ev.id)}</small></td>
        <td><span class="badge ${badge[ev.state] || 'badge-neutral'}">${escapeHtml(ev.state)}</span>${ev.archived && ev.settled ? ' <small>(also settled)</small>' : ''}</td>
        <td>${ev.dates.length ? ev.dates.map((d) => formatDate(d.starts_at)).join('<br>') : '<span style="color: var(--text-muted);">not loaded</span>'}</td>
        <td>${ev.bookings_imported}</td>
        <td>${canSync ? `<button class="btn btn-secondary btn-sm events-download-btn" data-id="${escapeHtml(ev.id)}">Download bookings</button>` : ''}</td>
      </tr>`).join('');
    document.querySelectorAll('.events-download-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await syncTsEvent(btn.dataset.id, '');
        loadTsEventsPanel();
      });
    });
  }

  document.getElementById('eventsArchiveFilter').addEventListener('change', renderTsEventsPanel);

  document.getElementById('retrieveEventsBtn').addEventListener('click', async () => {
    const btn = document.getElementById('retrieveEventsBtn');
    const summary = document.getElementById('retrieveEventsSummary');
    summary.textContent = 'Retrieving events from TicketSource...';
    btn.textContent = 'Retrieving...';
    const ok = await refreshTsEvents();
    btn.textContent = 'Retrieve events from TicketSource';
    if (!ok) {
      summary.textContent = 'Could not retrieve events. Nothing was changed in TicketSource (this is read-only).';
      return;
    }
    await loadTsEventsPanel();
    const archived = tsEventsCache.filter((e) => e.archived).length;
    const settled = tsEventsCache.filter((e) => !e.archived && e.state === 'settled').length;
    const unsettled = tsEventsCache.filter((e) => !e.archived && e.state === 'unsettled').length;
    summary.textContent = `Retrieved ${tsEventsCache.length} events: ${unsettled} unsettled, ${settled} settled, ${archived} archived. Read-only: nothing is sent to TicketSource.`;
    showToast(`Retrieved ${tsEventsCache.length} events from TicketSource`, 'success');
  });

  // ----------------------------------------------------
  // Configuration: ticket type dictionary + customer search index
  // ----------------------------------------------------
  async function loadTicketTypes() {
    try {
      const res = await fetch('/api/admin/ticket-types');
      if (!res.ok) return;
      const { types, categories } = await res.json();

      document.getElementById('ttCategoryList').innerHTML = categories.map(c => `<option value="${escapeHtml(c)}"></option>`).join('');
      document.getElementById('ttTypeList').innerHTML = types.map(t => `<option value="${escapeHtml(t.ticket_type)}"></option>`).join('');
      const unmapped = types.filter(t => !t.category);
      document.getElementById('ticketTypeSummary').textContent = unmapped.length
        ? `${unmapped.length} ticket type${unmapped.length === 1 ? ' has' : 's have'} no category yet. Until mapped, ${unmapped.length === 1 ? 'it appears' : 'they appear'} under ${unmapped.length === 1 ? 'its' : 'their'} own name in Reports.`
        : `All ${types.length} ticket types are mapped.`;

      const tbody = document.querySelector('#ticketTypesTable tbody');
      tbody.innerHTML = types.map((t, i) => `
        <tr data-type="${escapeHtml(t.ticket_type)}">
          <td>${escapeHtml(t.ticket_type)}</td>
          <td>${t.tickets}</td>
          <td>
            <input type="text" class="search-input tt-category" list="ttCategoryList" maxlength="80" aria-label="Category for ${escapeHtml(t.ticket_type)}"
              value="${escapeHtml(t.category || '')}" placeholder="${t.suggested ? escapeHtml(`Suggested: ${t.suggested}`) : 'Category'}" data-suggested="${escapeHtml(t.suggested || '')}">
          </td>
          <td>
            <button class="btn btn-primary btn-sm tt-save" data-i="${i}">Save</button>
            ${t.category ? '<button class="btn btn-secondary btn-sm tt-remove">Remove</button>' : (t.suggested ? '<button class="btn btn-secondary btn-sm tt-use-suggestion">Use suggestion</button>' : '')}
          </td>
        </tr>
      `).join('');

      const save = async (type, category) => {
        const r = await fetch('/api/admin/ticket-types', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ticket_type: type, category })
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) return showToast(body.error || 'Could not save', 'error');
        showToast('Saved', 'success');
        loadTicketTypes();
      };

      tbody.querySelectorAll('tr').forEach(tr => {
        const type = tr.dataset.type;
        const input = tr.querySelector('.tt-category');
        tr.querySelector('.tt-save').addEventListener('click', () => save(type, input.value));
        tr.querySelector('.tt-use-suggestion')?.addEventListener('click', () => save(type, input.dataset.suggested));
        tr.querySelector('.tt-remove')?.addEventListener('click', async () => {
          const r = await fetch(`/api/admin/ticket-types?type=${encodeURIComponent(type)}`, { method: 'DELETE' });
          if (r.ok) { showToast('Removed from the dictionary', 'success'); loadTicketTypes(); } else showToast('Could not remove', 'error');
        });
      });
    } catch (err) {
      console.error('Error loading ticket types:', err);
    }
  }

  document.getElementById('ticketTypeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const ticket_type = document.getElementById('ttType').value;
    const category = document.getElementById('ttCategory').value;
    const r = await fetch('/api/admin/ticket-types', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket_type, category })
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return showToast(body.error || 'Could not save', 'error');
    document.getElementById('ticketTypeForm').reset();
    showToast('Saved', 'success');
    loadTicketTypes();
  });

  document.getElementById('reindexBtn').addEventListener('click', async () => {
    const btn = document.getElementById('reindexBtn');
    const status = document.getElementById('reindexStatus');
    btn.disabled = true;
    try {
      let total = 0;
      for (let i = 0; i < 1000; i++) {
        const res = await fetch('/api/admin/customers/reindex', { method: 'POST' });
        if (!res.ok) throw new Error(`Request failed (${res.status})`);
        const r = await res.json();
        total += r.indexed;
        status.textContent = `Indexed ${total} customers; ${r.remaining} to go...`;
        if (r.remaining === 0 || r.indexed === 0) break;
      }
      status.textContent = `Customer search index is up to date (${total} customers indexed just now).`;
    } catch (err) {
      status.textContent = `Stopped: ${err.message}. Run it again to continue.`;
    } finally {
      btn.disabled = false;
    }
  });

  // ----------------------------------------------------
  // 8. Admin (Users)
  // ----------------------------------------------------
  async function loadUsers() {
    try {
      const res = await fetch('/api/admin/users');
      if (!res.ok) return;
      const data = await res.json();
      const users = data.users || [];

      const tbody = document.querySelector('#usersTable tbody');
      if (!users.length) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center;">No users found.</td></tr>';
        return;
      }

      tbody.innerHTML = users.map(u => {
        const isSelf = currentUser && currentUser.id === u.id;
        return `
          <tr>
            <td><strong>${escapeHtml(u.username)}</strong> ${isSelf ? '<small style="color: var(--brand-primary);">(You)</small>' : ''}</td>
            <td><span class="role-pill">${escapeHtml(u.role)}</span></td>
            <td>${getStatusBadge(u.is_active ? 'active' : 'disabled')}</td>
            <td>${formatDate(u.created_at)}</td>
            <td>${formatDate(u.last_login_at)}</td>
            <td>
              ${!isSelf ? `
                <button class="btn btn-secondary btn-sm toggle-user-btn" data-id="${u.id}" data-active="${u.is_active}">
                  ${u.is_active ? 'Disable' : 'Enable'}
                </button>
                <button class="btn btn-secondary btn-sm reset-pwd-btn" data-id="${u.id}" data-username="${escapeHtml(u.username)}">
                  Reset Password
                </button>
              ` : '<span style="color: var(--text-muted); font-size: 0.8125rem;">Current Session</span>'}
            </td>
          </tr>
        `;
      }).join('');

      document.querySelectorAll('.toggle-user-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.id;
          const current = btn.dataset.active === '1' || btn.dataset.active === 'true';
          const next = !current;
          const updateRes = await fetch(`/api/admin/users/${id}/status`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_active: next })
          });
          if (updateRes.ok) {
            showToast(`User account ${next ? 'enabled' : 'disabled'}`, 'success');
            loadUsers();
          } else {
            showToast('Failed to update user status', 'error');
          }
        });
      });

      document.querySelectorAll('.reset-pwd-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          document.getElementById('resetUserId').value = btn.dataset.id;
          document.getElementById('resetUsernameDisplay').textContent = `Resetting password for: ${btn.dataset.username}`;
          document.getElementById('resetNewPasswordInput').value = '';
          openModal('resetPasswordModal');
        });
      });
    } catch (err) {
      console.error('Error loading users:', err);
    }
  }

  document.getElementById('openNewUserModalBtn').addEventListener('click', () => {
    document.getElementById('newUserForm').reset();
    openModal('newUserModal');
  });

  document.getElementById('newUserForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('newUsernameInput').value.trim();
    const password = document.getElementById('newUserPasswordInput').value;
    const role = document.getElementById('newUserRoleSelect').value;

    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, role })
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || data.message || 'Error creating user', 'error');
        return;
      }

      showToast(`User ${username} created successfully`, 'success');
      closeModal('newUserModal');
      loadUsers();
    } catch {
      showToast('Network error creating user', 'error');
    }
  });

  document.getElementById('resetPasswordForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('resetUserId').value;
    const password = document.getElementById('resetNewPasswordInput').value;

    try {
      const res = await fetch(`/api/admin/users/${id}/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || data.message || 'Failed to reset password', 'error');
        return;
      }

      showToast('Password reset successfully', 'success');
      closeModal('resetPasswordModal');
    } catch {
      showToast('Network error resetting password', 'error');
    }
  });

  // ----------------------------------------------------
  // Utility Functions
  // ----------------------------------------------------
  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function debounce(fn, wait) {
    let timeout;
    return (...args) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => fn(...args), wait);
    };
  }

  // ----------------------------------------------------
  // Initialization
  // ----------------------------------------------------
  const authed = await checkAuth();
  if (authed) {
    loadDashboard();
    loadEvents();
  }
});
