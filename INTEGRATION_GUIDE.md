# FlowFit - Frontend to Backend Integration Guide

Complete guide for connecting the FlowFit frontend to the Node.js backend API.

## 🎯 Overview

This guide shows how to integrate the static HTML/CSS/JS frontend with the production-ready backend API.

## 📦 What You Have

### Frontend (HTML/CSS/JS)
- `index.html` - Landing page
- `dashboard.html` - User dashboard
- `workouts.html` - Exercise library
- `programs.html` - Training programs
- `progress.html` - Progress tracking

### Backend (Node.js/Express/TypeScript)
- REST API with JWT authentication
- PostgreSQL database
- Redis caching
- Role-based access control

## 🔗 Integration Steps

### Step 1: Set Up Backend

1. **Navigate to backend directory:**
```bash
cd flowfit-backend
```

2. **Install dependencies:**
```bash
npm install
```

3. **Configure environment:**
```bash
cp .env.example .env
# Edit .env with your credentials
```

4. **Set up database:**
```bash
# Generate Prisma client
npm run prisma:generate

# Run migrations
npm run prisma:migrate

# Seed initial data
npm run prisma:seed
```

5. **Start backend server:**
```bash
npm run dev
```

Backend runs on: `http://localhost:5000`

### Step 2: Add API Integration to Frontend

Create a new file `api.js` to handle all API calls:

```javascript
// api.js - API Integration Layer

const API_BASE_URL = 'http://localhost:5000/api/v1';

// Store tokens in localStorage
const TokenManager = {
  getAccessToken: () => localStorage.getItem('accessToken'),
  getRefreshToken: () => localStorage.getItem('refreshToken'),
  setTokens: (accessToken, refreshToken) => {
    localStorage.setItem('accessToken', accessToken);
    localStorage.setItem('refreshToken', refreshToken);
  },
  clearTokens: () => {
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
  },
};

// API request wrapper with auth
async function apiRequest(endpoint, options = {}) {
  const url = `${API_BASE_URL}${endpoint}`;
  
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  // Add auth token if available
  const token = TokenManager.getAccessToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  try {
    const response = await fetch(url, {
      ...options,
      headers,
    });

    // Handle token refresh on 401
    if (response.status === 401 && token) {
      const refreshed = await refreshAccessToken();
      if (refreshed) {
        // Retry original request
        headers['Authorization'] = `Bearer ${TokenManager.getAccessToken()}`;
        const retryResponse = await fetch(url, { ...options, headers });
        return await retryResponse.json();
      }
    }

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Request failed');
    }

    return data;
  } catch (error) {
    console.error('API Error:', error);
    throw error;
  }
}

// Refresh access token
async function refreshAccessToken() {
  try {
    const refreshToken = TokenManager.getRefreshToken();
    if (!refreshToken) return false;

    const response = await fetch(`${API_BASE_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });

    const data = await response.json();
    
    if (data.success) {
      TokenManager.setTokens(data.data.accessToken, data.data.refreshToken);
      return true;
    }

    return false;
  } catch (error) {
    TokenManager.clearTokens();
    return false;
  }
}

// ============================================
// AUTH API
// ============================================

const AuthAPI = {
  register: async (email, password, name) => {
    const data = await apiRequest('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, name }),
    });
    
    if (data.success) {
      TokenManager.setTokens(
        data.data.accessToken,
        data.data.refreshToken
      );
    }
    
    return data;
  },

  login: async (email, password) => {
    const data = await apiRequest('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    
    if (data.success) {
      TokenManager.setTokens(
        data.data.accessToken,
        data.data.refreshToken
      );
    }
    
    return data;
  },

  logout: async () => {
    const refreshToken = TokenManager.getRefreshToken();
    await apiRequest('/auth/logout', {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
    });
    TokenManager.clearTokens();
  },

  getCurrentUser: async () => {
    return await apiRequest('/auth/me');
  },
};

// ============================================
// WORKOUTS API
// ============================================

const WorkoutsAPI = {
  getExercises: async (filters = {}) => {
    const params = new URLSearchParams(filters);
    return await apiRequest(`/workouts?${params}`);
  },

  getExerciseById: async (id) => {
    return await apiRequest(`/workouts/${id}`);
  },

  logWorkout: async (workoutData) => {
    return await apiRequest('/progress', {
      method: 'POST',
      body: JSON.stringify(workoutData),
    });
  },
};

// ============================================
// PROGRAMS API
// ============================================

