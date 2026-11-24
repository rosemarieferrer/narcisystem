let currentUser = null;
let activeIncidentId = null;
let allIncidents = [];
let currentAdminView = "summary";
let selectedCollegeCode = null;
let dashboardData = {
  college_stats: [],
  students: [],
  evacuation_centers: [],
  inventory: [],
  partners: [],
  transactions: []
};
let pollTimer = null;

// --- Authentication ---
async function checkSession() {
  try {
    const res = await fetch("/api/session");
    const data = await res.json();
    if (data.authenticated) {
      currentUser = data.user;
      await showApp();
    } else {
      document.getElementById("loginForm").reset();
      document.getElementById("loginScreen").classList.remove("hidden");
      document.getElementById("adminShell").classList.add("hidden");
      document.getElementById("collegeShell").classList.add("hidden");
    }
  } catch (err) {
    console.error("Session check error:", err);
  }
}

document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = document.getElementById("loginUsername").value;
  const password = document.getElementById("loginPassword").value;
  const errBox = document.getElementById("loginError");
  errBox.classList.add("hidden");

  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) {
      errBox.textContent = data.error || "Login failed.";
      errBox.classList.remove("hidden");
      return;
    }
    await checkSession();
  } catch (err) {
    errBox.textContent = "Unable to connect to the server. Make sure python app.py is running.";
    errBox.classList.remove("hidden");
  }
});

async function logout() {
  clearInterval(pollTimer);
  await fetch("/api/logout", { method: "POST" });
  currentUser = null;
  checkSession();
}

// --- Portal Routing ---
async function showApp() {
  document.getElementById("loginScreen").classList.add("hidden");
  const isAdmin = currentUser.role === "CSU_NSRC_ADMIN";

  document.getElementById("adminShell").classList.toggle("hidden", !isAdmin);
  document.getElementById("collegeShell").classList.toggle("hidden", isAdmin);

  if (!isAdmin) {
    document.getElementById("colPortalTitle").textContent = `${currentUser.username} — ${currentUser.college_code}`;
    document.getElementById("colPortalSubtitle").textContent = currentUser.college_name;
  } else {
    switchAdminView("summary");
  }

  await loadIncidents();
  clearInterval(pollTimer);
  pollTimer = setInterval(refreshDashboard, 15000);
}

// --- Admin Left Sidebar View Switcher ---
function switchAdminView(viewName) {
  currentAdminView = viewName;
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === viewName);
  });

  const isCollegeView = viewName.startsWith("college-");
  document.getElementById("adminView-summary").classList.toggle("hidden", viewName !== "summary");
  document.getElementById("adminView-college").classList.toggle("hidden", !isCollegeView);
  document.getElementById("adminView-evacuation").classList.toggle("hidden", viewName !== "evacuation");
  document.getElementById("adminView-donations").classList.toggle("hidden", viewName !== "donations");
  document.getElementById("adminView-relief").classList.toggle("hidden", viewName !== "relief");
  document.getElementById("adminView-incidents").classList.toggle("hidden", viewName !== "incidents");

  if (isCollegeView) {
    selectedCollegeCode = viewName.replace("college-", "");
    renderSpecificCollegeView();
  }
}

// --- Incidents Loader ---
async function loadIncidents() {
  const res = await fetch("/api/incidents");
  if (!res.ok) return;
  allIncidents = await res.json();

  const isAdmin = currentUser.role === "CSU_NSRC_ADMIN";
  const select = document.getElementById(isAdmin ? "adminIncidentSelect" : "colIncidentSelect");
  const badge = document.getElementById(isAdmin ? "adminIncidentBadge" : "colIncidentBadge");

  if (allIncidents.length === 0) {
    activeIncidentId = null;
    select.innerHTML = `<option value="">-- No Incident Recorded Yet --</option>`;
    badge.textContent = "No Event";
    badge.className = "badge badge-closed";
    await refreshDashboard();
    return;
  }

  select.innerHTML = allIncidents
    .map((inc) => `<option value="${inc.incident_id}">${inc.title} (${inc.hazard_type})</option>`)
    .join("");

  if (!activeIncidentId || !allIncidents.some((i) => i.incident_id === activeIncidentId)) {
    activeIncidentId = allIncidents[0].incident_id;
  }
  select.value = activeIncidentId;

  const chosen = allIncidents.find((i) => i.incident_id === activeIncidentId);
  if (chosen) {
    badge.textContent = chosen.status;
    badge.className = `badge ${chosen.status === "Active" ? "badge-active" : "badge-closed"}`;
  }

  select.onchange = async () => {
    activeIncidentId = Number(select.value);
    const inc = allIncidents.find((i) => i.incident_id === activeIncidentId);
    if (inc) {
      badge.textContent = inc.status;
      badge.className = `badge ${inc.status === "Active" ? "badge-active" : "badge-closed"}`;
    }
    await refreshDashboard();
  };

  await refreshDashboard();
}

async function selectIncidentFromTable(incidentId) {
  activeIncidentId = incidentId;
  await loadIncidents();
  switchAdminView("summary");
}

async function closeIncidentById(incidentId) {
  if (!confirm("Mark this incident as Closed?")) return;
  const res = await fetch(`/api/incidents/${incidentId}/close`, { method: "PATCH" });
  if (res.ok) {
    await loadIncidents();
  }
}

