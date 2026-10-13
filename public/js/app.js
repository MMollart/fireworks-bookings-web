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
    return `<span class="badge ${cls}">${status}</span>`;
  }

  // ----------------------------------------------------
  // Modal Utilities
  // ----------------------------------------------------
  function openModal(modalId) {
    const m = document.getElementById(modalId);
    if (m) m.classList.add('open');
  }

  function closeModal(modalId) {
    const m = document.getElementById(modalId);
    if (m) m.classList.remove('open');
  }

  document.querySelectorAll('.close-modal').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open'));
    });
  });

  window.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-overlay')) {
      e.target.classList.remove('open');
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
      const aov = data.financials?.average_order_value || 0;
      const bCount = data.financials?.confirmed_bookings || 0;
      const tSold = data.tickets?.tickets_sold || 0;
      const tChecked = data.tickets?.tickets_checked_in || 0;
      const checkInRate = data.tickets?.check_in_rate_pct || 0;
      const cCount = data.customers?.total_customers || 0;

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
      const cap = ev.capacity || 1;
      const pct = Math.min(100, Math.round((sold / cap) * 100));
      return `
        <tr>
          <td><strong>${escapeHtml(ev.name)}</strong></td>
          <td>${formatDate(ev.event_date)}</td>
          <td>${escapeHtml(ev.venue || '—')}</td>
          <td>${ev.capacity}</td>
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
        <td><code>${escapeHtml(b.booking_reference)}</code></td>
        <td>${escapeHtml(b.event_name || '—')}</td>
        <td>${escapeHtml(b.customer_name || 'Guest')}</td>
        <td>${b.ticket_count || 0}</td>
        <td>${formatCurrency(b.total_amount)}</td>
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
        const cap = ev.capacity || 1;
        const pct = Math.min(100, Math.round((sold / cap) * 100));
        return `
          <tr>
            <td><strong>${escapeHtml(ev.name)}</strong></td>
            <td>${formatDate(ev.event_date)}</td>
            <td>${escapeHtml(ev.venue || '—')}</td>
            <td>${ev.gates_open || '—'} / ${ev.display_time || '—'}</td>
            <td>${ev.capacity}</td>
            <td>${sold} (${pct}%)</td>
            <td>${formatCurrency(ev.gross_revenue || 0)}</td>
            <td>${getStatusBadge(ev.status)}</td>
            <td>
              <button class="btn btn-secondary btn-sm toggle-event-status" data-id="${ev.id}" data-status="${ev.status}">
                ${ev.status === 'active' ? 'Set Draft' : 'Activate'}
              </button>
            </td>
          </tr>
        `;
      }).join('');

      document.querySelectorAll('.toggle-event-status').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.id;
          const current = btn.dataset.status;
          const next = current === 'active' ? 'draft' : 'active';
          const updateRes = await fetch(`/api/events/${id}`, {
            method: 'PATCH',
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

    const options = events.map(e => `<option value="${e.id}">${escapeHtml(e.name)}</option>`).join('');
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
        showToast(data.message || 'Error creating event', 'error');
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
          <td><code>${escapeHtml(b.booking_reference)}</code></td>
          <td>${escapeHtml(b.event_name || '—')}</td>
          <td>${escapeHtml(b.customer_name || 'Guest')}</td>
          <td>${b.ticket_count || 0}</td>
          <td>${formatCurrency(b.subtotal_amount)}</td>
          <td>${b.discount_amount > 0 ? `-${formatCurrency(b.discount_amount)}` : '£0.00'}</td>
          <td><strong>${formatCurrency(b.total_amount)}</strong></td>
          <td><span class="badge badge-neutral">${escapeHtml(b.payment_method || 'other')}</span></td>
          <td>${getStatusBadge(b.status)}</td>
          <td>
            <button class="btn btn-secondary btn-sm view-booking-btn" data-id="${b.id}">View</button>
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
      const cust = data.customer;
      const tickets = data.tickets || [];

      document.getElementById('bookingDetailTitle').textContent = `Booking: ${b.booking_reference}`;

      let ticketListHtml = tickets.map(t => `
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.5rem 0; border-bottom: 1px solid var(--border-color);">
          <div>
            <code>${escapeHtml(t.barcode)}</code> — <strong>${escapeHtml(t.ticket_type)}</strong> (${formatCurrency(t.price)})
          </div>
          <div>
            ${t.checked_in ? `<span class="badge badge-success">Checked in ${formatDate(t.checked_in_at)}</span>` : `<span class="badge badge-neutral">Not checked in</span>`}
          </div>
        </div>
      `).join('');

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
          <p><strong>Payment Method:</strong> ${escapeHtml(b.payment_method)}</p>
          <p><strong>Subtotal:</strong> ${formatCurrency(b.subtotal_amount)}</p>
          <p><strong>Discount:</strong> -${formatCurrency(b.discount_amount)} ${b.discount_code ? `(${escapeHtml(b.discount_code)})` : ''}</p>
          <p><strong>Total:</strong> <strong>${formatCurrency(b.total_amount)}</strong></p>
        </div>

        <div>
          <h4 style="margin-bottom: 0.5rem; font-size: 1rem;">Tickets (${tickets.length})</h4>
          <div>${ticketListHtml || '<p style="color: var(--text-muted);">No ticket records found.</p>'}</div>
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
      event_id: Number(eventSelect.value),
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
        showToast(data.message || 'Failed to create booking', 'error');
        return;
      }

      showToast(`Booking ${data.booking.booking_reference} created!`, 'success');
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
          <div style="background-color: #dcfce7; border: 1px solid #86efac; color: #166534; padding: 1rem; border-radius: 6px;">
            <h4 style="margin: 0 0 0.25rem 0; font-size: 1.1rem;">✅ VALID TICKET - ENTRY APPROVED</h4>
            <p style="margin: 0;"><strong>Barcode:</strong> <code>${escapeHtml(data.ticket.barcode)}</code></p>
            <p style="margin: 0;"><strong>Type:</strong> ${escapeHtml(data.ticket.ticket_type)} (${formatCurrency(data.ticket.price)})</p>
            <p style="margin: 0;"><strong>Customer:</strong> ${escapeHtml(data.booking?.customer_name || 'Guest')}</p>
            <p style="margin: 0;"><strong>Booking:</strong> ${escapeHtml(data.booking?.booking_reference || '—')}</p>
          </div>
        `;
        showToast('Ticket checked in successfully', 'success');
        barcodeInput.value = '';
        loadTickets();
      } else if (res.status === 409 && data.ticket?.already_checked_in) {
        checkInResult.innerHTML = `
          <div style="background-color: #fef3c7; border: 1px solid #fde68a; color: #92400e; padding: 1rem; border-radius: 6px;">
            <h4 style="margin: 0 0 0.25rem 0; font-size: 1.1rem;">⚠️ ALREADY CHECKED IN</h4>
            <p style="margin: 0;">This ticket was already scanned at: <strong>${formatDate(data.ticket.checked_in_at)}</strong></p>
            <p style="margin: 0;"><strong>Barcode:</strong> <code>${escapeHtml(data.ticket.barcode)}</code></p>
            <p style="margin: 0;"><strong>Customer:</strong> ${escapeHtml(data.booking?.customer_name || 'Guest')}</p>
          </div>
        `;
        showToast('Ticket already checked in!', 'warning');
      } else {
        checkInResult.innerHTML = `
          <div style="background-color: #fee2e2; border: 1px solid #fca5a5; color: #991b1b; padding: 1rem; border-radius: 6px;">
            <h4 style="margin: 0 0 0.25rem 0; font-size: 1.1rem;">❌ INVALID TICKET</h4>
            <p style="margin: 0;">${escapeHtml(data.message || 'Ticket not found or invalid.')}</p>
          </div>
        `;
        showToast(data.message || 'Invalid barcode', 'error');
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
      if (checkedIn) url += `&checked_in=${encodeURIComponent(checkedIn)}`;

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
          <td>${t.checked_in ? '<span class="badge badge-success">Checked In</span>' : '<span class="badge badge-neutral">Not Used</span>'}</td>
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
              <td>${item.tickets_sold}</td>
              <td>${formatCurrency(item.total_revenue)}</td>
              <td>${item.tickets_checked_in}</td>
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
  // 7. TicketSource Sync
  // ----------------------------------------------------
  async function loadSync() {
    try {
      const res = await fetch('/api/sync/status');
      if (!res.ok) return;
      const data = await res.json();

      const modeLabel = document.getElementById('syncModeLabel');
      const modeSub = document.getElementById('syncModeSub');
      const statusLabel = document.getElementById('syncStatusLabel');
      const cursorLabel = document.getElementById('syncCursorLabel');
      const importedCount = document.getElementById('syncImportedCount');
      const completedAt = document.getElementById('syncCompletedAt');

      if (data.configured) {
        modeLabel.textContent = 'Live TicketSource API';
        modeSub.textContent = 'Connected via API key';
      } else {
        modeLabel.textContent = 'Demo Simulation';
        modeSub.textContent = 'Simulated batch ingestion mode';
      }

      const cp = data.checkpoint;
      if (cp) {
        statusLabel.textContent = cp.status.toUpperCase();
        cursorLabel.textContent = `Cursor: ${cp.last_sync_cursor || 'None'}`;
        importedCount.textContent = cp.records_imported || 0;
        completedAt.textContent = formatDate(cp.completed_at || cp.started_at);
      } else {
        statusLabel.textContent = 'Never Run';
        cursorLabel.textContent = 'No checkpoints recorded';
        importedCount.textContent = '0';
        completedAt.textContent = 'Never';
      }

      const logs = data.recent_logs || [];
      const tbody = document.querySelector('#syncLogsTable tbody');
      if (!logs.length) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted);">No sync activity logged yet.</td></tr>';
      } else {
        tbody.innerHTML = logs.map(l => `
          <tr>
            <td>${formatDate(l.created_at)}</td>
            <td><span class="badge ${l.action === 'error' ? 'badge-danger' : 'badge-neutral'}">${escapeHtml(l.action)}</span></td>
            <td><code>${escapeHtml(l.entity_reference || '—')}</code></td>
            <td>${escapeHtml(l.details || '—')}</td>
          </tr>
        `).join('');
      }
    } catch (err) {
      console.error('Error loading sync status:', err);
    }
  }

  document.getElementById('triggerSyncBtn').addEventListener('click', async () => {
    const btn = document.getElementById('triggerSyncBtn');
    btn.disabled = true;
    btn.textContent = 'Syncing...';

    try {
      const res = await fetch('/api/sync/trigger', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.message || 'Sync failed', 'error');
      } else {
        showToast(`Sync completed! ${data.result?.imported || 0} records imported.`, 'success');
        loadSync();
      }
    } catch {
      showToast('Network error triggering sync', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '⚡ Run Sync Now';
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
        showToast(data.message || 'Error creating user', 'error');
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
        showToast(data.message || 'Failed to reset password', 'error');
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