const ProgramsAPI = {
  getPrograms: async () => {
    return await apiRequest('/programs');
  },

  getProgramById: async (id) => {
    return await apiRequest(`/programs/${id}`);
  },

  enrollInProgram: async (programId) => {
    return await apiRequest(`/programs/${programId}/enroll`, {
      method: 'POST',
    });
  },

  getUserPrograms: async () => {
    return await apiRequest('/programs/my-programs');
  },
};

// ============================================
// PROGRESS API
// ============================================

const ProgressAPI = {
  getUserProgress: async () => {
    return await apiRequest('/progress/me');
  },

  getStats: async (period = '30d') => {
    return await apiRequest(`/progress/stats?period=${period}`);
  },

  getWorkoutHistory: async () => {
    return await apiRequest('/progress/history');
  },
};

// Check if user is authenticated
function isAuthenticated() {
  return !!TokenManager.getAccessToken();
}

// Redirect to login if not authenticated
function requireAuth() {
  if (!isAuthenticated()) {
    window.location.href = 'login.html';
  }
}
```

### Step 3: Create Login Page

Create `login.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Login - FlowFit</title>
    <!-- Use same styles from index.html -->
    <style>
        /* Add login-specific styles */
        .login-container {
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 2rem;
        }

        .login-card {
            background: var(--bg-card);
            padding: 3rem;
            border-radius: 25px;
            max-width: 450px;
            width: 100%;
        }

        .form-group {
            margin-bottom: 1.5rem;
        }

        .form-input {
            width: 100%;
            padding: 1rem;
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid var(--border);
            border-radius: 12px;
            color: var(--text-primary);
            font-size: 1rem;
        }

        .error-message {
            color: #f87171;
            font-size: 0.9rem;
            margin-top: 0.5rem;
        }
    </style>
</head>
<body>
    <div class="login-container">
        <div class="login-card">
            <h1>Welcome Back</h1>
            <form id="loginForm">
                <div class="form-group">
                    <input 
                        type="email" 
                        class="form-input" 
                        placeholder="Email"
                        required
                        id="email"
                    >
                </div>
                <div class="form-group">
                    <input 
                        type="password" 
                        class="form-input" 
                        placeholder="Password"
                        required
                        id="password"
                    >
                </div>
                <div class="error-message" id="errorMessage"></div>
                <button type="submit" class="btn btn-primary" style="width: 100%;">
                    Login
                </button>
            </form>
            <p style="margin-top: 1.5rem; text-align: center;">
                Don't have an account? 
                <a href="register.html" style="color: var(--accent);">Register</a>
            </p>
        </div>
    </div>

    <script src="api.js"></script>
    <script>
        document.getElementById('loginForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const email = document.getElementById('email').value;
            const password = document.getElementById('password').value;
            const errorMessage = document.getElementById('errorMessage');
            
            errorMessage.textContent = '';
            
            try {
                const result = await AuthAPI.login(email, password);
                
                if (result.success) {
                    window.location.href = 'dashboard.html';
                }
            } catch (error) {
                errorMessage.textContent = error.message || 'Login failed';
            }
        });
    </script>
</body>
</html>
```

### Step 4: Update Dashboard to Fetch Real Data

Add to `dashboard.html` before closing `</body>`:

```html
<script src="api.js"></script>
<script>
    // Require authentication
    requireAuth();

    // Fetch and display user data
    async function loadDashboard() {
        try {
            // Get current user
            const userResponse = await AuthAPI.getCurrentUser();
            console.log('User:', userResponse.data);

            // Get progress stats
            const stats = await ProgressAPI.getStats();
            
            // Update UI with real data
            updateStatsCards(stats.data);
            
            // Get workout history
            const history = await ProgressAPI.getWorkoutHistory();
            updateWorkoutHistory(history.data);
            
        } catch (error) {
            console.error('Failed to load dashboard:', error);
        }
    }

    function updateStatsCards(stats) {
        // Update streak
        document.querySelector('.stat-value').textContent = stats.currentStreak || 0;
        
        // Update other stats
        // ... map your stats to DOM elements
    }

    function updateWorkoutHistory(history) {
        // Update workout history table
        // ... render history items
    }

    // Load dashboard on page load
    loadDashboard();
</script>
```

## 🔄 API Endpoints Reference

### Authentication
```javascript
// Register
POST /api/v1/auth/register
Body: { email, password, name }

// Login
POST /api/v1/auth/login
Body: { email, password }

// Get current user
GET /api/v1/auth/me
Headers: { Authorization: 'Bearer {token}' }

// Logout
POST /api/v1/auth/logout
Body: { refreshToken }
```

### Workouts
```javascript
// Get exercises
GET /api/v1/workouts?difficulty=BEGINNER&category=STRENGTH