// --- Refresh Dashboard Data ---
async function refreshDashboard() {
  const res = await fetch(`/api/dashboard/${activeIncidentId || 0}`);
  if (!res.ok) return;
  dashboardData = await res.json();

  if (currentUser.role === "CSU_NSRC_ADMIN") {
    renderAdminPortal();
  } else {
    renderCollegePortal();
  }
}

// =========================================================================
// RENDER: CSU NSRC CENTRAL ADMIN PORTAL
// =========================================================================
function renderAdminPortal() {
  document.getElementById("navBadgeAll").textContent = dashboardData.students.length;
  dashboardData.college_stats.forEach((c) => {
    const el = document.getElementById(`navBadge-${c.college_code}`);
    if (el) el.textContent = c.total_affected;
  });
  document.getElementById("navBadgeEvac").textContent = dashboardData.evacuation_centers.length;
  const incomingTx = dashboardData.transactions.filter((t) => t.tx_type === "IN");
  document.getElementById("navBadgeDonations").textContent = incomingTx.length;
  document.getElementById("navBadgeRelief").textContent = dashboardData.inventory.length;
  document.getElementById("navBadgeIncidents").textContent = allIncidents.length;

  const stats = dashboardData.college_stats;
  const totalAffected = stats.reduce((a, b) => a + b.total_affected, 0);
  const totalReleased = dashboardData.transactions
    .filter((t) => t.tx_type === "OUT")
    .reduce((a, b) => a + (b.quantity || 0), 0);
  const totalReliefRequests = dashboardData.students.filter((s) => s.impact_type === "Needs Relief").length;
  const totalIncidents = allIncidents.length;
  const totalResolved = stats.reduce((a, b) => a + b.resolved, 0);

  document.getElementById("kpiTotal").textContent = totalAffected;
  document.getElementById("kpiReliefGoods").textContent = `${totalReleased} / ${totalReliefRequests}`;
  document.getElementById("kpiIncidents").textContent = totalIncidents;
  document.getElementById("kpiResolved").textContent = totalResolved;

  document.getElementById("collegeCardsGrid").innerHTML = stats
    .map(
      (c) => `
      <div class="college-box" onclick="switchAdminView('college-${c.college_code}')">
        <strong>${c.college_code}</strong>
        <small>${c.college_name}</small>
        <div class="count">${c.total_affected}</div>
        <span class="text-sm text-muted">${c.resolved} resolved · ${c.submitted} pending</span>
      </div>`
    )
    .join("");

  document.getElementById("stuCollegeId").innerHTML = stats
    .map((c) => `<option value="${c.college_id}">${c.college_code} — ${c.college_name}</option>`)
    .join("");

  renderSummaryStudentsTable();
  if (currentAdminView.startsWith("college-")) {
    renderSpecificCollegeView();
  }
  renderEvacuationRecordsView();
  renderDonationRecordsView();
  renderReliefGoodsView();
  renderIncidentsRecordsView();
}

function renderSummaryStudentsTable() {
  const tbody = document.getElementById("summaryStudentsBody");
  const query = document.getElementById("searchSummaryStudent").value.toLowerCase();

  const filtered = dashboardData.students.filter(
    (s) =>
      s.student_id.toLowerCase().includes(query) ||
      s.full_name.toLowerCase().includes(query) ||
      s.program.toLowerCase().includes(query) ||
      s.college_code.toLowerCase().includes(query) ||
      s.address.toLowerCase().includes(query) ||
      (s.boarding_house || "").toLowerCase().includes(query)
  );

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="11" class="text-muted">No affected student records recorded yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered
    .map((s) => {
      const badgeKey = s.current_status.split(" ")[0];
      return `
      <tr>
        <td><strong>${s.college_code}</strong></td>
        <td><code>${s.student_id}</code></td>
        <td><strong>${s.full_name}</strong></td>
        <td>${s.program}</td>
        <td>${s.address}</td>
        <td>${s.boarding_house || "—"}</td>
        <td>${s.contact_number || "—"}</td>
        <td>${s.impact_type}</td>
        <td><span class="badge badge-${badgeKey}">${s.current_status}</span></td>
        <td>${s.center_name || "—"}</td>
        <td>
          <button class="btn btn-outline btn-sm" onclick="openCaseModal(${s.record_id})">Update Action</button>
        </td>
      </tr>`;
    })
    .join("");
}

function renderSpecificCollegeView() {
  if (!selectedCollegeCode) return;
  const colInfo = dashboardData.college_stats.find((c) => c.college_code === selectedCollegeCode);
  if (colInfo) {
    document.getElementById("specificCollegeTitle").textContent = `${colInfo.college_code} — ${colInfo.college_name}`;
    document.getElementById("colKpiTotal").textContent = colInfo.total_affected;
    document.getElementById("colKpiPending").textContent = colInfo.submitted;
    document.getElementById("colKpiActioned").textContent = colInfo.in_progress + colInfo.sheltered;
    document.getElementById("colKpiResolved").textContent = colInfo.resolved;
  }
  renderSpecificCollegeTable();
}

