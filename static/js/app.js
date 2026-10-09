const attendanceList = document.getElementById("attendance-list");
const studentGrid = document.getElementById("student-grid");
const dialog = document.getElementById("student-dialog");
const form = document.getElementById("student-form");
const toast = document.getElementById("toast");
const csrfToken = document.querySelector('meta[name="csrf-token"]').content;
let toastTimeout;
let lastAnnouncement = "";

function csrfFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("X-CSRF-Token", csrfToken);
  return fetch(url, { ...options, headers });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function updateDashboard(data) {
  document.getElementById("count-present").textContent = data.counts.present;
  document.getElementById("count-absent").textContent = data.counts.absent;
  document.getElementById("count-late").textContent = data.counts.late;
  document.getElementById("count-total").textContent = data.counts.total;
  document.getElementById("terminal-count").textContent = data.counts.present + data.counts.late;
  document.getElementById("class-date").textContent = data.date;
  document.getElementById("top-date").textContent = data.date;
  document.getElementById("activity-count").textContent = `${data.attendance.length} today`;
  renderAttendance(data.attendance);
  renderStudents(data.students);
}

function renderAttendance(entries) {
  if (!entries.length) {
    attendanceList.innerHTML = '<div class="empty-state"><div class="empty-icon">◷</div><strong>It’s a fresh start.</strong><span>Student check-ins will show up here.</span></div>';
    return;
  }
  attendanceList.innerHTML = entries.map(entry => {
    const time = new Date(entry.scanned_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return `<div class="attendance-row">
      <div class="avatar student-avatar">${escapeHtml(entry.name.slice(0, 1).toUpperCase())}</div>
      <div class="attendance-person"><strong>${escapeHtml(entry.name)}</strong><span>${escapeHtml(entry.student_code)}</span></div>
      <div class="attendance-result"><span class="result-pill ${escapeHtml(entry.status)}">${escapeHtml(entry.status)}</span><time>${escapeHtml(time)}</time></div>
    </div>`;
  }).join("");
}

function renderStudents(students) {
  if (!students.length) {
    studentGrid.innerHTML = '<div class="roster-empty">Add your first student to create their personal check-in QR code.</div>';
    return;
  }
  studentGrid.innerHTML = students.map(student => `<article class="student-card" data-code="${escapeHtml(student.student_code)}">
    <img class="student-qr" src="${student.qr_code}" alt="QR code for ${escapeHtml(student.name)}">
    <div class="student-card-body">
      <div class="student-card-info"><div class="avatar student-avatar">${escapeHtml(student.name.slice(0, 1).toUpperCase())}</div>
      <div><strong>${escapeHtml(student.name)}</strong><span>${escapeHtml(student.student_code)}</span></div></div>
      <span class="face-state ${student.face_enrolled ? "enrolled" : ""}">${student.face_enrolled ? "Face enrolled" : "QR check-in only"}</span>
      <button class="face-action" type="button" data-face-action="${escapeHtml(student.student_code)}">${student.face_enrolled ? "Replace face photo" : "Enroll face photo"}</button>
      ${student.face_enrolled ? `<button class="remove-face-action" type="button" data-remove-face="${escapeHtml(student.student_code)}">Remove saved face template</button>` : ""}
    </div>
  </article>`).join("");
}

async function refreshDashboard() {
  try {
    const response = await fetch("/api/dashboard", { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`Dashboard request failed (${response.status})`);
    updateDashboard(await response.json());
  } catch (error) {
    console.error(error);
    showToast("Couldn't refresh attendance. Check that the app is still running.");
  }
}

async function refreshCameraStatus() {
  try {
    const response = await fetch("/api/camera-status");
    if (!response.ok) throw new Error(`Camera status request failed (${response.status})`);
    const camera = await response.json();
    document.getElementById("camera-label").textContent = camera.status.toUpperCase();
    document.getElementById("camera-event").textContent = camera.event;
    if (camera.event && camera.event !== lastAnnouncement && camera.event.includes("checked in")) {
      showToast(camera.event);
      lastAnnouncement = camera.event;
    }
  } catch (error) {
    console.error(error);
  }
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  window.clearTimeout(toastTimeout);
  toastTimeout = window.setTimeout(() => toast.classList.remove("visible"), 3200);
}

document.getElementById("open-add-student").addEventListener("click", () => {
  document.getElementById("form-error").textContent = "";
  dialog.showModal();
  document.getElementById("student-name").focus();
});

document.getElementById("close-dialog").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", event => {
  if (event.target === dialog) dialog.close();
});

