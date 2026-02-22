# FlowFit Backend - Deployment Guide

Complete guide for deploying the FlowFit backend to production environments.

## 📋 Pre-Deployment Checklist

### Security
- [ ] Generate strong JWT secrets (min 32 characters)
- [ ] Set `NODE_ENV=production`
- [ ] Enable HTTPS/TLS
- [ ] Configure CORS with production frontend URL
- [ ] Set up rate limiting
- [ ] Enable Helmet security headers
- [ ] Review and set bcrypt rounds (12 recommended)

### Database
- [ ] Set up PostgreSQL database
- [ ] Configure connection pooling
- [ ] Run migrations
- [ ] Set up automated backups
- [ ] Configure read replicas (if needed)

### Caching
- [ ] Set up Redis instance
- [ ] Configure Redis persistence
- [ ] Set up Redis Sentinel/Cluster (for HA)

### Monitoring
- [ ] Set up error tracking (Sentry)
- [ ] Configure application monitoring (New Relic, Datadog)
- [ ] Set up uptime monitoring
- [ ] Configure log aggregation

### Environment Variables
- [ ] All required variables set
- [ ] Secrets stored securely
- [ ] No sensitive data in code

## 🚀 Deployment Options

### Option 1: Railway (Recommended for Quick Start)

**Pros:** Easy setup, automatic deployments, managed PostgreSQL and Redis
**Pricing:** Free tier available, scales with usage

#### Steps:

