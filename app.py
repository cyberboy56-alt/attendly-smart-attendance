import base64
import io
import json
import logging
import os
import re
import sqlite3
import threading
import time
from datetime import date, datetime
from pathlib import Path

import cv2
import numpy as np
import qrcode
from flask import Flask, current_app, jsonify, render_template, request, Response


BASE_DIR = Path(__file__).resolve().parent
DEFAULT_STUDENTS = (
    ("STU-1001", "Alex Morgan"),
    ("STU-1002", "Jamie Patel"),
    ("STU-1003", "Sam Rivera"),
)

app = Flask(__name__)
app.config.update(
    DATABASE=os.environ.get("ATTENDANCE_DATABASE", str(BASE_DIR / "attendance.db")),
    LATE_AFTER=os.environ.get("ATTENDANCE_LATE_AFTER", "09:00"),
    CAMERA_INDEX=int(os.environ.get("ATTENDANCE_CAMERA_INDEX", "0")),
    MAX_CONTENT_LENGTH=16 * 1024 * 1024,
)
logging.basicConfig(level=logging.INFO)
FACE_MATCH_THRESHOLD = 0.45
FACE_MATCH_MARGIN = 0.08
FACE_DETECTION_MODEL = BASE_DIR / "models" / "face_detection_yunet_2023mar.onnx"
FACE_RECOGNITION_MODEL = BASE_DIR / "models" / "face_recognition_sface_2021dec.onnx"
_face_model_lock = threading.Lock()
_face_inference_lock = threading.Lock()
_face_detector = None
_face_recognizer = None


