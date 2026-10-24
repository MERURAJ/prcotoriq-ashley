# ProctorIQ: Ashley Furniture India assessment

## Run locally

Use Node.js 20 or newer. Start both the API and frontend together:

```powershell
npm run dev
```

Open the Vite URL printed by `npm run dev`. The API listens on port 3001 and Vite proxies `/api` requests to it. `npm run dev:api` is also available to run just the API if needed. Use `localhost` or HTTPS for browser camera access.

On first API startup, the server creates the administrator account and prints its username and a randomly generated password in the API terminal. Save that password: only its hash is stored. To choose credentials before first startup, set `ADMIN_USERNAME` and `ADMIN_PASSWORD` in the environment; the password must contain at least 12 characters. Credentials set in the environment only initialize a new data store.

```powershell
$env:ADMIN_USERNAME = "admin"
$env:ADMIN_PASSWORD = "choose-a-long-unique-password"
npm run dev:api
```

For a production build, run `npm run build`, then set `NODE_ENV=production` and start with `npm start`. The API server serves the built frontend and API on the same origin. Put it behind HTTPS in production so secure session cookies are enabled.

## Administrator access and data

Open **Admin login** from the home page. The server protects question editing and result/warning APIs with an administrator session; candidate-facing routes never return scores, event counts, or answer keys. Passwords are salted and hashed using Node's scrypt, sessions use HttpOnly/SameSite cookies, and repeated failed logins are rate-limited.

Questions, answer keys, attempts, and completed results are persisted in `proctoriq-data/proctoriq.json` beside the project directory, outside the frontend workspace. Set `DATA_DIR` to choose another directory outside the project root. The server rejects an in-project data directory so Vite cannot serve the private data file. Back up the file securely; it contains candidate names, assessment results, and monitoring events. Do not commit or publicly expose it.

Administrators can edit, add, or remove questions. Changes apply to new attempts; each started attempt retains a private server-side snapshot, and scores are calculated by the server when submitted. The candidate's completion page only confirms receipt. Their webcam and tab-switch warnings remain visible during the assessment, while recorded event details are visible only in the authenticated admin dashboard.

## Full-screen and coding questions

Starting an assessment requests browser full-screen mode from the candidate's button click. Browsers may refuse the request; candidates can continue in a regular window. Exiting full-screen mode while an attempt is active produces a timestamped event in the existing results and warnings view. Full-screen mode is a browser display feature, not a cheating-prevention mechanism. In each new attempt, multiple-choice questions are grouped first and coding questions follow in a separate section. Admin results report the multiple-choice score and coding test cases passed separately, alongside the existing overall score.

To add a coding question, open **Admin dashboard → Questions → Add question**, choose **Coding**, and enter the problem statement, constraints, public examples, and private test cases as JSON arrays. The candidate editor starts with a neutral language template, not a solution stored in the question bank. Examples use `{ "input": "...", "output": "..." }`; private cases use `{ "input": "...", "expectedOutput": "..." }`. The `input` may be a string or a JSON object/array, which is serialized and provided to the program on stdin. For example, `{ "input": { "nums": [3, 3], "target": 6 }, "expectedOutput": "[0,1]" }` sends `{"nums":[3,3],"target":6}` to stdin. At least one private test case is required. Only the public statement, examples, and constraints are sent to the candidate; grading inputs and expected outputs stay in the server-side data store. Coding questions are scored as a fraction of their hidden test cases passed.

Code execution uses Wandbox's remote compiler API; no API key or RapidAPI subscription is required. The application sends candidate source code and test input to Wandbox for execution in its isolated environment. Review the service's availability and data-handling terms before use with real candidate submissions. Code is never executed directly in the ProctorIQ application server.

The editor autosaves code to the browser and API server. **Run Code** compiles the current version and runs it against the question's public sample cases, showing a pass/fail result for each case. **Run Custom Input** executes once with the custom stdin field. **Submit Code** runs the private grading cases and records the score on the server. Wandbox requests are serialized to reduce container allocation failures; one transient HTTP 429 or container allocation error is retried. If Wandbox remains unavailable, the app reports a service error instead of marking test cases failed. A test case is marked passed only when the program executes successfully and its output matches the expected output. Python uses CPython 3.10, C++ uses GCC 13.2, and Java uses OpenJDK 22; Java submissions should declare `public class prog` to match the Wandbox entry-point filename. JSON outputs are compared independent of whitespace and object-key order.

## How monitoring works

`getUserMedia` feeds a `<video>` element. Every 300 ms the current frame goes to MediaPipe's BlazeFace Face Detector, which runs locally in the browser (WASM). No face for 5 seconds, or several faces for 3 seconds, logs an event and displays a candidate warning, with a 30-second cooldown per type. Frames are never stored or uploaded, and no one is identified.

`visibilitychange`, `blur`, and `focus` share one "away" flag, so one departure logs one tab-switch event. Full-screen exits are recorded separately. All events are submitted with the attempt and stored with the result. If the timer expires, the server marks the submission as automatic.

## Limitations

- The MediaPipe WASM files (jsDelivr) and model (storage.googleapis.com) load from CDNs at runtime, so internet is needed for face detection. If they fail, the app displays a warning and continues.
- Browser monitoring cannot detect second devices, screen sharing, notes off-camera, or similar behavior.
- The JSON file store is suitable for a single-server deployment, not multi-instance scaling. Use an appropriate shared database, backups, HTTPS, and operational monitoring before production use.