// Get exercise details
GET /api/v1/workouts/:id

// Log workout
POST /api/v1/progress
Body: {
  exerciseId: 'uuid',
  duration: 1800, // seconds
  sets: 3,
  reps: 15,
  caloriesBurned: 200
}
```

### Programs
```javascript
// Get programs
GET /api/v1/programs

// Get program details
GET /api/v1/programs/:id

// Enroll in program
POST /api/v1/programs/:id/enroll
```

### Progress
```javascript
// Get user progress
GET /api/v1/progress/me

// Get statistics
GET /api/v1/progress/stats?period=30d

// Get workout history
GET /api/v1/progress/history
```

## 🔐 Authentication Flow

1. User registers/logs in
2. Backend returns access token (15min) and refresh token (7 days)
3. Store tokens in localStorage
4. Include access token in Authorization header for protected routes
5. On 401 error, use refresh token to get new access token
6. If refresh fails, redirect to login

## 🎨 Updating Frontend Components

### Example: Fetch Exercises in Workouts Page

```javascript
// workouts.html
async function loadExercises() {
    try {
        const response = await WorkoutsAPI.getExercises();
        const exercises = response.data;
        
        // Clear existing exercises
        const grid = document.querySelector('.exercise-grid');
        grid.innerHTML = '';
        
        // Render exercises
        exercises.forEach(exercise => {
            const card = createExerciseCard(exercise);
            grid.appendChild(card);
        });
    } catch (error) {
        console.error('Failed to load exercises:', error);
    }
}

function createExerciseCard(exercise) {
    const card = document.createElement('div');
    card.className = 'exercise-card';
    card.innerHTML = `
        <div class="exercise-image">
            <span>${getExerciseIcon(exercise.category)}</span>
            <div class="difficulty-badge difficulty-${exercise.difficulty.toLowerCase()}">
                ${exercise.difficulty}
            </div>
        </div>
        <div class="exercise-content">
            <h3 class="exercise-title">${exercise.name}</h3>
            <div class="exercise-meta">
                <span>⏱️ ${Math.floor(exercise.duration / 60)} min</span>
                <span>🔥 ${Math.floor(exercise.caloriesPerMin * exercise.duration / 60)} cal</span>
            </div>
            <p class="exercise-description">${exercise.description}</p>
            <div class="exercise-actions">
                <button class="btn-action btn-start" onclick="startExercise('${exercise.id}')">
                    Start Exercise
                </button>
            </div>
        </div>
    `;
    return card;
}

function getExerciseIcon(category) {
    const icons = {
        'STRENGTH': '💪',
        'CARDIO': '🏃',
        'FLEXIBILITY': '🧘',
        'CORE': '🧘'
    };
    return icons[category] || '💪';
}

// Load exercises on page load
loadExercises();
```

## 🚀 Deployment

### Frontend Deployment
- **Vercel**: `vercel deploy`
- **Netlify**: Connect GitHub repo
- **GitHub Pages**: Enable in repo settings

### Backend Deployment
- See `DEPLOYMENT.md` for full guide
- Railway, Render, or VPS options

### CORS Configuration

Update backend `.env`:
```env
FRONTEND_URL=https://your-frontend.vercel.app
CORS_ORIGIN=https://your-frontend.vercel.app
```

Update frontend `api.js`:
```javascript
const API_BASE_URL = 'https://your-backend.railway.app/api/v1';
```

## 🐛 Troubleshooting

**CORS Errors:**
- Ensure backend CORS_ORIGIN includes frontend URL
- Check backend is running
- Verify API_BASE_URL in frontend

**Authentication Failures:**
- Check token storage (localStorage)
- Verify JWT secrets match between requests
- Check token expiration

**API Connection Issues:**
- Verify backend is running: `curl http://localhost:5000/health`
- Check network tab in browser DevTools
- Verify API_BASE_URL is correct

## 📚 Next Steps

1. Complete remaining API modules (users, subscriptions, analytics)
2. Add loading states and error handling to frontend
3. Implement file upload for profile pictures
4. Add real-time features with WebSockets
5. Implement push notifications
6. Add payment integration (Stripe/M-Pesa)

## 🎯 Production Checklist

- [ ] Backend deployed and accessible
- [ ] Frontend deployed and accessible
- [ ] CORS configured correctly
- [ ] Environment variables set
- [ ] SSL/HTTPS enabled on both
- [ ] Error tracking configured
- [ ] Analytics integrated
- [ ] User testing completed

---

**Need Help?** Check the README files in both frontend and backend directories, or contact support@flowfit.com
