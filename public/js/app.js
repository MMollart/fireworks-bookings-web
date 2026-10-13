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
        loadEvents();
        loadTsEventsPanel();
        break;
      case 'bookings':
        loadBookings();
        break;
      case 'tickets':
        loadTickets();
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
  async function loadDashboard() {
    try {
      const res = await fetch('/api/reports/dashboard');
      if (!res.ok) return;
      const data = await res.json();

      const rev = data.financials?.gross_revenue || 0;
      const disc = data.financials?.total_discounts || 0;
      const aov = data.financials?.aov || 0;
      const bCount = data.financials?.confirmed_bookings || 0;
      const tSold = data.tickets?.tickets_sold || 0;
      const tChecked = data.tickets?.tickets_checked_in || 0;
      const checkInRate = data.tickets?.checkInRate || 0;
      const cCount = data.customers?.total || 0;

      document.getElementById('kpiRevenue').textContent = formatCurrency(rev);
      document.getElementById('kpiDiscounts').textContent = `Discounts: ${formatCurrency(disc)}`;
      document.getElementById('kpiBookings').textContent = bCount;
      document.getElementById('kpiAov').textContent = `Average Order: ${formatCurrency(aov)}`;
      document.getElementById('kpiTickets').textContent = tSold;
      document.getElementById('kpiCheckInRate').textContent = `Check-in: ${checkInRate}% (${tChecked} checked)`;
      document.getElementById('kpiCustomers').textContent = cCount;

      // Render events in overview
      renderOverviewEvents(data.events || []);

      // Load recent bookings
      const bRes = await fetch('/api/bookings?limit=5');
      if (bRes.ok) {
        const bData = await bRes.json();
        renderOverviewBookings(bData.bookings || []);
      }
    } catch (err) {
      console.error('Error loading dashboard:', err);
    }
  }

  function renderOverviewEvents(events) {
    const tbody = document.querySelector('#overviewEventsTable tbody');
    if (!events.length) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--text-muted);">No events found. Click "Events" tab to create one.</td></tr>';
      return;
    }

    tbody.innerHTML = events.map(ev => {
      const sold = ev.tickets_sold || 0;
      const cap = ev.capacity || 0;
      const pct = cap ? Math.min(100, Math.round((sold / cap) * 100)) : 0;
      return `
        <tr>
          <td><strong>${escapeHtml(ev.name)}</strong></td>
          <td>${formatDate(ev.event_date)}</td>
          <td>${escapeHtml(ev.venue || '—')}</td>
          <td>${Number(ev.capacity) || '—'}</td>
          <td>${sold}</td>
          <td>
            <div class="progress-bar-bg" title="${pct}% sold">
              <div class="progress-bar-fill" style="width: ${pct}%"></div>
            </div>
            <small style="color: var(--text-muted);">${pct}%</small>
          </td>
          <td>${formatCurrency(ev.gross_revenue || 0)}</td>
          <td>${getStatusBadge(ev.status)}</td>
        </tr>
      `;
    }).join('');
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
        <td>${formatDate(b.created_at)}</td>
        <td>${getStatusBadge(b.status)}</td>
      </tr>
    `).join('');
  }

  document.getElementById('refreshDashboardBtn').addEventListener('click', () => {
    loadDashboard();
    showToast('Dashboard refreshed');
  });

  // ----------------------------------------------------
  // 2. Events Management
  // ----------------------------------------------------
  async function loadEvents() {
    try {
      const res = await fetch('/api/events');
      if (!res.ok) return;
      const data = await res.json();
      allEvents = data.events || [];

      // Update dropdowns in booking modal and booking filter
      updateEventDropdowns(allEvents);

      const tbody = document.querySelector('#eventsTable tbody');
      if (!allEvents.length) {
        tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--text-muted);">No events configured.</td></tr>';
        return;
      }

      tbody.innerHTML = allEvents.map(ev => {
        const sold = ev.tickets_sold || 0;
        const cap = ev.capacity || 0;
        const pct = cap ? Math.min(100, Math.round((sold / cap) * 100)) : 0;
        return `
          <tr>
            <td><strong>${escapeHtml(ev.name)}</strong></td>
            <td>${formatDate(ev.event_date)}</td>
            <td>${escapeHtml(ev.venue || '—')}</td>
            <td>${escapeHtml(ev.gates_open || '—')} / ${escapeHtml(ev.display_time || '—')}</td>
            <td>${Number(ev.capacity) || '—'}</td>
            <td>${sold} (${pct}%)</td>
            <td>${formatCurrency(ev.gross_revenue || 0)}</td>
            <td>${getStatusBadge(ev.status)}</td>
            <td>
              <button class="btn btn-secondary btn-sm toggle-event-status" data-id="${escapeHtml(ev.id)}" data-status="${escapeHtml(ev.status)}">
                ${ev.status === 'active' ? 'Cancel Event' : 'Reactivate'}
              </button>
            </td>
          </tr>
        `;
      }).join('');

      document.querySelectorAll('.toggle-event-status').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.id;
          const current = btn.dataset.status;
          const next = current === 'active' ? 'cancelled' : 'active';
          const updateRes = await fetch(`/api/events/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: next })
          });
          if (updateRes.ok) {
            showToast(`Event updated to ${next}`, 'success');
            loadEvents();
          } else {
            showToast('Failed to update event', 'error');
          }
        });
      });
    } catch (err) {
      console.error('Error loading events:', err);
    }
  }

  function updateEventDropdowns(events) {
    const bookingEventSelect = document.getElementById('bookingEventSelect');
    const bookingEventFilter = document.getElementById('bookingEventFilter');

    const options = events.map(e => `<option value="${escapeHtml(e.id)}">${escapeHtml(e.name)}</option>`).join('');
    if (bookingEventSelect) {
      bookingEventSelect.innerHTML = options || '<option value="">No events available</option>';
    }

    if (bookingEventFilter) {
      bookingEventFilter.innerHTML = `<option value="">All Events</option>${options}`;
    }
  }

  document.getElementById('openNewEventModalBtn').addEventListener('click', () => {
    document.getElementById('newEventForm').reset();
    openModal('newEventModal');
  });

  document.getElementById('newEventForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      name: document.getElementById('eventNameInput').value.trim(),
      event_date: document.getElementById('eventDateInput').value,
      venue: document.getElementById('eventVenueInput').value.trim(),
      capacity: Number(document.getElementById('eventCapacityInput').value),
      gates_open: document.getElementById('eventGatesInput').value.trim() || null,
      display_time: document.getElementById('eventDisplayInput').value.trim() || null,
      status: 'active'
    };

    try {
      const res = await fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || data.message || 'Error creating event', 'error');
        return;
      }

      showToast('Event created successfully', 'success');
      closeModal('newEventModal');
      loadEvents();
    } catch {
      showToast('Failed to connect to server', 'error');
    }
  });

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
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.5rem 0; border-bottom: 1px solid var(--border-color);">
          <div>
            <code>${escapeHtml(t.barcode)}</code> — <strong>${escapeHtml(t.ticket_type)}</strong> (${formatCurrency(t.price)})${
              t.attendee ? ` — ${escapeHtml([t.attendee.first_name, t.attendee.last_name].filter(Boolean).join(' ') || t.attendee.email || '')}` : ''
            }
          </div>
          <div>
            ${t.is_checked_in ? `<span class="badge badge-success">Checked in ${formatDate(t.checked_in_at)}</span>` : `<span class="badge badge-neutral">Not checked in</span>`}
          </div>
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

  document.getElementById('openNewBookingModalBtn').addEventListener('click', async () => {
    if (!allEvents.length) {
      await loadEvents();
    }
    document.getElementById('newBookingForm').reset();
    openModal('newBookingModal');
  });

  document.getElementById('newBookingForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const eventSelect = document.getElementById('bookingEventSelect');
    const typeSelect = document.getElementById('ticketTypeSelect');
    const qty = Number(document.getElementById('ticketQtyInput').value) || 1;
    const price = Number(typeSelect.options[typeSelect.selectedIndex].dataset.price) || 10;
    const typeName = typeSelect.value;

    const tickets = [];
    for (let i = 0; i < qty; i++) {
      tickets.push({ ticket_type: typeName, price });
    }

    const payload = {
      event_id: eventSelect.value,
      customer: {
        name: document.getElementById('custNameInput').value.trim(),
        email: document.getElementById('custEmailInput').value.trim(),
        phone: document.getElementById('custPhoneInput').value.trim() || null,
        postcode: document.getElementById('custPostcodeInput').value.trim() || null,
      },
      tickets,
      discount_code: document.getElementById('bookingDiscountInput').value.trim() || null,
      payment_method: 'manual',
    };

    try {
      const res = await fetch('/api/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || data.message || 'Failed to create booking', 'error');
        return;
      }

      showToast(`Booking ${data.booking.reference} created!`, 'success');
      closeModal('newBookingModal');
      loadBookings();
    } catch {
      showToast('Network error creating booking', 'error');
    }
  });

  // ----------------------------------------------------
  // 4. Tickets & Gate Check-In
  // ----------------------------------------------------
  const checkInForm = document.getElementById('checkInForm');
  const barcodeInput = document.getElementById('barcodeInput');
  const checkInResult = document.getElementById('checkInResult');

  checkInForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const barcode = barcodeInput.value.trim();
    if (!barcode) return;

    checkInResult.style.display = 'block';
    checkInResult.innerHTML = '<div style="color: var(--text-muted);">Validating ticket barcode...</div>';

    try {
      const res = await fetch('/api/tickets/checkin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ barcode })
      });
      const data = await res.json();

      if (res.status === 200 && data.success) {
        checkInResult.innerHTML = `
          <div style="background-color: var(--success-bg); border: 1px solid var(--success); color: var(--success); padding: 1rem; border-radius: var(--radius-sm);">
            <h4 style="margin: 0 0 0.25rem 0; font-size: 1.1rem;">Valid Ticket - Entry Approved</h4>
            <p style="margin: 0;"><strong>Barcode:</strong> <code>${escapeHtml(data.ticket.barcode)}</code></p>
            <p style="margin: 0;"><strong>Type:</strong> ${escapeHtml(data.ticket.ticket_type)} (${formatCurrency(data.ticket.price)})</p>
            <p style="margin: 0;"><strong>Event:</strong> ${escapeHtml(data.ticket.event_name || '—')}</p>
            <p style="margin: 0;"><strong>Booking:</strong> ${escapeHtml(data.ticket.booking_reference || '—')}</p>
          </div>
        `;
        showToast('Ticket checked in successfully', 'success');
        barcodeInput.value = '';
        loadTickets();
      } else if (res.status === 409 && data.ticket?.already_checked_in) {
        checkInResult.innerHTML = `
          <div style="background-color: var(--warning-bg); border: 1px solid var(--spark-gold); color: var(--ink); padding: 1rem; border-radius: var(--radius-sm);">
            <h4 style="margin: 0 0 0.25rem 0; font-size: 1.1rem;">Already Checked In</h4>
            <p style="margin: 0;">This ticket was already scanned at: <strong>${formatDate(data.ticket.checked_in_at)}</strong></p>
            <p style="margin: 0;"><strong>Barcode:</strong> <code>${escapeHtml(data.ticket.barcode)}</code></p>
            <p style="margin: 0;"><strong>Booking:</strong> ${escapeHtml(data.ticket.booking_reference || '—')}</p>
          </div>
        `;
        showToast('Ticket already checked in!', 'warning');
      } else {
        checkInResult.innerHTML = `
          <div style="background-color: var(--danger-bg); border: 1px solid var(--danger); color: var(--danger); padding: 1rem; border-radius: var(--radius-sm);">
            <h4 style="margin: 0 0 0.25rem 0; font-size: 1.1rem;">Invalid Ticket</h4>
            <p style="margin: 0;">${escapeHtml(data.error || data.message || 'Ticket not found or invalid.')}</p>
          </div>
        `;
        showToast(data.error || data.message || 'Invalid barcode', 'error');
      }
    } catch {
      checkInResult.innerHTML = `<div class="text-danger">Network error validating barcode.</div>`;
    }
  });

  async function loadTickets() {
    try {
      const search = document.getElementById('ticketSearchInput').value.trim();
      const checkedIn = document.getElementById('ticketCheckedInFilter').value;

      let url = '/api/tickets?limit=100';
      if (search) url += `&search=${encodeURIComponent(search)}`;
      if (checkedIn) url += `&isCheckedIn=${encodeURIComponent(checkedIn)}`;

      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      const tickets = data.tickets || [];

      const tbody = document.querySelector('#ticketsTable tbody');
      if (!tickets.length) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted);">No tickets matching filter.</td></tr>';
        return;
      }

      tbody.innerHTML = tickets.map(t => `
        <tr>
          <td><code>${escapeHtml(t.barcode)}</code></td>
          <td><code>${escapeHtml(t.booking_reference)}</code></td>
          <td>${escapeHtml(t.event_name || '—')}</td>
          <td><strong>${escapeHtml(t.ticket_type)}</strong></td>
          <td>${formatCurrency(t.price)}</td>
          <td>${t.is_checked_in ? '<span class="badge badge-success">Checked In</span>' : '<span class="badge badge-neutral">Not Used</span>'}</td>
          <td>${formatDate(t.checked_in_at)}</td>
        </tr>
      `).join('');
    } catch (err) {
      console.error('Error loading tickets:', err);
    }
  }

  document.getElementById('ticketSearchInput').addEventListener('input', debounce(loadTickets, 300));
  document.getElementById('ticketCheckedInFilter').addEventListener('change', loadTickets);

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
  // 6. Reports & Analysis
  // ----------------------------------------------------
  async function loadReports() {
    try {
      // 1. Ticket tier breakdown
      const tRes = await fetch('/api/reports/tickets');
      if (tRes.ok) {
        const tData = await tRes.json();
        const breakdown = tData.breakdown || [];
        const tbody = document.querySelector('#ticketTypeBreakdownTable tbody');
        if (!breakdown.length) {
          tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted);">No ticket sales recorded yet.</td></tr>';
        } else {
          tbody.innerHTML = breakdown.map(item => `
            <tr>
              <td><strong>${escapeHtml(item.ticket_type)}</strong></td>
              <td>${item.count}</td>
              <td>${formatCurrency(item.total_revenue)}</td>
              <td>${item.checked_in_count}</td>
            </tr>
          `).join('');
        }
      }

      // 2. Discount codes
      const dRes = await fetch('/api/reports/discounts');
      if (dRes.ok) {
        const dData = await dRes.json();
        const discounts = dData.discounts || [];
        const tbody = document.querySelector('#discountsTable tbody');
        if (!discounts.length) {
          tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--text-muted);">No discount codes found.</td></tr>';
        } else {
          tbody.innerHTML = discounts.map(d => `
            <tr>
              <td><code>${escapeHtml(d.code)}</code></td>
              <td>${escapeHtml(d.description || '—')}</td>
              <td><span class="badge badge-neutral">${escapeHtml(d.discount_type)}</span></td>
              <td>${d.discount_type === 'percent' ? `${d.discount_value}%` : formatCurrency(d.discount_value)}</td>
              <td>${d.times_used || 0}</td>
              <td>${formatCurrency(d.total_savings_generated || 0)}</td>
              <td>${formatCurrency(d.total_revenue_associated || 0)}</td>
              <td>${getStatusBadge(d.is_active ? 'active' : 'disabled')}</td>
            </tr>
          `).join('');
        }
      }
    } catch (err) {
      console.error('Error loading reports:', err);
    }
  }

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
