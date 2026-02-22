# FlowFit Backend - Production-Ready Node.js API

Enterprise-grade backend for FlowFit fitness tracking SaaS platform with TypeScript, PostgreSQL, Redis, Prisma ORM, JWT authentication, and scalable architecture.

## 🎯 Overview

A complete, production-ready REST API backend featuring:

- **Authentication & Authorization**: JWT tokens with refresh mechanism
- **Role-Based Access Control**: USER, COACH, ADMIN roles
- **Database**: PostgreSQL with Prisma ORM
- **Caching**: Redis for high-performance data access
- **Security**: Helmet, rate limiting, CORS, bcrypt password hashing
- **Logging**: Winston for structured logging
- **Error Handling**: Centralized error handling with Prisma error parsing
- **Validation**: Joi for request validation
- **Subscription Billing**: M-Pesa (Kenya) & Stripe ready

## 📁 Project Structure

```
flowfit-backend/
├── src/
│   ├── config/
│   │   ├── db.ts              # Prisma database client
│   │   ├── redis.ts           # Redis cache configuration
│   │   └── env.ts             # Environment variables
│   │
│   ├── modules/
│   │   ├── auth/              # Authentication module
│   │   │   ├── auth.service.ts
│   │   │   ├── auth.controller.ts
│   │   │   └── auth.routes.ts
│   │   ├── users/             # User management (to be created)
│   │   ├── workouts/          # Workout library (to be created)
│   │   ├── programs/          # Training programs (to be created)
│   │   ├── progress/          # Progress tracking (to be created)
│   │   ├── subscriptions/     # Billing & subscriptions (to be created)
│   │   └── analytics/         # Analytics & reporting (to be created)
│   │
│   ├── middleware/
│   │   ├── auth.middleware.ts       # JWT authentication
│   │   ├── role.middleware.ts       # Role-based access
│   │   ├── rateLimiter.ts           # Rate limiting
│   │   └── error.middleware.ts      # Error handling
│   │
│   ├── utils/
│   │   ├── logger.ts          # Winston logger
│   │   ├── jwt.ts             # JWT utilities
│   │   └── response.ts        # Standardized responses
│   │
│   ├── routes.ts              # Route aggregator
│   └── server.ts              # Express app entry point
│
├── prisma/
│   └── schema.prisma          # Database schema
│
├── .env.example               # Environment variables template
├── package.json
├── tsconfig.json
└── README.md
```

## 🚀 Quick Start

### Prerequisites

- **Node.js**: >= 18.0.0
- **npm**: >= 9.0.0
- **PostgreSQL**: >= 14.0
- **Redis**: >= 6.0

### Installation

1. **Clone and navigate to backend directory**

```bash
cd flowfit-backend
```

2. **Install dependencies**

```bash
npm install
```

3. **Set up environment variables**

```bash
cp .env.example .env
```

Edit `.env` with your configuration:

```env
DATABASE_URL=postgresql://username:password@localhost:5432/flowfit_db
REDIS_URL=redis://localhost:6379
JWT_SECRET=your-secret-key-min-32-chars
JWT_REFRESH_SECRET=your-refresh-secret-key
```

4. **Set up database**

```bash
# Generate Prisma client
npm run prisma:generate

# Run migrations
npm run prisma:migrate

# Optional: Seed database
npm run prisma:seed
```

5. **Start development server**

```bash
npm run dev
```

Server runs on `http://localhost:5000`

## 📊 Database Schema

### Core Models

**User**
- Authentication and profile management
- Role-based access control
- Email verification support

**Subscription**
- FREE, PRO, PREMIUM plans
- M-Pesa & Stripe integration ready
- Trial management

**Exercise**
- Complete exercise library
- Difficulty levels, categories
- Video and image URLs

**Program**
- Structured workout programs
- Week and day breakdown
- Premium program support

**WorkoutLog**
- Exercise tracking
- Sets, reps, duration, calories
- Progress history

**Achievement**
- Gamification system
- Streaks and milestones
- Badge unlocking

### Key Relationships

- User → Profile (1:1)
- User → Subscription (1:1)
- User → WorkoutLogs (1:many)
- User → ProgramEnrollments (1:many)
- Program → ProgramWeeks → ProgramDays → WorkoutExercises

## 🔐 Authentication Flow

### Register

```bash
POST /api/v1/auth/register
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "SecurePassword123",
  "name": "John Doe"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Registration successful",
  "data": {
    "user": {
      "id": "uuid",
      "email": "user@example.com",
      "name": "John Doe",
      "role": "USER"
    },
    "accessToken": "eyJhbGciOiJIUzI1...",
    "refreshToken": "eyJhbGciOiJIUzI1..."
  }
}
```

### Login

```bash
POST /api/v1/auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "SecurePassword123"
}
```

### Refresh Token

```bash
POST /api/v1/auth/refresh
Content-Type: application/json

{
  "refreshToken": "eyJhbGciOiJIUzI1..."
}
```

### Protected Routes

Include JWT token in Authorization header:

```bash
GET /api/v1/auth/me
Authorization: Bearer eyJhbGciOiJIUzI1...
```

## 🛡️ Security Features

### Password Security
- **Bcrypt hashing** with configurable rounds (default: 12)
- Minimum 8 characters required

### JWT Tokens
- **Access Token**: Short-lived (15 minutes)
- **Refresh Token**: Long-lived (7 days), stored in database
- Token rotation on refresh
- Multi-device logout support

### Rate Limiting
- **Standard**: 100 requests per 15 minutes
- **Auth endpoints**: 5 attempts per 15 minutes
- **API**: 1000 requests per hour
- Redis-based distributed rate limiting

### Security Headers (Helmet)
- XSS protection
- Content Security Policy
- HSTS enforcement
- No-Sniff headers

