# Forte Community Clinic — Information System

Production-oriented clinic management frontend + backend starter.

- **Frontend**: static HTML / CSS / JS (role-based screens)
- **Backend**: Node.js + Express + Microsoft SQL Server (`mssql`)
- **Database connection string**: lives **only** on the server (never in the browser)

---

## Architecture

```
┌─────────────────────┐          HTTPS / JSON          ┌──────────────────────┐
│  GitHub Pages       │  ───────────────────────────►  │  Backend API         │
│  (this frontend)    │                                │  (Node / Express)    │
└─────────────────────┘                                │         │            │
                                                       │         ▼            │
                                                       │  Microsoft SQL       │
                                                       │  Server / Azure SQL  │
                                                       └──────────────────────┘
```

GitHub Pages can host **only** the static site.  
A real database requires a separate backend host.

---

## 1. Where to put the database connection string

**Never put the connection string in any file that is served to the browser** (`js/`, `*.html`, etc.).

### Backend (Node / Express) — recommended location

1. Copy the example file:
   ```bash
   cd backend
   cp .env.example .env
   ```
2. Edit `.env` and set:
   ```env
   DB_CONNECTION_STRING="Server=YOUR_SERVER;Database=ForteCommunityClinicDB;User Id=YOUR_USER;Password=YOUR_PASSWORD;Encrypt=true;TrustServerCertificate=true;"
   ```
3. Add `.env` to `.gitignore` (already expected — do not commit real secrets).

### Alternative: ASP.NET

In `appsettings.json` (or better, environment variables / Azure App Settings):

```json
{
  "ConnectionStrings": {
    "ForteClinic": "Server=YOUR_SERVER;Database=ForteCommunityClinicDB;User Id=YOUR_USER;Password=YOUR_PASSWORD;Encrypt=true;"
  }
}
```

---

## 2. Database setup

1. Create an empty database named `ForteCommunityClinicDB` (or any name you prefer — keep it consistent with the connection string).
2. Run the script:
   ```
   backend/sql/schema.sql
   ```
   against that database (SSMS, Azure Data Studio, or `sqlcmd`).
3. Create at least one Admin employee (hash the password with bcrypt, or temporarily insert a known hash) so you can sign in.

---

## 3. Running the backend locally

```bash
cd backend
npm install
cp .env.example .env
# edit .env → put your real connection string
npm start
```

Health check: `http://localhost:3000/api/health`

The frontend is configured (in `js/app.js`) to call:

```js
const API_BASE = 'http://localhost:3000/api';
```

After you deploy the API, change that value (or set `window.FORTE_API_BASE` before loading `app.js`).

---

## 4. Publishing the frontend with GitHub Pages

1. Create a new GitHub repository (public for free Pages, or private with GitHub Pro).
2. Push this project (or at least the frontend files: `*.html`, `css/`, `js/`, `favicon.svg`).
3. In the repository:
   - **Settings → Pages**
   - Source: **Deploy from a branch**
   - Branch: `main` (or `master`), folder: `/` (root) or `/docs` if you prefer
4. After a minute your site will be at:
   ```
   https://YOUR_USERNAME.github.io/REPO_NAME/
   ```
5. Update the frontend API base URL to point at your live backend, for example:
   ```js
   // in js/app.js or via a small config script
   const API_BASE = 'https://your-api.azurewebsites.net/api';
   ```
   or set before loading the script:
   ```html
   <script>window.FORTE_API_BASE = 'https://your-api.example.com/api';</script>
   <script src="js/app.js"></script>
   ```
6. On the backend, add that GitHub Pages origin to `CORS_ORIGIN` in `.env`.

---

## 5. Where to host the backend + database

| Option | Database | Notes |
|--------|----------|--------|
| **Azure App Service + Azure SQL** | Native SQL Server | Best match for the `mssql` driver and connection-string format already used. Free/student tiers often available. |
| **Railway / Render / Fly.io** | Can use Azure SQL or switch to Postgres | Easy Git-based deploys. You would adapt the connection string / driver if you move away from SQL Server. |
| **Your own VPS** (DigitalOcean, etc.) | Install SQL Server or use a managed instance | Full control, more maintenance. |

Recommended starting point for SQL Server:

1. Create an **Azure SQL Database**.
2. Create an **Azure App Service** (Node) and deploy the `backend/` folder.
3. Set `DB_CONNECTION_STRING` and `JWT_SECRET` as **Application Settings** (environment variables) — never in source control.
4. Point the GitHub Pages frontend at the App Service URL.

---

## 6. Frontend configuration checklist

- [ ] `API_BASE` in `js/app.js` (or `window.FORTE_API_BASE`) points to your live API.
- [ ] Backend `CORS_ORIGIN` includes your GitHub Pages URL.
- [ ] No connection strings or passwords appear in any frontend file.
- [ ] Demo accounts, reset-demo links and localStorage seed data have been removed.

---

## 7. What was cleaned for production

- Removed all localStorage seed / dummy data.
- Removed “Demo accounts” table and passwords from the home page.
- Removed “Reset demo data” footer link and related logic.
- Removed developer / UCN-demo wording from user-facing screens.
- Data layer now calls a real HTTP API (`DB.*` methods → `fetch`).
- Clear comments in `js/app.js` and `backend/` explaining exactly where the connection string belongs.

---

## 8. Extending the API

The starter `backend/server.js` implements:

- `POST /api/auth/login`
- `POST /api/patients/register`
- `GET  /api/patients`, `/api/employees`, `/api/appointments`, `/api/payments`, `/api/inventory`, `/api/metrics`
- `POST /api/appointments`, `PATCH /api/appointments/:id/cancel`
- `GET  /api/diagnoses`, `/api/consultations`
- `POST /api/consultations`
- `POST /api/employees`, `GET /api/audit`
- `GET  /api/health`

Other staff screens call additional endpoints (dispense, payment, etc.).  
Add matching routes in `server.js` using the same `getPool()` + `mssql` pattern; the schema is already in `backend/sql/schema.sql`.

---

## Licence / usage

Built for Forte Community Clinic. Adapt freely for your own deployment.
