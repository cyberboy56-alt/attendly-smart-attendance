# Attendly — smart classroom attendance

A local Flask attendance dashboard with an SQLite roster, live OpenCV webcam preview, QR-based check-in, phone-captured group photo check-in, and a responsive Tailwind-powered interface.

## Web preview and deployment

GitHub hosts this repository's source code; GitHub Pages cannot run the Flask server, SQLite database, or webcam endpoints. A successful Pages build therefore does not mean the attendance dashboard is running. Start the free Render setup with one click:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2Fcyberboy56-alt%2Fattendly-smart-attendance)

### Quick setup

1. Sign in to Render and authorize access to this public GitHub repository.
2. Review the blueprint and choose **Apply** to create the free web service.
3. Enter a unique teacher password of at least 16 characters when prompted. Render generates `SECRET_KEY`; wait for the service build to finish, then open the `onrender.com` URL Render provides.

The form is quick to complete, but account authorization, build time, and service startup depend on Render and may take longer than 50 seconds. This free blueprint stores SQLite data in temporary `/tmp` storage; free services can spin down while idle and local files may be lost on restart or redeploy. Use fictional data only—not real attendance records or face templates. Persistent attendance data requires paid hosting with persistent storage or an external managed database. Keep the teacher password private.

## Start the app

Use Python 3.10 or newer.

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python app.py
```

Open [http://127.0.0.1:5000](http://127.0.0.1:5000). On first start, the app creates `attendance.db` and adds three sample learners. Remove the sample entries from the database before using real class records.

## Deploy privately to Render

This repository includes a Render Blueprint (`render.yaml`); use the one-click **Deploy to Render** button above, or choose **New → Blueprint** in Render and select this repository. The blueprint provisions a free web service and stores its SQLite database in temporary storage. Free services may spin down while idle, and app files may be cleared on restart or redeploy; use fictional demo data only. For real attendance records or face templates, use paid hosting with persistent storage or a managed database. Render generates `SECRET_KEY` and asks you to set `ATTENDANCE_PASSWORD`. Set a unique password with at least 16 characters in Render's secret environment variable prompt before the first deploy. The app refuses to start on Render without teacher authentication, a valid password, and a generated session secret.

After Render reports the service is live, open the service's **`https://…onrender.com`** URL and sign in with that teacher password. The HTTPS page can open the teacher's phone camera to capture a class photo. The hosted Render service has no access to the computer's webcam; it uses phone photo check-in instead. Keep the service private to intended teachers and do not share the URL or password publicly: this app handles student attendance and biometric face templates. Publicly publishing its *source* is not the same as making student records public. Review applicable school policies and obtain guardian/student permission before enrolling faces.

The single shared teacher password and in-memory login throttling are basic safeguards for a small private pilot, not an identity system for a school deployment. For production, use an organization-managed identity provider, audit logging, a formal retention/deletion policy, and a security review before using student biometric data.

The webcam runs on the computer hosting Flask. Allow camera access in the operating system, connect a webcam, then display or print a learner's QR code from the dashboard. The QR code contains the learner's student ID. A scan records one check-in per student per day; check-ins after 09:00 are marked late by default.

## Phone photo check-in

1. On each student card, select **Enroll face photo**, upload one clear, front-facing photo, and confirm student/guardian permission. Sample students are not enrolled.
2. Connect the teacher's phone and the computer running Flask to the same trusted Wi-Fi network.
3. Find the computer's private IPv4 address with `ipconfig` on Windows, then open `http://<computer-ip>:5000` on the teacher's phone.
4. Choose **Use phone camera**, capture the class, and select **Recognize & check in**. Confident matches are automatically checked in; uncertain and unknown faces are not. The attendance list and counts refresh automatically.

The app processes enrollment and class images locally using the bundled OpenCV YuNet detector and SFace recognizer. It discards uploaded photo files after processing and stores only face-embedding templates in SQLite. Templates can be replaced or removed on each student's card. Recognition may miss faces or match incorrectly, especially with small, turned, obscured, or poorly lit faces. Check the attendance list and correct errors using your normal attendance process; this is not a substitute for a reliable manual record. Photos and templates are sensitive biometric data: enroll only with appropriate student/guardian permission, follow your school's retention rules, and don't use public or untrusted Wi-Fi. The development server has no teacher login and must not be exposed to the public internet.

The face-recognition model files are from [OpenCV Zoo](https://github.com/opencv/opencv_zoo) and are distributed under the included Apache License 2.0 (`models/LICENSE-2.0`).

## Settings

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `ATTENDANCE_DATABASE` | `attendance.db` beside `app.py` | SQLite database file |
| `ATTENDANCE_CAMERA_INDEX` | `0` | OpenCV webcam index |
| `ATTENDANCE_LATE_AFTER` | `09:00` | Local 24-hour cutoff; later arrivals are marked late |
| `ATTENDANCE_TIMEZONE` | `Asia/Kolkata` | IANA timezone used to determine attendance day and late cutoff |
| `PORT` | `5000` | Local Flask port |

The Flask development server listens on all interfaces to allow a phone on the same Wi-Fi to connect. Restrict access with your network firewall and use only a trusted private network. The page loads Tailwind CSS from its CDN. An internet connection is needed for those utility styles; the dashboard's custom stylesheet remains local.

## API

- `GET /api/dashboard` — today's summary, attendance log, roster, and QR images.
- `GET /api/camera-status` — webcam connection state and latest scan message.
- `GET /video_feed` — OpenCV MJPEG webcam stream.
- `POST /api/students` — add a learner using JSON `{ "name": "...", "student_code": "..." }`.
- `POST /api/students/<student_code>/face` — enroll one face from multipart fields `photo` and `consent=yes`.
- `DELETE /api/students/<student_code>/face` — remove a learner's saved face template.
- `POST /api/capture` — process a group image from multipart field `photo` and record confident matches.
- `POST /api/scan` — record a QR value using JSON `{ "qr_value": "STU-1001" }`; the value may also use the `ATTENDANCE:STU-1001` format.

Run the tests with:

```powershell
python -m unittest discover -s tests -v
```

For real attendance data, use authenticated HTTPS hosting with persistent storage and school-approved biometric consent and retention policies. The free Render Blueprint is suitable only for a fictional-data demo because its local database is temporary and can be lost. The built-in shared teacher password and in-memory login throttling are suitable only for a small private pilot; do not publish student data or expose the dashboard without teacher authentication.