function renderSpecificCollegeTable() {
  const tbody = document.getElementById("specificCollegeBody");
  const query = document.getElementById("searchCollegeStudent").value.toLowerCase();

  const filtered = dashboardData.students.filter(
    (s) =>
      s.college_code === selectedCollegeCode &&
      (s.student_id.toLowerCase().includes(query) ||
        s.full_name.toLowerCase().includes(query) ||
        s.program.toLowerCase().includes(query) ||
        s.address.toLowerCase().includes(query) ||
        (s.boarding_house || "").toLowerCase().includes(query))
  );

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" class="text-muted">No records submitted under ${selectedCollegeCode} yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered
    .map((s) => {
      const badgeKey = s.current_status.split(" ")[0];
      return `
      <tr>
        <td><code>${s.student_id}</code></td>
        <td><strong>${s.full_name}</strong></td>
        <td>${s.program}</td>
        <td>${s.address}</td>
        <td>${s.boarding_house || "—"}</td>
        <td>${s.contact_number || "—"}</td>
        <td>${s.impact_type}</td>
        <td><span class="badge badge-${badgeKey}">${s.current_status}</span></td>
        <td>${s.center_name || "—"}</td>
        <td>
          <button class="btn btn-outline btn-sm" onclick="openCaseModal(${s.record_id})">Update Action</button>
        </td>
      </tr>`;
    })
    .join("");
}

function renderEvacuationRecordsView() {
  const container = document.getElementById("centersList");
  if (dashboardData.evacuation_centers.length === 0) {
    container.innerHTML = `<p class="text-sm text-muted">No evacuation centers recorded yet. Click "+ Add Evacuation Center" to input one.</p>`;
  } else {
    container.innerHTML = dashboardData.evacuation_centers
      .map((c) => {
        const pct = Math.min(100, Math.round((c.current_occupancy / c.max_capacity) * 100));
        const avail = c.max_capacity - c.current_occupancy;
        return `
        <div class="center-item">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <strong>${c.name}</strong>
            <span class="badge ${c.status === "Open" ? "badge-active" : "badge-Submitted"}">${c.status} (${avail} slots left)</span>
          </div>
          <div class="text-sm text-muted">${c.location} · ${c.amenities || "No amenities listed"}</div>
          <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
          <div style="display:flex;justify-content:space-between;align-items:center;" class="text-sm">
            <span>Occupancy: <strong>${c.current_occupancy} / ${c.max_capacity}</strong></span>
            <div>
              <button class="btn btn-ghost btn-sm" onclick="adjustOccupancy(${c.center_id}, -1)">-1</button>
              <button class="btn btn-ghost btn-sm" onclick="adjustOccupancy(${c.center_id}, 1)">+1</button>
            </div>
          </div>
        </div>`;
      })
      .join("");
  }

  const shelteredBody = document.getElementById("shelteredStudentsBody");
  const sheltered = dashboardData.students.filter((s) => s.assigned_center_id);
  if (sheltered.length === 0) {
    shelteredBody.innerHTML = `<tr><td colspan="8" class="text-muted">No students assigned to evacuation centers yet.</td></tr>`;
  } else {
    shelteredBody.innerHTML = sheltered
      .map(
        (s) => `
        <tr>
          <td><strong>${s.center_name}</strong></td>
          <td>${s.college_code}</td>
          <td><code>${s.student_id}</code></td>
          <td><strong>${s.full_name}</strong></td>
          <td>${s.program}</td>
          <td>${s.contact_number || "—"}</td>
          <td><span class="badge badge-Assisted">${s.current_status}</span></td>
          <td><button class="btn btn-outline btn-sm" onclick="openCaseModal(${s.record_id})">Update</button></td>
        </tr>`
      )
      .join("");
  }
}

function renderDonationRecordsView() {
  const partnersBody = document.getElementById("partnersTableBody");
  if (dashboardData.partners.length === 0) {
    partnersBody.innerHTML = `<tr><td colspan="4" class="text-muted">No partner institutions registered yet.</td></tr>`;
  } else {
    partnersBody.innerHTML = dashboardData.partners
      .map(
        (p) => `
        <tr>
          <td><strong>${p.institution_name}</strong></td>
          <td>${p.partner_type}</td>
          <td>${p.contact_person || "—"}</td>
          <td>${p.contact_details || "—"}</td>
        </tr>`
      )
      .join("");
  }

  const inBody = document.getElementById("incomingDonationsBody");
  const incoming = dashboardData.transactions.filter((t) => t.tx_type === "IN");
  if (incoming.length === 0) {
    inBody.innerHTML = `<tr><td colspan="5" class="text-muted">No external donations recorded for this incident yet.</td></tr>`;
  } else {
    inBody.innerHTML = incoming
      .map(
        (t) => `
        <tr>
          <td><strong>${t.institution_name || "Direct / Walk-in Donor"}</strong></td>
          <td>${t.item_name}</td>
          <td><span class="badge badge-active">+${t.quantity} ${t.unit}</span></td>
          <td>${t.source_or_recipient}</td>
          <td>${t.recorded_by_name}</td>
        </tr>`
      )
      .join("");
  }
}