form.addEventListener("submit", async event => {
  event.preventDefault();
  const submitButton = form.querySelector(".submit-button");
  const errorMessage = document.getElementById("form-error");
  submitButton.disabled = true;
  errorMessage.textContent = "";
  try {
    const response = await csrfFetch("/api/students", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        name: document.getElementById("student-name").value,
        student_code: document.getElementById("student-code").value
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || "Unable to add student.");
    await refreshDashboard();
    form.reset();
    dialog.close();
    showToast(`${result.student.name} is on the roster. Their QR code is ready!`);
  } catch (error) {
    errorMessage.textContent = error.message;
  } finally {
    submitButton.disabled = false;
  }
});

const enrollDialog = document.getElementById("enroll-dialog");
let selectedStudentCode = "";

studentGrid.addEventListener("click", event => {
  const removeButton = event.target.closest("[data-remove-face]");
  if (removeButton) {
    const code = removeButton.dataset.removeFace;
    if (!window.confirm(`Remove ${code}'s locally saved face template?`)) return;
    csrfFetch(`/api/students/${encodeURIComponent(code)}/face`, { method: "DELETE" })
      .then(async response => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.message || "Unable to remove face template.");
        await refreshDashboard();
        showToast(result.message);
      })
      .catch(error => showToast(error.message));
    return;
  }
  const button = event.target.closest("[data-face-action]");
  if (!button) return;
  selectedStudentCode = button.dataset.faceAction;
  document.getElementById("enroll-error").textContent = "";
  document.getElementById("enroll-form").reset();
  enrollDialog.showModal();
});

document.getElementById("close-enroll-dialog").addEventListener("click", () => enrollDialog.close());
enrollDialog.addEventListener("click", event => {
  if (event.target === enrollDialog) enrollDialog.close();
});

document.getElementById("enroll-form").addEventListener("submit", async event => {
  event.preventDefault();
  const errorMessage = document.getElementById("enroll-error");
  const submitButton = event.currentTarget.querySelector(".submit-button");
  const photo = document.getElementById("enroll-photo").files[0];
  if (!photo || !document.getElementById("enroll-consent").checked) return;
  const body = new FormData();
  body.append("photo", photo);
  body.append("consent", "yes");
  submitButton.disabled = true;
  errorMessage.textContent = "";
  try {
    const response = await csrfFetch(`/api/students/${encodeURIComponent(selectedStudentCode)}/face`, {
      method: "POST",
      body
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || "Unable to enroll this face.");
    enrollDialog.close();
    await refreshDashboard();
    showToast(result.message);
  } catch (error) {
    errorMessage.textContent = error.message;
  } finally {
    submitButton.disabled = false;
  }
});

const classPhotoInput = document.getElementById("class-photo-input");
const classPhotoPreview = document.getElementById("class-photo-preview");
const analyzeButton = document.getElementById("analyze-class-photo");
let previewObjectUrl = null;
document.getElementById("pick-class-photo").addEventListener("click", () => classPhotoInput.click());
classPhotoInput.addEventListener("change", () => {
  const photo = classPhotoInput.files[0];
  const feedback = document.getElementById("photo-feedback");
  document.getElementById("photo-matches").replaceChildren();
  if (!photo) {
    classPhotoPreview.hidden = true;
    analyzeButton.disabled = true;
    feedback.textContent = "For best results, use a bright, front-facing photo.";
    return;
  }
  if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
  previewObjectUrl = URL.createObjectURL(photo);
  classPhotoPreview.src = previewObjectUrl;
  classPhotoPreview.hidden = false;
  analyzeButton.disabled = false;
  feedback.textContent = `${photo.name} is ready. Photos are processed locally and discarded.`;
});

document.getElementById("class-photo-form").addEventListener("submit", async event => {
  event.preventDefault();
  const photo = classPhotoInput.files[0];
  if (!photo) return;
  const feedback = document.getElementById("photo-feedback");
  const matches = document.getElementById("photo-matches");
  const body = new FormData();
  body.append("photo", photo);
  analyzeButton.disabled = true;
  feedback.textContent = "Looking for enrolled faces…";
  matches.replaceChildren();
  try {
    const response = await csrfFetch("/api/capture", { method: "POST", body });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || "The class photo could not be analyzed.");
    feedback.textContent = `${result.message} ${result.unknown_faces} unmatched or already-seen face(s).`;
    matches.innerHTML = result.recognized.map(student =>
      `<div class="photo-match"><span>✓</span><strong>${escapeHtml(student.name)}</strong><small>${escapeHtml(student.status)}</small></div>`
    ).join("") || '<div class="photo-no-matches">No enrolled student was confidently matched. Try a clearer photo or use QR check-in.</div>';
    showToast(result.message);
    await refreshDashboard();
    classPhotoInput.value = "";
    classPhotoPreview.hidden = true;
    if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = null;
  } catch (error) {
    feedback.textContent = error.message;
  } finally {
    analyzeButton.disabled = false;
  }
});

refreshCameraStatus();
window.setInterval(refreshDashboard, 3000);
window.setInterval(refreshCameraStatus, 2500);