### CORS
- Whitelist-based origin control
- Credentials support
- Configurable allowed methods

## 💾 Caching Strategy

### Redis Cache Keys

```typescript
// User caches
user:${userId}                    // 1 hour
user:${userId}:profile            // 1 hour
user:${userId}:subscription       // 30 minutes

// Workout caches
exercise:${exerciseId}            // 24 hours
exercises:${filters}              // 1 hour
exercises:popular                 // 6 hours

// Analytics
analytics:${type}                 // 15 minutes
stats:daily:${date}               // 24 hours
```

### Cache Utilities

```typescript
import { RedisCache, CacheKeys } from './config/redis';

// Set cache
await RedisCache.set(CacheKeys.user(userId), userData, 3600);

// Get cache
const user = await RedisCache.get<User>(CacheKeys.user(userId));

// Delete cache
await RedisCache.del(CacheKeys.user(userId));

// Pattern deletion
await RedisCache.delPattern('user:*');
```

## 📈 API Endpoints

### Authentication
- `POST /api/v1/auth/register` - Register new user
- `POST /api/v1/auth/login` - User login
- `POST /api/v1/auth/refresh` - Refresh access token
- `POST /api/v1/auth/logout` - Logout (invalidate refresh token)
- `POST /api/v1/auth/logout-all` - Logout all devices
- `POST /api/v1/auth/change-password` - Change password
- `GET /api/v1/auth/me` - Get current user
- `GET /api/v1/auth/verify-email/:token` - Verify email

### Users (To be implemented)
- `GET /api/v1/users/me` - Get profile
- `PUT /api/v1/users/me` - Update profile
- `DELETE /api/v1/users/me` - Delete account

### Workouts (To be implemented)
- `GET /api/v1/workouts` - List exercises
- `GET /api/v1/workouts/:id` - Get exercise details
- `POST /api/v1/workouts` - Create exercise (admin)

### Programs (To be implemented)
- `GET /api/v1/programs` - List programs
- `GET /api/v1/programs/:id` - Get program details
- `POST /api/v1/programs/:id/enroll` - Enroll in program

### Progress (To be implemented)
- `POST /api/v1/progress` - Log workout
- `GET /api/v1/progress/me` - Get user progress
- `GET /api/v1/progress/stats` - Get statistics

### Subscriptions (To be implemented)
- `POST /api/v1/subscriptions/checkout` - Initiate payment
- `POST /api/v1/subscriptions/webhook` - Payment webhook
- `GET /api/v1/subscriptions/me` - Get subscription status

## 🧪 Testing

```bash
# Run tests
npm test

# Run tests with coverage
npm test -- --coverage

# Run tests in watch mode
npm test -- --watch
```

## 📦 Deployment

### Environment Setup

**Production environment variables:**
```env
NODE_ENV=production
PORT=5000
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
JWT_SECRET=strong-random-secret
JWT_REFRESH_SECRET=strong-random-secret
FRONTEND_URL=https://flowfit.com
CORS_ORIGIN=https://flowfit.com
```

### Build

```bash
npm run build
```

### Start Production Server

```bash
npm start
```

### Deployment Platforms

#### Railway

1. Connect GitHub repository
2. Add environment variables
3. Deploy automatically

#### Render

1. Create new Web Service
2. Connect repository
3. Build command: `npm install && npm run build`
4. Start command: `npm start`

#### Docker

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npm run build
CMD ["npm", "start"]
```

## 🔧 Scripts

```bash
npm run dev              # Start development server with nodemon
npm run build            # Compile TypeScript to JavaScript
npm start                # Start production server
npm run prisma:generate  # Generate Prisma client
npm run prisma:migrate   # Run database migrations
npm run prisma:studio    # Open Prisma Studio
npm run prisma:seed      # Seed database with initial data
npm test                 # Run tests
npm run lint             # Lint code
npm run format           # Format code with Prettier
```

## 🌍 Environment Variables

See `.env.example` for all available configuration options.

**Critical variables:**
- `DATABASE_URL` - PostgreSQL connection string
- `REDIS_URL` - Redis connection string
- `JWT_SECRET` - JWT signing secret (min 32 chars)
- `JWT_REFRESH_SECRET` - Refresh token secret
- `FRONTEND_URL` - Frontend application URL
- `CORS_ORIGIN` - Allowed CORS origins

## 🚀 Scaling Strategy

### Phase 1: Monolithic (Current)
- Single Node.js instance
- PostgreSQL database
- Redis cache
- Suitable for 0-10K users

### Phase 2: Horizontal Scaling
- Multiple Node.js instances behind load balancer
- Database read replicas
- Redis cluster
- Suitable for 10K-100K users

### Phase 3: Microservices
- Separate services: Auth, Workouts, Analytics, Billing
- Message queue (BullMQ/RabbitMQ)
- API Gateway
- Suitable for 100K+ users

## 📊 Monitoring & Logging

### Logging

Winston logger with multiple transports:
- Console (development)
- File: `logs/error.log` (errors only)
- File: `logs/combined.log` (all logs)

### Health Check

```bash
GET /health
```

Returns:
```json
{
  "status": "healthy",
  "timestamp": "2026-02-20T10:00:00.000Z",
  "uptime": 12345,
  "environment": "production",
  "database": "connected",
  "redis": "connected"
}
```

## 🤝 Contributing

1. Create feature branch
2. Make changes
3. Run tests and linting
4. Submit pull request

## 📝 License

MIT License - see LICENSE file for details

## 🙏 Support

For issues, questions, or contributions:
- GitHub Issues: [github.com/flowfit/backend/issues](https://github.com/flowfit/backend/issues)
- Email: dev@flowfit.com

---

**Built with ❤️ for fitness enthusiasts worldwide**
