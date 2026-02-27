## Bitespeed Identity Reconciliation

Service that reconciles customer identities across multiple orders for FluxKart-style checkouts.  
Each checkout sends an `email` and/or `phoneNumber`, and this backend links all such contacts into a single logical customer.

Built with **Next.js (App Router)**, **Prisma**, and **PostgreSQL**.

---

## Project overview

- **Goal**: Given any combination of `email` and `phoneNumber`, return a consolidated view of the customer and maintain a consistent primary/secondary contact chain.
- **Core entity**: `Contact` table in PostgreSQL:

```sql
model Contact {
  id             Int      @id @default(autoincrement())
  phoneNumber    String?
  email          String?
  linkedId       Int?
  linkPrecedence LinkPrecedence  // 'primary' | 'secondary'
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  deletedAt      DateTime?
}
```

- **Linking rules**:
  - **primary**: first contact in a chain (oldest by `createdAt`).
  - **secondary**: all other contacts that belong to the same logical customer.
  - Contacts are linked if they share **email** or **phoneNumber** (directly or through a chain).
  - When two primaries later get connected, the **older** primary stays primary; the other is downgraded to secondary.

---

## Tech stack

- **Backend framework**: Next.js 16 (App Router, Node runtime)
- **Language**: JavaScript (ES modules)
- **Database**: PostgreSQL
- **ORM**: Prisma
- **Runtime**: Node.js 18+

Key files:

- **`src/app/api/identify/route.js`** – `/api/identify` implementation.
- **`prisma/schema.prisma`** – database schema.
- **`src/lib/prisma.js`** – Prisma client singleton.

---

## Setup & running locally

### 1. Environment

Create `.env` with:

```env
DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/DATABASE?schema=public"
```

### 2. Install & migrate

```bash
npm install
npx prisma migrate dev
```

### 3. Start dev server

```bash
npm run dev
```

App runs at `http://localhost:3000`.

---

## API endpoint

- **Path**: `/api/identify`
- **Method**: `POST`
- **Content-Type**: `application/json`

### Request body

```json
{
  "email": "string or null (optional)",
  "phoneNumber": "string or number or null (optional)"
}
```

- **At least one** of `email` or `phoneNumber` must be present and non-empty.

### Response body

On success (`200 OK`):

```json
{
  "contact": {
    "primaryContatctId": 1,
    "emails": ["primary@example.com", "other@example.com"],
    "phoneNumbers": ["123456", "717171"],
    "secondaryContactIds": [2, 5]
  }
}
```

- **`primaryContatctId`**: ID of the primary `Contact` in this chain (oldest).
- **`emails`**: all distinct emails in the chain; **primary contact’s email first** if present.
- **`phoneNumbers`**: all distinct phone numbers in the chain; **primary contact’s phone first** if present.
- **`secondaryContactIds`**: all contact IDs in the chain whose `linkPrecedence` is `"secondary"`.

On validation error (`400 Bad Request`):

```json
{ "error": "Either email or phoneNumber is required" }
```

On server error (`500 Internal Server Error`):

```json
{ "error": "Internal Server Error" }
```

---

## Identity reconciliation behaviour (with examples)

Below are concrete flows you can reproduce using Postman or curl.

### Example 1 – New customer

**Request:**

```json
{
  "email": "lorraine@hillvalley.edu",
  "phoneNumber": "123456"
}
```

**Response (first time, creates primary):**

```json
{
  "contact": {
    "primaryContatctId": 1,
    "emails": ["lorraine@hillvalley.edu"],
    "phoneNumbers": ["123456"],
    "secondaryContactIds": []
  }
}
```

---

### Example 2 – Same phone, new email (creates secondary)

**Request:**

```json
{
  "email": "mcfly@hillvalley.edu",
  "phoneNumber": "123456"
}
```

**Response:**

```json
{
  "contact": {
    "primaryContatctId": 1,
    "emails": ["lorraine@hillvalley.edu", "mcfly@hillvalley.edu"],
    "phoneNumbers": ["123456"],
    "secondaryContactIds": [2]
  }
}
```