function renderReliefGoodsView() {
  const invBody = document.getElementById("inventoryTableBody");
  if (dashboardData.inventory.length === 0) {
    invBody.innerHTML = `<tr><td colspan="5" class="text-muted">No relief items added yet. Click "+ Add Relief Item" first.</td></tr>`;
  } else {
    invBody.innerHTML = dashboardData.inventory
      .map((item) => {
        const low = item.quantity_on_hand <= item.reorder_threshold;
        return `
        <tr>
          <td><strong>${item.item_name}</strong></td>
          <td>${item.category}</td>
          <td>${item.unit}</td>
          <td>${item.reorder_threshold} ${item.unit}</td>
          <td>
            <strong>${item.quantity_on_hand}</strong> ${item.unit}
            ${low ? `<span class="badge badge-low">Low Stock</span>` : ""}
          </td>
        </tr>`;
      })
      .join("");
  }

  const outBody = document.getElementById("outgoingReleasesBody");
  const outgoing = dashboardData.transactions.filter((t) => t.tx_type === "OUT");
  if (outgoing.length === 0) {
    outBody.innerHTML = `<tr><td colspan="4" class="text-muted">No relief goods released for this incident yet.</td></tr>`;
  } else {
    outBody.innerHTML = outgoing
      .map(
        (t) => `
        <tr>
          <td><strong>${t.item_name}</strong></td>
          <td><span class="badge badge-Submitted">-${t.quantity} ${t.unit}</span></td>
          <td>${t.source_or_recipient}</td>
          <td>${t.recorded_by_name}</td>
        </tr>`
      )
      .join("");
  }
}

function renderIncidentsRecordsView() {
  const tbody = document.getElementById("incidentsTableBody");
  if (allIncidents.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-muted">No calamity or incident events recorded yet. Click "+ Record New Incident" to create one.</td></tr>`;
    return;
  }

  tbody.innerHTML = allIncidents
    .map(
      (inc) => `
      <tr>
        <td><strong>${inc.title}</strong></td>
        <td>${inc.hazard_type}</td>
        <td>${inc.incident_date || "—"}</td>
        <td><strong>${inc.student_count}</strong></td>
        <td><span class="badge ${inc.status === "Active" ? "badge-active" : "badge-closed"}">${inc.status}</span></td>
        <td>
          <div style="display:flex;gap:0.4rem;flex-wrap:wrap;">
            <button class="btn btn-outline btn-sm" onclick="selectIncidentFromTable(${inc.incident_id})">View Dashboard</button>
            <button class="btn btn-gold btn-sm" onclick="exportAftermathReport(${inc.incident_id})">Export CSV</button>
            ${
              inc.status === "Active"
                ? `<button class="btn btn-ghost btn-sm" onclick="closeIncidentById(${inc.incident_id})">Close Event</button>`
                : ""
            }
          </div>
        </td>
      </tr>`
    )
    .join("");
}

// =========================================================================
// RENDER: COLLEGE FOCAL PORTAL (NO MENU BAR — SUBMIT & UPDATE ONLY)
// =========================================================================
function renderCollegePortal() {
  const students = dashboardData.students;
  const totalAffected = students.length;
  const totalReleased = dashboardData.transactions
    .filter((t) => t.tx_type === "OUT")
    .reduce((a, b) => a + (b.quantity || 0), 0);
  const collegeRequests = students.filter((s) => s.impact_type === "Needs Relief").length;
  const evacuatedCount = students.filter((s) => s.assigned_center_id || s.current_status === "Assisted / Sheltered").length;
  const totalResolved = students.filter((s) => s.current_status === "Resolved").length;

  document.getElementById("myColTotal").textContent = totalAffected;
  document.getElementById("myColReliefGoods").textContent = `${totalReleased} / ${collegeRequests}`;
  document.getElementById("myColEvacuation").textContent = evacuatedCount;
  document.getElementById("myColResolved").textContent = totalResolved;

  renderCollegePortalTable();
}

function renderCollegePortalTable() {
  const tbody = document.getElementById("myCollegeRecordsBody");
  const query = document.getElementById("searchMyCollegeRecords").value.toLowerCase();

  const filtered = dashboardData.students.filter(
    (s) =>
      s.student_id.toLowerCase().includes(query) ||
      s.full_name.toLowerCase().includes(query) ||
      s.program.toLowerCase().includes(query) ||
      s.address.toLowerCase().includes(query) ||
      (s.boarding_house || "").toLowerCase().includes(query)
  );

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" class="text-muted">No submitted records for ${currentUser.college_code} under this event yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered
    .map((s) => {
      const badgeKey = s.current_status.split(" ")[0];
      return `
      <tr>
        <td><code>${s.student_id}</code></td>
        <td><strong>${s.full_name}</strong></td>
        <td>${s.program}</td>
        <td>${s.address}</td>
        <td>${s.boarding_house || "—"}</td>
        <td>${s.contact_number || "—"}</td>
        <td>${s.impact_type}</td>
        <td><span class="badge badge-${badgeKey}">${s.current_status}</span></td>
        <td>${s.center_name || "—"}</td>
        <td>
          <div style="display:flex;gap:0.35rem;flex-wrap:wrap;">
            <button class="btn btn-primary btn-sm" onclick="openEditStudentModal(${s.record_id})">Update Data</button>
            <button class="btn btn-outline btn-sm" onclick="openCaseModal(${s.record_id})">NSRC Logs</button>
          </div>
        </td>
      </tr>`;
    })
    .join("");
}

