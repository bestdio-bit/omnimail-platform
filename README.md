# OmniMail — Next-Generation Enterprise Email Infrastructure & Marketing Platform

OmniMail is an enterprise-grade, self-hosted email sending infrastructure, collaborative marketing platform, and visual workflow automation engine built from scratch in Node.js and SQLite.

## Key Architectural Principles & Highlights

1. **Cloud Delivery Gateway (Zero Vendor Brand Leakage)**
   - All email sending is abstracted through `src/providers/gateway.js`.
   - Supports SMTP relaying and generic HTTP REST payloads without exposing any third-party vendor brand names in code, logs, or UI.

2. **High-Throughput SQLite WAL Engine**
   - Implemented in `src/db/index.js` with `journal_mode = WAL`, `synchronous = NORMAL`, and `cache_size = -64000` (64MB).
   - Features 15+ composite indexes on foreign keys, statuses, and queued timestamps for sub-millisecond query performance.

3. **Asynchronous Background Worker & Queue**
   - Transactional API (`POST /api/send`, `POST /api/batch-send`) writes instantly to `emails` table with status `queued`.
   - Background loop (`src/worker.js`) polls batches with exponential backoff retry logic and automatic dead-letter queueing.

4. **Domain Authentication & Deliverability Safeguards**
   - Live DNS verification checking SPF, DKIM (2048-bit RSA keypair generation), DMARC (`p=quarantine`), and BIMI.
   - Automatic drift detection (`POST /api/domains/:id/check-drift`) comparing live records against stored snapshots.
   - Stateless HMAC-signed unsubscribe links (`/api/contacts/public-unsubscribe`) that require no Bearer authentication or session state.

5. **Collaborative Template Editor & Visual Automations**
   - Variable validation against system keywords (`FIRST_NAME`, `LAST_NAME`, `EMAIL`, `UNSUBSCRIBE_URL`).
   - Co-editing presence tracking (`/api/templates/:id/presence`) and draft/published versioning.
   - Directed acyclic graph (DAG) workflow engine with step-by-step test simulation without sending live emails.

6. **Enterprise Access Management & Universal Checkout**
   - Principle of Least Privilege RBAC middleware enforcing 6 distinct roles (`owner`, `admin`, `developer`, `marketer`, `billing`, `read_only`).
   - SAML SSO readiness bundled FREE into the Enterprise tier without separate add-on taxes!
   - Universal Server-to-Server Checkout gateway with HMAC webhook verification.

## Getting Started

### Prerequisites
- Node.js v18+ 
- npm v9+

### Installation & Run

```bash
# Install dependencies
npm install

# Start development server & background worker
npm start
```

Open your browser to **http://localhost:3000** to access the Premium Dark-Mode UI/UX Dashboard SPA.

### Running Automated Verification Tests

```bash
node test/verify_platform.js
```
This script verifies all API endpoints and executes an automated regex scan ensuring zero competitor brand name leakage across the entire codebase.
