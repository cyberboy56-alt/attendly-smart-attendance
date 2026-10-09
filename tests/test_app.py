import os
import tempfile
import unittest
from io import BytesIO
from datetime import datetime
from unittest.mock import patch

from app import app, initialize_database


class AttendanceAppTests(unittest.TestCase):
    def setUp(self):
        self.database = tempfile.NamedTemporaryFile(delete=False)
        self.database.close()
        app.config.update(TESTING=True, DATABASE=self.database.name, LATE_AFTER="09:00")
        initialize_database()
        self.client = app.test_client()

    def tearDown(self):
        os.unlink(self.database.name)

    def test_dashboard_has_seeded_roster_and_absent_count(self):
        response = self.client.get("/api/dashboard")
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(data["counts"], {"present": 0, "late": 0, "absent": 3, "total": 3})
        self.assertEqual(len(data["students"]), 3)
        self.assertTrue(data["students"][0]["qr_code"].startswith("data:image/png;base64,"))
        self.assertFalse(data["students"][0]["face_enrolled"])

    def test_homepage_renders_responsive_dashboard(self):
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"Smart attendance terminal", response.data)
        self.assertIn(b"tailwindcss.com", response.data)
        self.assertIn(b"/video_feed", response.data)

    def test_scan_marks_student_present_and_prevents_duplicate(self):
        scanned_at = datetime.now().astimezone().replace(hour=8, minute=59)
        with app.test_request_context():
            from app import mark_attendance
            first, first_status = mark_attendance("ATTENDANCE:STU-1001", scanned_at)
            second, second_status = mark_attendance("STU-1001", scanned_at)
        self.assertEqual(first_status, 201)
        self.assertEqual(first["status"], "present")
        self.assertEqual(second_status, 200)
        self.assertTrue(second["duplicate"])
        dashboard = self.client.get("/api/dashboard").get_json()
        self.assertEqual(dashboard["counts"]["present"], 1)
        self.assertEqual(dashboard["counts"]["absent"], 2)

    def test_scan_marks_late_and_rejects_unknown_code(self):
        scanned_at = datetime.now().astimezone().replace(hour=9, minute=1)
        with app.test_request_context():
            from app import mark_attendance
            result, status = mark_attendance("STU-1002", scanned_at)
            missing, missing_status = mark_attendance("STU-9999", scanned_at)
        self.assertEqual(status, 201)
        self.assertEqual(result["status"], "late")
        self.assertEqual(missing_status, 404)
        self.assertFalse(missing["ok"])

    def test_add_student_validates_and_rejects_duplicate_ids(self):
        response = self.client.post("/api/students", json={"name": "Taylor Brooks", "student_code": "stu-2001"})
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.get_json()["student"]["student_code"], "STU-2001")
        duplicate = self.client.post("/api/students", json={"name": "Another Learner", "student_code": "STU-2001"})
        invalid = self.client.post("/api/students", json={"name": "Learner", "student_code": "!"})
        self.assertEqual(duplicate.status_code, 409)
        self.assertEqual(invalid.status_code, 400)

    def test_face_enrollment_requires_permission_and_discards_original_photo(self):
        photo = (BytesIO(b"fake image"), "reference.jpg")
        no_consent = self.client.post(
            "/api/students/STU-1001/face",
            data={"photo": photo},
            content_type="multipart/form-data",
        )
        self.assertEqual(no_consent.status_code, 400)

        with patch("app.extract_face_embeddings", return_value=[[1.0, 0.0]]):
            enrolled = self.client.post(
                "/api/students/STU-1001/face",
                data={"consent": "yes", "photo": (BytesIO(b"fake image"), "reference.jpg")},
                content_type="multipart/form-data",
            )
        self.assertEqual(enrolled.status_code, 200)
        self.assertIn("discarded", enrolled.get_json()["message"])
        dashboard = self.client.get("/api/dashboard").get_json()
        self.assertTrue(dashboard["students"][0]["face_enrolled"])

    def test_class_photo_auto_checks_in_confident_match_and_template_can_be_removed(self):
        with patch("app.extract_face_embeddings", return_value=[[1.0, 0.0]]):
            self.client.post(
                "/api/students/STU-1001/face",
                data={"consent": "yes", "photo": (BytesIO(b"reference"), "reference.jpg")},
                content_type="multipart/form-data",
            )
            capture = self.client.post(
                "/api/capture",
                data={"photo": (BytesIO(b"class photo"), "class.jpg")},
                content_type="multipart/form-data",
            )
        self.assertEqual(capture.status_code, 200)
        self.assertEqual(capture.get_json()["recognized"][0]["student_code"], "STU-1001")
        counts = self.client.get("/api/dashboard").get_json()["counts"]
        self.assertEqual(counts["present"] + counts["late"], 1)
        removed = self.client.delete("/api/students/STU-1001/face")
        self.assertEqual(removed.status_code, 200)
        dashboard = self.client.get("/api/dashboard").get_json()
        self.assertFalse(dashboard["students"][0]["face_enrolled"])


if __name__ == "__main__":
    unittest.main()