// =========================================================================
// KPI CARD CLICK DRILL-DOWN MODALS (COLLEGE & ADMIN)
// =========================================================================
function openCollegeKpiModal(type) {
  const titleEl = document.getElementById("kpiModalTitle");
  const bodyEl = document.getElementById("kpiModalBody");
  const students = dashboardData.students;
  const activeInc = allIncidents.find((i) => i.incident_id === activeIncidentId);
  const incLabel = activeInc ? `${activeInc.title} (${activeInc.hazard_type})` : "Selected Event";

  if (type === "students") {
    titleEl.textContent = `${currentUser.college_code} — Affected Students (Name & ID Number)`;
    if (students.length === 0) {
      bodyEl.innerHTML = `<p class="text-muted text-sm">No affected students recorded for ${currentUser.college_code} yet.</p>`;
    } else {
      bodyEl.innerHTML = `
        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th>Student ID</th>
                <th>Full Name</th>
                <th>Program</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              ${students
                .map(
                  (s) => `
                  <tr>
                    <td><code>${s.student_id}</code></td>
                    <td><strong>${s.full_name}</strong></td>
                    <td>${s.program}</td>
                    <td>${s.current_status}</td>
                  </tr>`
                )
                .join("")}
            </tbody>
          </table>
        </div>`;
    }
  } else if (type === "relief") {
    titleEl.textContent = `${currentUser.college_code} — Relief Goods, Requests & Releases`;
    const reqStudents = students.filter((s) => s.impact_type === "Needs Relief");
    const releases = dashboardData.transactions.filter((t) => t.tx_type === "OUT");
    const items = dashboardData.inventory;

    bodyEl.innerHTML = `
      <h4 class="sub-heading" style="margin-top:0;">Available Relief Goods Stock</h4>
      <div class="table-responsive" style="margin-bottom:1rem;">
        <table>
          <thead><tr><th>Item</th><th>Category</th><th>Available Stock</th></tr></thead>
          <tbody>
            ${
              items.length === 0
                ? `<tr><td colspan="3" class="text-muted">No relief items recorded in NSRC inventory yet.</td></tr>`
                : items.map((i) => `<tr><td><strong>${i.item_name}</strong></td><td>${i.category}</td><td>${i.quantity_on_hand} ${i.unit}</td></tr>`).join("")
            }
          </tbody>
        </table>
      </div>

      <h4 class="sub-heading">${currentUser.college_code} Relief Requests (${reqStudents.length})</h4>
      <div class="table-responsive" style="margin-bottom:1rem;">
        <table>
          <thead><tr><th>Student ID</th><th>Full Name</th><th>Status</th></tr></thead>
          <tbody>
            ${
              reqStudents.length === 0
                ? `<tr><td colspan="3" class="text-muted">No relief requests from ${currentUser.college_code} yet.</td></tr>`
                : reqStudents.map((s) => `<tr><td><code>${s.student_id}</code></td><td><strong>${s.full_name}</strong></td><td>${s.current_status}</td></tr>`).join("")
            }
          </tbody>
        </table>
      </div>

      <h4 class="sub-heading">Relief Goods Released (${releases.length})</h4>
      <div class="table-responsive">
        <table>
          <thead><tr><th>Relief Item</th><th>Quantity Released</th><th>Recipient</th></tr></thead>
          <tbody>
            ${
              releases.length === 0
                ? `<tr><td colspan="3" class="text-muted">No relief goods released yet.</td></tr>`
                : releases.map((r) => `<tr><td><strong>${r.item_name}</strong></td><td>${r.quantity} ${r.unit}</td><td>${r.source_or_recipient}</td></tr>`).join("")
            }
          </tbody>
        </table>
      </div>`;
  } else if (type === "evacuation") {
    titleEl.textContent = `${currentUser.college_code} — Evacuation Centers & Sheltered Students`;
    const centers = dashboardData.evacuation_centers;
    const shelteredStudents = students.filter((s) => s.assigned_center_id || s.current_status === "Assisted / Sheltered");

    bodyEl.innerHTML = `
      <h4 class="sub-heading" style="margin-top:0;">Evacuation Centers &amp; Student Counts</h4>
      <div class="table-responsive" style="margin-bottom:1rem;">
        <table>
          <thead><tr><th>Evacuation Center</th><th>Location</th><th>${currentUser.college_code} Students</th><th>Total Occupancy</th><th>Status</th></tr></thead>
          <tbody>
            ${
              centers.length === 0
                ? `<tr><td colspan="5" class="text-muted">No evacuation centers recorded yet.</td></tr>`
                : centers
                    .map((c) => {
                      const myCount = students.filter((s) => s.assigned_center_id === c.center_id).length;
                      return `<tr>
                        <td><strong>${c.name}</strong></td>
                        <td>${c.location}</td>
                        <td><strong>${myCount}</strong></td>
                        <td>${c.current_occupancy} / ${c.max_capacity}</td>
                        <td>${c.status}</td>
                      </tr>`;
                    })
                    .join("")
            }
          </tbody>
        </table>
      </div>

      <h4 class="sub-heading">Sheltered Students from ${currentUser.college_code} (${shelteredStudents.length})</h4>
      <div class="table-responsive">
        <table>
          <thead><tr><th>Student ID</th><th>Full Name</th><th>Assigned Evacuation Center</th></tr></thead>
          <tbody>
            ${
              shelteredStudents.length === 0
                ? `<tr><td colspan="3" class="text-muted">No students from ${currentUser.college_code} assigned to an evacuation center yet.</td></tr>`
                : shelteredStudents.map((s) => `<tr><td><code>${s.student_id}</code></td><td><strong>${s.full_name}</strong></td><td>${s.center_name || "Sheltered"}</td></tr>`).join("")
            }
          </tbody>
        </table>
      </div>`;
  } else if (type === "resolved") {
    titleEl.textContent = `${currentUser.college_code} — Resolved Reports`;
    const resolvedList = students.filter((s) => s.current_status === "Resolved");
    if (resolvedList.length === 0) {
      bodyEl.innerHTML = `<p class="text-muted text-sm">No resolved student reports for ${currentUser.college_code} yet.</p>`;
    } else {
      bodyEl.innerHTML = `
        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th>Student ID</th>
                <th>Full Name</th>
                <th>Incident / Event</th>
                <th>Impact Reported</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              ${resolvedList
                .map(
                  (s) => `
                  <tr>
                    <td><code>${s.student_id}</code></td>
                    <td><strong>${s.full_name}</strong></td>
                    <td>${incLabel}</td>
                    <td>${s.impact_type}</td>
                    <td><span class="badge badge-Resolved">Resolved</span></td>
                  </tr>`
                )
                .join("")}
            </tbody>
          </table>
        </div>`;
    }
  }

  openModal("modalKpiDetail");
}

