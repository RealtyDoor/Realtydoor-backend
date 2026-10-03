# RealtyDoor Backend API

> Lead-generation and property-services platform for the Indian real estate market.

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 18+ |
| Framework | Express.js |
| Database | MongoDB (via Prisma ORM) |
| Auth | Clerk (JWT) |
| Payments | Razorpay (Gateway + Route/Escrow) |
| WhatsApp | WATI Business API |
| File Storage | Cloudinary |
| Email | Resend |
| Scheduler | node-cron |

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Set up environment
cp .env.example .env
# Fill in all values in .env

# 3. Push Prisma schema to MongoDB
npx prisma db push

npm run db:seed

# 4. Start dev server
npm run dev
```

`npm install` regenerates the Prisma client automatically (`postinstall`). After pulling changes that touch anything in `prisma/schema/`, run `npm run db:generate` yourself — a stale client from before your last `npm install` silently returns wrong results for new fields/relations/enum values instead of erroring, which is easy to misdiagnose as a backend bug.

## Project Structure

```
src/
├── app.js                  Express app (middleware + routes)
├── config/env.js           Zod env validation at startup
├── lib/                    External service wrappers
├── middleware/             Auth, role guards, rate limiters
├── modules/                Feature modules (routes/controller/service)
├── jobs/                   Background cron jobs
├── routes/index.js         API router mount
└── utils/                  ApiError, ApiResponse, pagination
prisma/schema.prisma        MongoDB data model
```

## API Documentation

See [API.md](./API.md) for the complete endpoint reference.

## Background Jobs

| Job | Schedule | Purpose |
|---|---|---|
| `whatsappFeedback` | Every hour | Sends WhatsApp feedback bot to buyer 24h after OTP verified |
| `expiredOtp` | Every 30 min | Clears expired OTPs and unlocks stale OTP locks |

## Environment Variables

See [.env.example](./.env.example) for all required variables.