1. **Create Railway Account**
   - Go to [railway.app](https://railway.app)
   - Sign up with GitHub

2. **Create New Project**
   - Click "New Project"
   - Select "Deploy from GitHub repo"
   - Choose your FlowFit backend repository

3. **Add PostgreSQL**
   - Click "New" → "Database" → "Add PostgreSQL"
   - Railway automatically sets `DATABASE_URL`

4. **Add Redis**
   - Click "New" → "Database" → "Add Redis"
   - Railway automatically sets `REDIS_URL`

5. **Configure Environment Variables**
   ```
   NODE_ENV=production
   JWT_SECRET=<your-secret>
   JWT_REFRESH_SECRET=<your-secret>
   FRONTEND_URL=https://your-frontend.com
   CORS_ORIGIN=https://your-frontend.com
   ```

6. **Deploy**
   - Push to main branch
   - Railway automatically builds and deploys

7. **Run Migrations**
   - In Railway dashboard, open service
   - Go to "Settings" → "Custom Start Command"
   - Add: `npm run prisma:migrate && npm start`

**Railway Configuration:**
```json
{
  "build": {
    "builder": "NIXPACKS"
  },
  "deploy": {
    "startCommand": "npm run prisma:migrate && npm start",
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 10
  }
}
```

### Option 2: Render

**Pros:** Simple deployment, managed databases, automatic SSL
**Pricing:** Free tier available

#### Steps:

1. **Create Render Account**
   - Go to [render.com](https://render.com)
   - Sign up with GitHub

2. **Create Web Service**
   - Dashboard → "New" → "Web Service"
   - Connect GitHub repository
   - Configure:
     - **Name:** flowfit-backend
     - **Region:** Choose closest to users
     - **Branch:** main
     - **Root Directory:** (leave empty)
     - **Environment:** Node
     - **Build Command:** `npm install && npm run build`
     - **Start Command:** `npm start`

3. **Add PostgreSQL Database**
   - Dashboard → "New" → "PostgreSQL"
   - Choose plan
   - Copy Internal Database URL

4. **Add Redis**
   - Dashboard → "New" → "Redis"
   - Choose plan
   - Copy Internal Redis URL

5. **Set Environment Variables**
   - In web service settings → "Environment"
   - Add all required variables

6. **Deploy**
   - Render automatically deploys on push to main

**Render Configuration (render.yaml):**
```yaml
services:
  - type: web
    name: flowfit-backend
    env: node
    plan: starter
    buildCommand: npm install && npm run build
    startCommand: npm start
    envVars:
      - key: NODE_ENV
        value: production
      - key: DATABASE_URL
        fromDatabase:
          name: flowfit-db
          property: connectionString
      - key: REDIS_URL
        fromDatabase:
          name: flowfit-redis
          property: connectionString

databases:
  - name: flowfit-db
    plan: starter
  - name: flowfit-redis
    plan: starter
```

### Option 3: DigitalOcean App Platform

**Pros:** Reliable infrastructure, good documentation, scalable
**Pricing:** Starts at $5/month

#### Steps:

1. **Create DigitalOcean Account**
   - Go to [digitalocean.com](https://digitalocean.com)

2. **Create App**
   - Apps → "Create App"
   - Connect GitHub repository

3. **Configure App**
   - Select Node.js
   - Build Command: `npm install && npm run build`
   - Run Command: `npm start`

4. **Add Managed Databases**
   - Create PostgreSQL database
   - Create Redis database
   - Add to app as environment variables

5. **Set Environment Variables**
   - Configure in App Platform settings

6. **Deploy**
   - Automatic deployment on git push

### Option 4: VPS (DigitalOcean Droplet, Linode, AWS EC2)

**Pros:** Full control, cost-effective at scale
**Cons:** More setup and maintenance

#### Steps:

1. **Create VPS**
   - Ubuntu 22.04 LTS recommended
   - Minimum: 2GB RAM, 1 CPU

2. **Initial Server Setup**

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 18
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Install PostgreSQL
sudo apt install -y postgresql postgresql-contrib

# Install Redis
sudo apt install -y redis-server

# Install PM2 (Process Manager)
sudo npm install -g pm2

# Install Nginx (Reverse Proxy)
sudo apt install -y nginx

# Install Certbot (SSL)
sudo apt install -y certbot python3-certbot-nginx
```

3. **Set Up PostgreSQL**

```bash
sudo -u postgres psql

# Create database and user
CREATE DATABASE flowfit_db;
CREATE USER flowfit_user WITH ENCRYPTED PASSWORD 'your_secure_password';
GRANT ALL PRIVILEGES ON DATABASE flowfit_db TO flowfit_user;
\q
```

4. **Configure Redis**

```bash
sudo nano /etc/redis/redis.conf

# Set password
requirepass your_redis_password

sudo systemctl restart redis
```

5. **Deploy Application**

```bash
# Clone repository
git clone https://github.com/your-org/flowfit-backend.git
cd flowfit-backend

# Install dependencies
npm install

# Create .env file
nano .env
# Add all environment variables

# Build application
npm run build

# Run migrations
npm run prisma:migrate

# Start with PM2
pm2 start dist/server.js --name flowfit-backend

# Save PM2 configuration
pm2 save
pm2 startup
```

6. **Configure Nginx**

```bash
sudo nano /etc/nginx/sites-available/flowfit

# Add configuration:
server {
    listen 80;
    server_name api.flowfit.com;

    location / {
        proxy_pass http://localhost:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

# Enable site
sudo ln -s /etc/nginx/sites-available/flowfit /etc/nginx/sites-enabled/

# Test configuration
sudo nginx -t

# Restart Nginx
sudo systemctl restart nginx
```

7. **Set Up SSL**

```bash
sudo certbot --nginx -d api.flowfit.com
```

8. **Set Up Auto-Deployment**

```bash
# Create deployment script
nano deploy.sh

#!/bin/bash
cd /home/ubuntu/flowfit-backend
git pull origin main
npm install
npm run build
npm run prisma:migrate
pm2 restart flowfit-backend

chmod +x deploy.sh
```

## 🔐 Environment Variables Checklist

```bash
# Required
NODE_ENV=production
PORT=5000
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
JWT_SECRET=<min-32-chars>
JWT_REFRESH_SECRET=<min-32-chars>
FRONTEND_URL=https://flowfit.com
CORS_ORIGIN=https://flowfit.com

# Optional but Recommended
MPESA_CONSUMER_KEY=...
MPESA_CONSUMER_SECRET=...
STRIPE_SECRET_KEY=...
EMAIL_HOST=...
EMAIL_USER=...
EMAIL_PASSWORD=...
```

## 📊 Post-Deployment

### Verify Deployment

```bash
# Health check
curl https://api.flowfit.com/health

# Test API
curl https://api.flowfit.com/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"Test1234","name":"Test User"}'
```

### Set Up Monitoring

1. **Uptime Monitoring**
   - UptimeRobot, Pingdom, or StatusCake
   - Monitor `/health` endpoint

2. **Error Tracking**
   - [Sentry](https://sentry.io)
   - [Rollbar](https://rollbar.com)

3. **Application Monitoring**
   - [New Relic](https://newrelic.com)
   - [Datadog](https://datadoghq.com)

4. **Log Management**
   - [Logtail](https://logtail.com)
   - [Papertrail](https://papertrailapp.com)

### Database Backups

**Automatic Backups (Railway/Render):**
- Automatically handled by platform

**Manual Backups (VPS):**

```bash
# Backup script
#!/bin/bash
DATE=$(date +%Y%m%d_%H%M%S)
pg_dump -U flowfit_user flowfit_db > backup_$DATE.sql
aws s3 cp backup_$DATE.sql s3://flowfit-backups/

# Add to crontab
crontab -e
0 2 * * * /home/ubuntu/backup.sh
```

## 🔄 CI/CD Pipeline

### GitHub Actions

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy to Production

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Run tests
        run: npm test
      
      - name: Build
        run: npm run build
      
      - name: Deploy to Railway
        run: railway up
        env:
          RAILWAY_TOKEN: ${{ secrets.RAILWAY_TOKEN }}
```

## 🐛 Troubleshooting

### Common Issues

**Database Connection Failed**
- Check DATABASE_URL format
- Verify database is accessible
- Check firewall rules

**Redis Connection Failed**
- Verify REDIS_URL
- Check Redis is running
- Test connection with redis-cli

**Application Won't Start**
- Check logs: `pm2 logs flowfit-backend`
- Verify all environment variables are set
- Check port availability

**502 Bad Gateway (Nginx)**
- Application not running
- Wrong proxy_pass port
- Check Nginx error logs: `sudo tail -f /var/log/nginx/error.log`

## 📈 Scaling Considerations

### Horizontal Scaling
- Add more application instances
- Use load balancer (Nginx, HAProxy)
- Ensure stateless architecture

### Database Scaling
- Set up read replicas
- Implement connection pooling
- Consider database sharding

### Caching
- Implement Redis Cluster
- Use CDN for static assets
- Add application-level caching

## 🎯 Production Checklist

- [ ] SSL/HTTPS enabled
- [ ] Environment variables secured
- [ ] Database backups configured
- [ ] Monitoring set up
- [ ] Error tracking configured
- [ ] Load testing completed
- [ ] Security audit performed
- [ ] Documentation updated
- [ ] Team trained on deployment process

---

**Need Help?** Contact: devops@flowfit.com