function openAdminKpiModal(type) {
  const titleEl = document.getElementById("kpiModalTitle");
  const bodyEl = document.getElementById("kpiModalBody");
  const students = dashboardData.students;
  const activeInc = allIncidents.find((i) => i.incident_id === activeIncidentId);
  const incLabel = activeInc ? `${activeInc.title} (${activeInc.hazard_type})` : "Selected Event";

  if (type === "students") {
    titleEl.textContent = "All Affected Students (Name, ID, College & Program)";
    if (students.length === 0) {
      bodyEl.innerHTML = `<p class="text-muted text-sm">No affected students recorded yet.</p>`;
    } else {
      bodyEl.innerHTML = `
        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th>Student ID</th>
                <th>Full Name</th>
                <th>College</th>
                <th>Program</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              ${students
                .map(
                  (s) => `
                  <tr>
                    <td><code>${s.student_id}</code></td>
                    <td><strong>${s.full_name}</strong></td>
                    <td><strong>${s.college_code}</strong></td>
                    <td>${s.program}</td>
                    <td>${s.current_status}</td>
                  </tr>`
                )
                .join("")}
            </tbody>
          </table>
        </div>`;
    }
  } else if (type === "relief") {
    titleEl.textContent = "Relief Goods — Released Over Requests";
    const reqStudents = students.filter((s) => s.impact_type === "Needs Relief");
    const releases = dashboardData.transactions.filter((t) => t.tx_type === "OUT");
    const totalReleasedQty = releases.reduce((a, b) => a + (b.quantity || 0), 0);

    bodyEl.innerHTML = `
      <div class="summary-box">
        <strong>Summary Ratio:</strong> ${totalReleasedQty} released / ${reqStudents.length} student relief requests
      </div>
      <h4 class="sub-heading">Relief Goods Released (${releases.length})</h4>
      <div class="table-responsive" style="margin-bottom:1rem;">
        <table>
          <thead><tr><th>Item</th><th>Quantity Released</th><th>Recipient</th></tr></thead>
          <tbody>
            ${
              releases.length === 0
                ? `<tr><td colspan="3" class="text-muted">No relief goods released yet.</td></tr>`
                : releases.map((r) => `<tr><td><strong>${r.item_name}</strong></td><td>${r.quantity} ${r.unit}</td><td>${r.source_or_recipient}</td></tr>`).join("")
            }
          </tbody>
        </table>
      </div>
      <h4 class="sub-heading">Students Requesting Relief (${reqStudents.length})</h4>
      <div class="table-responsive">
        <table>
          <thead><tr><th>College</th><th>Student ID</th><th>Full Name</th><th>Status</th></tr></thead>
          <tbody>
            ${
              reqStudents.length === 0
                ? `<tr><td colspan="4" class="text-muted">No students requesting relief yet.</td></tr>`
                : reqStudents.map((s) => `<tr><td><strong>${s.college_code}</strong></td><td><code>${s.student_id}</code></td><td><strong>${s.full_name}</strong></td><td>${s.current_status}</td></tr>`).join("")
            }
          </tbody>
        </table>
      </div>`;
  } else if (type === "incidents") {
    titleEl.textContent = "Recorded Calamities & Incidents";
    if (allIncidents.length === 0) {
      bodyEl.innerHTML = `<p class="text-muted text-sm">No incidents recorded yet.</p>`;
    } else {
      bodyEl.innerHTML = `
        <div class="table-responsive">
          <table>
            <thead><tr><th>Incident Title</th><th>Hazard Type</th><th>Affected Students</th><th>Status</th></tr></thead>
            <tbody>
              ${allIncidents
                .map(
                  (inc) => `
                  <tr>
                    <td><strong>${inc.title}</strong></td>
                    <td>${inc.hazard_type}</td>
                    <td>${inc.student_count}</td>
                    <td>${inc.status}</td>
                  </tr>`
                )
                .join("")}
            </tbody>
          </table>
        </div>`;
    }
  } else if (type === "resolved") {
    titleEl.textContent = "Resolved Student Reports";
    const resolvedList = students.filter((s) => s.current_status === "Resolved");
    if (resolvedList.length === 0) {
      bodyEl.innerHTML = `<p class="text-muted text-sm">No resolved cases yet.</p>`;
    } else {
      bodyEl.innerHTML = `
        <div class="table-responsive">
          <table>
            <thead><tr><th>College</th><th>Student ID</th><th>Full Name</th><th>Incident</th><th>Impact</th></tr></thead>
            <tbody>
              ${resolvedList
                .map(
                  (s) => `
                  <tr>
                    <td><strong>${s.college_code}</strong></td>
                    <td><code>${s.student_id}</code></td>
                    <td><strong>${s.full_name}</strong></td>
                    <td>${incLabel}</td>
                    <td>${s.impact_type}</td>
                  </tr>`
                )
                .join("")}
            </tbody>
          </table>
        </div>`;
    }
  }

  openModal("modalKpiDetail");
}