All of these requests will now return the same consolidated contact:

- `{"email": null, "phoneNumber": "123456"}`
- `{"email": "lorraine@hillvalley.edu", "phoneNumber": null}`
- `{"email": "mcfly@hillvalley.edu", "phoneNumber": null}`

---

### Example 3 – Two primaries merging into one chain

1. **First primary**:

```json
{
  "email": "george@hillvalley.edu",
  "phoneNumber": "919191"
}
```

Response (IDs may differ):

```json
{
  "contact": {
    "primaryContatctId": 3,
    "emails": ["george@hillvalley.edu"],
    "phoneNumbers": ["919191"],
    "secondaryContactIds": []
  }
}
```

2. **Second primary**:

```json
{
  "email": "biffsucks@hillvalley.edu",
  "phoneNumber": "717171"
}
```

Response:

```json
{
  "contact": {
    "primaryContatctId": 4,
    "emails": ["biffsucks@hillvalley.edu"],
    "phoneNumbers": ["717171"],
    "secondaryContactIds": []
  }
}
```

3. **Linking request (connects the two primaries)**:

```json
{
  "email": "george@hillvalley.edu",
  "phoneNumber": "717171"
}
```

Response (3 is older than 4, so 3 stays primary and 4 becomes secondary):

```json
{
  "contact": {
    "primaryContatctId": 3,
    "emails": ["george@hillvalley.edu", "biffsucks@hillvalley.edu"],
    "phoneNumbers": ["919191", "717171"],
    "secondaryContactIds": [4]
  }
}
```

No extra contact is created here—only the second primary is converted into a secondary.

---

### Example 4 – Phone as a number

The API also accepts numeric `phoneNumber` in the request; it is normalized to string internally.

**Request:**

```json
{
  "email": "doc@hillvalley.edu",
  "phoneNumber": 9998887777
}
```

**Response (new primary):**

```json
{
  "contact": {
    "primaryContatctId": 5,
    "emails": ["doc@hillvalley.edu"],
    "phoneNumbers": ["9998887777"],
    "secondaryContactIds": []
  }
}
```

Subsequent requests using `"9998887777"` (as string) or `9998887777` (as number) will be reconciled to the same chain.

---

## How the algorithm works (high level)

- **1. Normalize input**: Trim strings; convert numeric phone numbers to strings. Reject if both identifiers are missing.
- **2. Find all matches**:
  - Fetch contacts by `email`.
  - Fetch contacts by `phoneNumber`.
  - Merge results to a unique list of matching contacts.
- **3. Build the full component**:
  - From all matches, collect IDs and their `linkedId`s.
  - Fetch every contact whose `id` or `linkedId` is in this set.
- **4. Decide the primary**:
  - Among these, the oldest `primary` (`createdAt` ascending) is kept as the **primary**.
  - Any other primaries are downgraded to `secondary` and `linkedId` set to the chosen primary’s ID.
- **5. Decide whether to create a new secondary**:
  - If both the input email (if present) and phone (if present) already exist somewhere in this component, **no new row** is created.
  - Otherwise a new `secondary` contact is created and linked to the primary.
- **6. Build response**:
  - Gather all contacts in this chain (primary + secondaries).
  - Deduplicate `emails` and `phoneNumbers`, with the primary’s values first.
  - Return the response shape specified by Bitespeed.

---

## Deployment / hosting

- **Environment variables**:
  - `DATABASE_URL` – PostgreSQL connection string.
- **Build & run**:
  - `npm run build`
  - `npm start`
- **Suggested platforms**:
  - Render, Railway, Vercel, or any Node host with PostgreSQL.

This project is deployed on **Vercel** at:

- **Hosted base URL**: `https://bite-speed-ten.vercel.app`
- **Identify endpoint**: `POST https://bite-speed-ten.vercel.app/api/identify`

You can call the live endpoint directly from tools like Postman or curl using the examples above.