def get_db():
    database_path = Path(current_app.config["DATABASE"])
    database_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(database_path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def initialize_database():
    with app.app_context():
        connection = get_db()
        try:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS students (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    student_code TEXT NOT NULL UNIQUE,
                    name TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    face_embedding TEXT,
                    face_consent_at TEXT
                );
                CREATE TABLE IF NOT EXISTS attendance (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
                    attendance_date TEXT NOT NULL,
                    scanned_at TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (status IN ('present', 'late')),
                    UNIQUE (student_id, attendance_date)
                );
                """
            )
            columns = {
                row["name"] for row in connection.execute("PRAGMA table_info(students)")
            }
            if "face_embedding" not in columns:
                connection.execute("ALTER TABLE students ADD COLUMN face_embedding TEXT")
            if "face_consent_at" not in columns:
                connection.execute("ALTER TABLE students ADD COLUMN face_consent_at TEXT")
            count = connection.execute("SELECT COUNT(*) FROM students").fetchone()[0]
            if count == 0:
                created_at = datetime.now().astimezone().isoformat(timespec="seconds")
                connection.executemany(
                    "INSERT INTO students (student_code, name, created_at) VALUES (?, ?, ?)",
                    [(code, name, created_at) for code, name in DEFAULT_STUDENTS],
                )
            connection.commit()
        finally:
            connection.close()


def qr_data_url(student_code):
    image = qrcode.make(student_code)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def student_payload(student):
    return {
        "id": student["id"],
        "student_code": student["student_code"],
        "name": student["name"],
        "qr_code": qr_data_url(student["student_code"]),
        "face_enrolled": bool(student["face_embedding"]),
    }


def mark_attendance(qr_value, scanned_at=None):
    code = qr_value.strip()
    if code.upper().startswith("ATTENDANCE:"):
        code = code.split(":", 1)[1].strip()
    if not code:
        return {"ok": False, "message": "The QR code did not contain a student ID."}, 400

    timestamp = scanned_at or datetime.now().astimezone()
    attendance_date = timestamp.date().isoformat()
    status = "late" if timestamp.strftime("%H:%M") > current_app.config["LATE_AFTER"] else "present"

    connection = get_db()
    try:
        student = connection.execute(
            "SELECT id, student_code, name FROM students WHERE student_code = ? COLLATE NOCASE",
            (code,),
        ).fetchone()
        if student is None:
            return {"ok": False, "message": f"No student found for QR code “{code}”."}, 404

        cursor = connection.execute(
            """
            INSERT OR IGNORE INTO attendance
                (student_id, attendance_date, scanned_at, status)
            VALUES (?, ?, ?, ?)
            """,
            (student["id"], attendance_date, timestamp.isoformat(timespec="seconds"), status),
        )
        connection.commit()
        if cursor.rowcount == 0:
            return {
                "ok": True,
                "duplicate": True,
                "message": f"{student['name']} is already checked in today.",
                "student": dict(student),
            }, 200
        return {
            "ok": True,
            "duplicate": False,
            "message": f"{student['name']} checked in as {status}.",
            "student": dict(student),
            "status": status,
        }, 201
    finally:
        connection.close()


def dashboard_data():
    connection = get_db()
    try:
        total = connection.execute("SELECT COUNT(*) FROM students").fetchone()[0]
        today_rows = connection.execute(
            """
            SELECT s.student_code, s.name, a.scanned_at, a.status
            FROM attendance a
            JOIN students s ON s.id = a.student_id
            WHERE a.attendance_date = ?
            ORDER BY a.scanned_at DESC
            """,
            (date.today().isoformat(),),
        ).fetchall()
        students = connection.execute(
            """
            SELECT id, student_code, name, face_embedding
            FROM students ORDER BY name COLLATE NOCASE
            """
        ).fetchall()
        present = sum(row["status"] == "present" for row in today_rows)
        late = sum(row["status"] == "late" for row in today_rows)
        return {
            "date": date.today().strftime("%A, %B %d, %Y"),
            "counts": {
                "present": present,
                "late": late,
                "absent": max(total - present - late, 0),
                "total": total,
            },
            "attendance": [
                {
                    "student_code": row["student_code"],
                    "name": row["name"],
                    "scanned_at": row["scanned_at"],
                    "status": row["status"],
                }
                for row in today_rows
            ],
            "students": [student_payload(student) for student in students],
            "late_after": current_app.config["LATE_AFTER"],
            "face_enrolled": sum(bool(student["face_embedding"]) for student in students),
        }
    finally:
        connection.close()


@app.route("/")
def index():
    data = dashboard_data()
    return render_template("index.html", **data)


@app.get("/api/dashboard")
def api_dashboard():
    return jsonify(dashboard_data())


@app.post("/api/scan")
def api_scan():
    body = request.get_json(silent=True)
    if not isinstance(body, dict) or not isinstance(body.get("qr_value"), str):
        return jsonify(ok=False, message="Send a QR code value in the qr_value field."), 400
    result, status = mark_attendance(body["qr_value"])
    return jsonify(result), status


@app.post("/api/students")
def api_add_student():
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify(ok=False, message="Send a student name and ID."), 400

    name = str(body.get("name", "")).strip()
    code = str(body.get("student_code", "")).strip().upper()
    if not name or len(name) > 80:
        return jsonify(ok=False, message="Enter a name between 1 and 80 characters."), 400
    if not re.fullmatch(r"[A-Z0-9][A-Z0-9_-]{1,31}", code):
        return jsonify(
            ok=False,
            message="Student ID must be 2–32 characters and use letters, numbers, hyphens, or underscores.",
        ), 400

    connection = get_db()
    try:
        cursor = connection.execute(
            "INSERT INTO students (student_code, name, created_at) VALUES (?, ?, ?)",
            (code, name, datetime.now().astimezone().isoformat(timespec="seconds")),
        )
        connection.commit()
        student = connection.execute(
            """
            SELECT id, student_code, name, face_embedding
            FROM students WHERE id = ?
            """,
            (cursor.lastrowid,),
        ).fetchone()
        return jsonify(ok=True, student=student_payload(student)), 201
    except sqlite3.IntegrityError:
        return jsonify(ok=False, message="That student ID is already on the roster."), 409
    finally:
        connection.close()


def get_face_models():
    global _face_detector, _face_recognizer
    if _face_detector is not None and _face_recognizer is not None:
        return _face_detector, _face_recognizer
    with _face_model_lock:
        if _face_detector is not None and _face_recognizer is not None:
            return _face_detector, _face_recognizer
        if not FACE_DETECTION_MODEL.is_file() or not FACE_RECOGNITION_MODEL.is_file():
            raise RuntimeError("The local face-recognition model files are missing.")
        detector = cv2.FaceDetectorYN_create(
            str(FACE_DETECTION_MODEL),
            "",
            (320, 320),
            0.8,
            0.3,
            5000,
        )
        recognizer = cv2.FaceRecognizerSF_create(str(FACE_RECOGNITION_MODEL), "")
        _face_detector = detector
        _face_recognizer = recognizer
        return _face_detector, _face_recognizer


def extract_face_embeddings(image_data, min_face_size=24):
    encoded = np.frombuffer(image_data, dtype=np.uint8)
    image = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("That file is not a supported image. Try a clear JPEG or PNG.")
    height, width = image.shape[:2]
    if width * height > 40_000_000:
        raise ValueError("That image is too large. Please use a photo under 40 megapixels.")
    largest_side = max(width, height)
    if largest_side > 2560:
        scale = 2560 / largest_side
        image = cv2.resize(image, (round(width * scale), round(height * scale)))
        height, width = image.shape[:2]

    detector, recognizer = get_face_models()
    embeddings = []
    with _face_inference_lock:
        detector.setInputSize((width, height))
        _, faces = detector.detect(image)
        if faces is None:
            return embeddings
        for face in faces:
            if min(face[2], face[3]) < min_face_size or face[14] < 0.85:
                continue
            aligned = recognizer.alignCrop(image, face)
            feature = recognizer.feature(aligned)
            feature = cv2.normalize(feature, None, norm_type=cv2.NORM_L2)
            embeddings.append(feature.flatten().astype(float).tolist())
    return embeddings


def closest_student(embedding, students):
    if not students:
        return None
    query = np.asarray(embedding, dtype=np.float32)
    query_norm = np.linalg.norm(query)
    if query_norm == 0:
        return None
    query /= query_norm
    ranked = []
    for student in students:
        reference = np.asarray(json.loads(student["face_embedding"]), dtype=np.float32)
        reference_norm = np.linalg.norm(reference)
        if reference_norm == 0:
            continue
        similarity = float(np.dot(query, reference / reference_norm))
        ranked.append((similarity, student))
    ranked.sort(key=lambda candidate: candidate[0], reverse=True)
    if not ranked or ranked[0][0] < FACE_MATCH_THRESHOLD:
        return None
    if len(ranked) > 1 and ranked[0][0] - ranked[1][0] < FACE_MATCH_MARGIN:
        return None
    return ranked[0][1]


@app.post("/api/students/<student_code>/face")
def api_enroll_face(student_code):
    image = request.files.get("photo")
    if not image or not image.filename:
        return jsonify(ok=False, message="Choose a clear photo showing exactly one face."), 400
    if request.form.get("consent") != "yes":
        return jsonify(
            ok=False,
            message="Confirm that the student or their guardian has agreed to face check-in.",
        ), 400

    try:
        embeddings = extract_face_embeddings(image.read(), min_face_size=80)
    except ValueError as error:
        return jsonify(ok=False, message=str(error)), 400
    except (RuntimeError, cv2.error):
        logging.exception("Face enrollment could not load or use local recognition models")
        return jsonify(
            ok=False,
            message="Face matching is unavailable. Check that the local model files are installed.",
        ), 503
    if len(embeddings) != 1:
        return jsonify(
            ok=False,
            message="The enrollment photo must contain exactly one clear, front-facing face.",
        ), 400

    connection = get_db()
    try:
        cursor = connection.execute(
            """
            UPDATE students
            SET face_embedding = ?, face_consent_at = ?
            WHERE student_code = ? COLLATE NOCASE
            """,
            (
                json.dumps(embeddings[0], separators=(",", ":")),
                datetime.now().astimezone().isoformat(timespec="seconds"),
                student_code,
            ),
        )
        if cursor.rowcount == 0:
            return jsonify(ok=False, message="That student is not on the roster."), 404
        connection.commit()
        return jsonify(ok=True, message="Face template saved locally. The uploaded photo was discarded.")
    finally:
        connection.close()


@app.delete("/api/students/<student_code>/face")
def api_remove_face(student_code):
    connection = get_db()
    try:
        cursor = connection.execute(
            """
            UPDATE students SET face_embedding = NULL, face_consent_at = NULL
            WHERE student_code = ? COLLATE NOCASE
            """,
            (student_code,),
        )
        if cursor.rowcount == 0:
            return jsonify(ok=False, message="That student is not on the roster."), 404
        connection.commit()
        return jsonify(ok=True, message="The local face template was removed.")
    finally:
        connection.close()


@app.post("/api/capture")
def api_capture_class_photo():
    image = request.files.get("photo")
    if not image or not image.filename:
        return jsonify(ok=False, message="Choose or capture a class photo first."), 400
    try:
        embeddings = extract_face_embeddings(image.read())
    except ValueError as error:
        return jsonify(ok=False, message=str(error)), 400
    except (RuntimeError, cv2.error):
        logging.exception("Class photo could not be processed by the local recognition models")
        return jsonify(
            ok=False,
            message="Face matching is unavailable. Check that the local model files are installed.",
        ), 503
    if not embeddings:
        return jsonify(
            ok=False,
            message="No clear faces found. Try a brighter photo with faces looking toward the camera.",
        ), 422

    connection = get_db()
    try:
        enrolled = connection.execute(
            """
            SELECT id, student_code, name, face_embedding
            FROM students WHERE face_embedding IS NOT NULL
            """
        ).fetchall()
        recognized = []
        seen_student_ids = set()
        for embedding in embeddings:
            student = closest_student(embedding, enrolled)
            if student is None or student["id"] in seen_student_ids:
                continue
            seen_student_ids.add(student["id"])
            result, _ = mark_attendance(student["student_code"])
            recognized.append({
                "name": student["name"],
                "student_code": student["student_code"],
                "message": result["message"],
                "status": result.get("status", "already checked in"),
            })
        return jsonify(
            ok=True,
            faces_detected=len(embeddings),
            recognized=recognized,
            unknown_faces=max(len(embeddings) - len(recognized), 0),
            message=f"Found {len(embeddings)} face(s); checked in {sum(item['status'] in ('present', 'late') for item in recognized)} student(s).",
        )
    finally:
        connection.close()


@app.errorhandler(413)
def request_too_large(_error):
    return jsonify(ok=False, message="Photo is too large. Choose an image smaller than 16 MB."), 413


class CameraScanner:
    def __init__(self):
        self.camera_index = app.config["CAMERA_INDEX"]
        self.lock = threading.Lock()
        self.start_lock = threading.Lock()
        self.thread = None
        self.jpeg = None
        self.status = "Camera has not started"
        self.last_event = "Waiting for camera"

    def start(self):
        with self.start_lock:
            if self.thread is None or not self.thread.is_alive():
                self.thread = threading.Thread(target=self._capture, daemon=True, name="attendance-camera")
                self.thread.start()

    def snapshot(self):
        with self.lock:
            return self.jpeg, self.status, self.last_event

    def update(self, *, jpeg=None, status=None, event=None):
        with self.lock:
            if jpeg is not None:
                self.jpeg = jpeg
            if status is not None:
                self.status = status
            if event is not None:
                self.last_event = event

    def _capture(self):
        detector = cv2.QRCodeDetector()
        while True:
            camera = cv2.VideoCapture(self.camera_index)
            if not camera.isOpened():
                camera.release()
                self.update(status="Camera unavailable", event="Check camera permissions or ATTENDANCE_CAMERA_INDEX")
                logging.warning("Could not open webcam at index %s", self.camera_index)
                time.sleep(5)
                continue

            self.update(status="Camera connected", event="Show a student QR code to check in")
            last_qr_value = None
            last_qr_seen_at = 0
            while camera.isOpened():
                ok, frame = camera.read()
                if not ok:
                    self.update(status="Camera interrupted", event="Reconnecting to webcam")
                    break
                try:
                    value, points, _ = detector.detectAndDecode(frame)
                    if points is not None:
                        cv2.polylines(frame, [points.astype(int)], True, (74, 222, 128), 3)
                    if value:
                        last_qr_seen_at = time.monotonic()
                        if value != last_qr_value:
                            last_qr_value = value
                            with app.app_context():
                                result, code = mark_attendance(value)
                            self.update(event=result["message"])
                            if code == 404:
                                logging.info("QR scan did not match a student: %s", value)
                    elif last_qr_value and time.monotonic() - last_qr_seen_at > 1:
                        last_qr_value = None
                except (cv2.error, sqlite3.Error):
                    logging.exception("Unable to process webcam frame or record attendance")

                encoded_ok, encoded = cv2.imencode(".jpg", frame)
                if encoded_ok:
                    self.update(jpeg=encoded.tobytes())

            camera.release()
            time.sleep(1)


scanner = CameraScanner()


def camera_stream():
    scanner.start()
    while True:
        jpeg, _, _ = scanner.snapshot()
        if jpeg:
            yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + jpeg + b"\r\n"
        else:
            time.sleep(0.1)


@app.get("/video_feed")
def video_feed():
    return Response(camera_stream(), mimetype="multipart/x-mixed-replace; boundary=frame")


@app.get("/api/camera-status")
def camera_status():
    _, status, event = scanner.snapshot()
    return jsonify(status=status, event=event)


initialize_database()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "5000")), debug=False, threaded=True)