// Direct College Submission Form
document.getElementById("collegeDirectStudentForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errBox = document.getElementById("colDirectFormError");
  const okBox = document.getElementById("colDirectFormSuccess");
  errBox.classList.add("hidden");
  okBox.classList.add("hidden");

  if (!activeIncidentId) {
    errBox.textContent = "No active event is currently open. Please wait for CSU NSRC Admin to record an event.";
    errBox.classList.remove("hidden");
    return;
  }

  const payload = Object.fromEntries(new FormData(e.target).entries());
  payload.incident_id = activeIncidentId;

  const res = await fetch("/api/students", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!res.ok) {
    errBox.textContent = data.error;
    errBox.classList.remove("hidden");
    return;
  }

  e.target.reset();
  okBox.textContent = "Report submitted and recorded in the CSU NSRC database.";
  okBox.classList.remove("hidden");
  await refreshDashboard();
});

// =========================================================================
// MODALS & SHARED ACTIONS
// =========================================================================
function openModal(id) {
  document.getElementById(id).classList.remove("hidden");
}
function closeModal(id) {
  document.getElementById(id).classList.add("hidden");
}

function openAdminStudentModal(preselectCollegeCode = null) {
  if (!activeIncidentId) {
    alert("Please record an active incident first in 'Incident Reporting'.");
    return;
  }
  document.getElementById("studentForm").reset();
  document.getElementById("studentFormError").classList.add("hidden");

  if (preselectCollegeCode) {
    const col = dashboardData.college_stats.find((c) => c.college_code === preselectCollegeCode);
    if (col) document.getElementById("stuCollegeId").value = col.college_id;
  }
  openModal("modalStudent");
}

document.getElementById("studentForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = Object.fromEntries(new FormData(e.target).entries());
  payload.incident_id = activeIncidentId;
  const errBox = document.getElementById("studentFormError");
  errBox.classList.add("hidden");

  const res = await fetch("/api/students", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!res.ok) {
    errBox.textContent = data.error;
    errBox.classList.remove("hidden");
    return;
  }
  closeModal("modalStudent");
  await refreshDashboard();
});

// Edit / Update Submitted Student Details Modal
function openEditStudentModal(recordId) {
  const student = dashboardData.students.find((s) => s.record_id === recordId);
  if (!student) return;

  document.getElementById("editRecordId").value = student.record_id;
  document.getElementById("editStudentIdDisplay").value = `${student.student_id} (${student.college_code})`;
  document.getElementById("editFullName").value = student.full_name;
  document.getElementById("editProgram").value = student.program;
  document.getElementById("editAddress").value = student.address;
  document.getElementById("editBoardingHouse").value = student.boarding_house || "";
  document.getElementById("editContactNumber").value = student.contact_number || "";
  document.getElementById("editImpactType").value = student.impact_type;
  document.getElementById("editUpdateNote").value = "";

  openModal("modalEditStudent");
}

