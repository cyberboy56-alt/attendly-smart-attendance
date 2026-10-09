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

async function readApiResult(response, fallback) {
  if (response.status === 413) {
    return { ok: false, message: "The upload is too large. Choose a smaller photo or upload fewer photos at once." };
  }
  try {
    return await response.json();
  } catch {
    return { ok: false, message: `${fallback} (server returned HTTP ${response.status}).` };
  }
}

async function compressPhoto(file) {
  if (!file.type.startsWith("image/")) {
    throw new Error(`${file.name} is not a supported image file.`);
  }
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = objectUrl;
    try {
      await image.decode();
    } catch {
      throw new Error(`Could not open ${file.name}. Choose a JPEG or PNG image instead.`);
    }
    const scale = Math.min(1, 1920 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot resize the selected photo.");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.84));
    if (!blob) throw new Error(`Could not prepare ${file.name}. Try another image.`);
    return new File([blob], `${file.name.replace(/\.[^.]+$/, "") || "photo"}.jpg`, {
      type: "image/jpeg",
      lastModified: file.lastModified
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
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
      <div class="manual-attendance">
        <label class="sr-only" for="manual-status-${escapeHtml(student.student_code)}">Today's attendance for ${escapeHtml(student.name)}</label>
        <select id="manual-status-${escapeHtml(student.student_code)}" data-manual-status="${escapeHtml(student.student_code)}">
          <option value="absent" ${!student.today_status || student.today_status === "absent" ? "selected" : ""}>Absent</option>
          <option value="present" ${student.today_status === "present" ? "selected" : ""}>Present</option>
          <option value="late" ${student.today_status === "late" ? "selected" : ""}>Late</option>
        </select>
        <button type="button" data-manual-save="${escapeHtml(student.student_code)}">Save</button>
      </div>
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
    const result = await readApiResult(response, "Unable to add student.");
    if (!response.ok || result.ok === false) throw new Error(result.message || "Unable to add student.");
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
  const manualButton = event.target.closest("[data-manual-save]");
  if (manualButton) {
    const code = manualButton.dataset.manualSave;
    const status = manualButton.closest(".student-card").querySelector("[data-manual-status]").value;
    manualButton.disabled = true;
    csrfFetch(`/api/attendance/${encodeURIComponent(code)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ status })
    })
      .then(async response => {
        const result = await readApiResult(response, "Unable to update attendance.");
        if (!response.ok || result.ok === false) throw new Error(result.message || "Unable to update attendance.");
        await refreshDashboard();
        showToast(result.message);
      })
      .catch(error => showToast(error.message))
      .finally(() => { manualButton.disabled = false; });
    return;
  }
  const removeButton = event.target.closest("[data-remove-face]");
  if (removeButton) {
    const code = removeButton.dataset.removeFace;
    if (!window.confirm(`Remove ${code}'s locally saved face template?`)) return;
    csrfFetch(`/api/students/${encodeURIComponent(code)}/face`, { method: "DELETE" })
      .then(async response => {
        const result = await readApiResult(response, "Unable to remove face template.");
        if (!response.ok || result.ok === false) throw new Error(result.message || "Unable to remove face template.");
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
  submitButton.disabled = true;
  errorMessage.textContent = "";
  try {
    body.append("photo", await compressPhoto(photo));
    body.append("consent", "yes");
    const response = await csrfFetch(`/api/students/${encodeURIComponent(selectedStudentCode)}/face`, {
      method: "POST",
      body
    });
    const result = await readApiResult(response, "Unable to enroll this face.");
    if (!response.ok || result.ok === false) throw new Error(result.message || "Unable to enroll this face.");
    enrollDialog.close();
    await refreshDashboard();
    showToast(result.message);
  } catch (error) {
    errorMessage.textContent = error.message;
  } finally {
    submitButton.disabled = false;
  }
});

const classGalleryInput = document.getElementById("class-gallery-input");
const classCameraInput = document.getElementById("class-camera-input");
const classPhotoPreviews = document.getElementById("class-photo-previews");
const analyzeButton = document.getElementById("analyze-class-photo");
let selectedClassPhotos = [];
let classPhotoPreviewUrls = [];

function showClassPhotoSelection() {
  classPhotoPreviewUrls.forEach(URL.revokeObjectURL);
  classPhotoPreviewUrls = [];
  classPhotoPreviews.replaceChildren();
  selectedClassPhotos.forEach((photo, index) => {
    const url = URL.createObjectURL(photo);
    classPhotoPreviewUrls.push(url);
    const preview = document.createElement("img");
    preview.src = url;
    preview.alt = `Selected class photo ${index + 1}`;
    classPhotoPreviews.append(preview);
  });
  analyzeButton.disabled = selectedClassPhotos.length === 0;
  document.getElementById("clear-class-photos").hidden = selectedClassPhotos.length === 0;
  document.getElementById("photo-feedback").textContent = selectedClassPhotos.length
    ? `${selectedClassPhotos.length} of 6 photo(s) selected. Photos are resized before upload and discarded after processing.`
    : "Choose up to six images or take photos one at a time. Bright, front-facing photos work best.";
}

document.getElementById("pick-class-gallery").addEventListener("click", () => classGalleryInput.click());
document.getElementById("capture-class-photo").addEventListener("click", () => classCameraInput.click());
document.getElementById("clear-class-photos").addEventListener("click", () => {
  selectedClassPhotos = [];
  classGalleryInput.value = "";
  classCameraInput.value = "";
  document.getElementById("photo-matches").replaceChildren();
  showClassPhotoSelection();
});
classGalleryInput.addEventListener("change", () => {
  selectedClassPhotos = Array.from(classGalleryInput.files).slice(0, 6);
  document.getElementById("photo-matches").replaceChildren();
  showClassPhotoSelection();
  if (classGalleryInput.files.length > 6) {
    document.getElementById("photo-feedback").textContent = "Only the first six selected photos were kept.";
  }
});
classCameraInput.addEventListener("change", () => {
  if (classCameraInput.files[0]) {
    document.getElementById("photo-matches").replaceChildren();
    if (selectedClassPhotos.length === 6) {
      document.getElementById("photo-feedback").textContent = "You already have six photos. Clear the selection before adding another.";
      classCameraInput.value = "";
      return;
    }
    selectedClassPhotos.push(classCameraInput.files[0]);
    showClassPhotoSelection();
  }
  classCameraInput.value = "";
});

document.getElementById("class-photo-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!selectedClassPhotos.length) return;
  const feedback = document.getElementById("photo-feedback");
  const matches = document.getElementById("photo-matches");
  const body = new FormData();
  try {
    feedback.textContent = `Preparing ${selectedClassPhotos.length} photo(s)…`;
    for (const photo of selectedClassPhotos) {
      body.append("photos", await compressPhoto(photo));
    }
  } catch (error) {
    feedback.textContent = error.message;
    return;
  }
  analyzeButton.disabled = true;
  feedback.textContent = "Looking for enrolled faces…";
  matches.replaceChildren();
  try {
    const response = await csrfFetch("/api/capture", { method: "POST", body });
    const result = await readApiResult(response, "The class photos could not be analyzed.");
    if (!response.ok || result.ok === false) throw new Error(result.message || "The class photo could not be analyzed.");
    feedback.textContent = `${result.message} ${result.unknown_faces} unmatched or already-seen face(s).`;
    matches.innerHTML = result.recognized.map(student =>
      `<div class="photo-match"><span>✓</span><strong>${escapeHtml(student.name)}</strong><small>${escapeHtml(student.status)}</small></div>`
    ).join("") || '<div class="photo-no-matches">No enrolled student was confidently matched. Try a clearer photo or use QR check-in.</div>';
    showToast(result.message);
    await refreshDashboard();
    selectedClassPhotos = [];
    classGalleryInput.value = "";
    showClassPhotoSelection();
  } catch (error) {
    feedback.textContent = error.message;
  } finally {
    analyzeButton.disabled = selectedClassPhotos.length === 0;
  }
});

refreshCameraStatus();
window.setInterval(refreshDashboard, 3000);
window.setInterval(refreshCameraStatus, 2500);