document.getElementById("editStudentForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const recordId = document.getElementById("editRecordId").value;
  const payload = {
    full_name: document.getElementById("editFullName").value,
    program: document.getElementById("editProgram").value,
    address: document.getElementById("editAddress").value,
    boarding_house: document.getElementById("editBoardingHouse").value,
    contact_number: document.getElementById("editContactNumber").value,
    impact_type: document.getElementById("editImpactType").value,
    update_note: document.getElementById("editUpdateNote").value
  };

  const res = await fetch(`/api/students/${recordId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (res.ok) {
    closeModal("modalEditStudent");
    await refreshDashboard();
  }
});

// NSRC Action & Audit Logs Modal
async function openCaseModal(recordId) {
  const student = dashboardData.students.find((s) => s.record_id === recordId);
  if (!student) return;

  const isAdmin = currentUser.role === "CSU_NSRC_ADMIN";
  document.getElementById("caseUpdateForm").classList.toggle("hidden", !isAdmin);

  document.getElementById("caseRecordId").value = recordId;
  document.getElementById("caseStudentSummary").innerHTML = `
    <strong>${student.full_name}</strong> (<code>${student.student_id}</code>) — <strong>${student.college_code}</strong><br>
    Program: ${student.program}<br>
    Address: ${student.address} ${student.boarding_house ? `| Boarding House: ${student.boarding_house}` : ""}<br>
    Contact: ${student.contact_number || "N/A"} | Impact: <strong>${student.impact_type}</strong><br>
    Current Status: <strong>${student.current_status}</strong>
  `;

  const centerSel = document.getElementById("caseCenterSelect");
  centerSel.innerHTML =
    `<option value="">-- Keep Current / No Shelter --</option>` +
    dashboardData.evacuation_centers
      .map((c) => `<option value="${c.center_id}">${c.name} (${c.max_capacity - c.current_occupancy} slots)</option>`)
      .join("");

  const logRes = await fetch(`/api/students/${recordId}/logs`);
  const logs = await logRes.json();
  document.getElementById("caseLogsList").innerHTML = logs
    .map(
      (l) => `
      <div class="audit-item">
        <strong>${l.status}</strong> — <span class="text-muted">by ${l.username}</span>
        <div>${l.action_taken}</div>
      </div>`
    )
    .join("");

  openModal("modalCase");
}

document.getElementById("caseUpdateForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const recordId = document.getElementById("caseRecordId").value;
  const payload = {
    status: document.getElementById("caseStatusSelect").value,
    assigned_center_id: document.getElementById("caseCenterSelect").value || null,
    action_taken: document.getElementById("caseActionNotes").value
  };

  const res = await fetch(`/api/students/${recordId}/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error);
    return;
  }
  document.getElementById("caseActionNotes").value = "";
  closeModal("modalCase");
  await refreshDashboard();
});

// Incident, Center, Item, Partner & Transaction Forms
document.getElementById("incidentForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = Object.fromEntries(new FormData(e.target).entries());
  const res = await fetch("/api/incidents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (res.ok) {
    e.target.reset();
    closeModal("modalIncident");
    await loadIncidents();
  }
});

document.getElementById("centerForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = Object.fromEntries(new FormData(e.target).entries());
  const res = await fetch("/api/centers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (res.ok) {
    e.target.reset();
    closeModal("modalCenter");
    await refreshDashboard();
  }
});

document.getElementById("itemForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = Object.fromEntries(new FormData(e.target).entries());
  const res = await fetch("/api/inventory", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (res.ok) {
    e.target.reset();
    closeModal("modalItem");
    await refreshDashboard();
  }
});

document.getElementById("partnerForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = Object.fromEntries(new FormData(e.target).entries());
  const res = await fetch("/api/partners", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (res.ok) {
    e.target.reset();
    closeModal("modalPartner");
    await refreshDashboard();
  }
});

function openTxModal(type) {
  if (!activeIncidentId) {
    alert("Please record an active incident first in 'Incident Reporting'.");
    return;
  }
  if (dashboardData.inventory.length === 0) {
    alert("Please add at least one relief item first in 'Relief Goods Records'.");
    return;
  }

  document.getElementById("txForm").reset();
  document.getElementById("txError").classList.add("hidden");
  document.getElementById("txType").value = type;
  document.getElementById("txModalTitle").textContent =
    type === "IN" ? "Log Incoming External Donation (IN)" : "Record Relief Goods Release (OUT)";
  document.getElementById("txPartnerGroup").classList.toggle("hidden", type !== "IN");
  document.getElementById("txSourceLabel").textContent =
    type === "IN" ? "Donation Reference / Delivery Notes *" : "Recipient (College / Evacuation Center / Student) *";

  document.getElementById("txItemSelect").innerHTML = dashboardData.inventory
    .map((i) => `<option value="${i.item_id}">${i.item_name} (${i.quantity_on_hand} ${i.unit})</option>`)
    .join("");

  document.getElementById("txPartnerSelect").innerHTML =
    `<option value="">-- Direct / Unlisted Donor --</option>` +
    dashboardData.partners
      .map((p) => `<option value="${p.partner_id}">${p.institution_name} (${p.partner_type})</option>`)
      .join("");

  openModal("modalTx");
}

document.getElementById("txForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = Object.fromEntries(new FormData(e.target).entries());
  payload.incident_id = activeIncidentId;
  const errBox = document.getElementById("txError");
  errBox.classList.add("hidden");

  const res = await fetch("/api/inventory/transactions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!res.ok) {
    errBox.textContent = data.error;
    errBox.classList.remove("hidden");
    return;
  }
  closeModal("modalTx");
  await refreshDashboard();
});

async function adjustOccupancy(centerId, delta) {
  await fetch(`/api/centers/${centerId}/occupancy`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ delta })
  });
  await refreshDashboard();
}

function exportAftermathReport(incidentId) {
  const targetId = incidentId || activeIncidentId;
  if (!targetId) {
    alert("No incident selected to export.");
    return;
  }
  window.location.href = `/api/incidents/${targetId}/export`;
}

checkSession();