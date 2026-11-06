require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const fs = require('fs');

const mongoose = require('mongoose');
const authRoutes = require('./src/routes/authRoutes');
const groupRoutes = require('./src/routes/groupRoutes');
const rbacRoutes = require('./src/routes/rbacRoutes');
const paymentsRoutes = require('./src/routes/paymentsRoutes');
const profileRoutes = require('./src/routes/profileRoutes');
const expenseRoutes = require('./src/routes/expenseRoutes');

// Clear old logs in development
const isProduction = process.env.NODE_ENV === 'production';

function sanitizeLogMessage(msg) {
    return String(msg)
        .replace(/mongodb(\+srv)?:\/\/[^@]+@/i, 'mongodb$1://***:***@')
        .replace(/(password|secret|token|apiKey|api_secret|key_secret)=([^\s&]+)/gi, '$1=***')
        .replace(/("?(password|secret|token|apiKey|api_secret|key_secret)"?\s*:\s*)"[^"]+"/gi, '$1"***"');
}

function logToFile(msg) {
    const sanitized = sanitizeLogMessage(msg);
    if (!isProduction) {
        try {
            fs.appendFileSync('./request-logs.txt', sanitized + '\n');
        } catch (e) {
            // ignore file write errors
        }
    }
    console.log(sanitized);
}

if (!isProduction) {
    try {
        fs.writeFileSync('./request-logs.txt', '=== Server Started ===\n');
    } catch (e) {
        // ignore
    }
}

logToFile('');
logToFile('[SERVER] Initializing...');

mongoose.connection.on('connected', () => logToFile('MongoDB Connected🚀'));
mongoose.connection.on('error', (err) => {
    logToFile('MongoDB connection error: ' + String(err));
});
mongoose.connection.on('disconnected', () => logToFile('MongoDB disconnected'));

let connectAttempts = 0;
function connectWithRetry() {
    const primaryUrl = process.env.MONGO_DB_CONNECTION_URL;
    const fallbackUrl = 'mongodb://127.0.0.1:27017/mergemoney';

    // Strictly disallow local fallback in production environments
    const canFallback = !isProduction &&
        connectAttempts >= 2 &&
        primaryUrl &&
        !primaryUrl.includes('127.0.0.1') &&
        !primaryUrl.includes('localhost');

    const targetUrl = canFallback ? fallbackUrl : primaryUrl;

    mongoose.connect(targetUrl, { serverSelectionTimeoutMS: 4000 })
        .then(() => {
            if (targetUrl === fallbackUrl) {
                logToFile('MongoDB Connected locally (development fallback)🚀');
            }
        })
        .catch((error) => {
            connectAttempts++;
            const safeMsg = String(error).replace(/mongodb(\+srv)?:\/\/[^@]+@/i, 'mongodb$1://***:***@');
            if (isProduction) {
                logToFile(`[PRODUCTION] Error Connecting to Primary Database (attempt ${connectAttempts}): ${safeMsg}. Localhost fallback disabled in production.`);
            } else {
                logToFile(`Error Connecting to Database (attempt ${connectAttempts}): ${safeMsg}`);
            }
            setTimeout(connectWithRetry, 3000);
        });
}
connectWithRetry();

// CORS configuration supporting CLIENT_URL, ALLOWED_ORIGINS, Vercel deployments and local development
const defaultDevOrigins = [
    'http://localhost:5173',
    'http://localhost:5174',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:5174'
];

const parseOrigins = (str) => {
    if (!str) return [];
    return str
        .split(',')
        .map(o => o.trim().replace(/\/+$/, ''))
        .filter(Boolean);
};

const configuredOrigins = [
    ...parseOrigins(process.env.CLIENT_URL),
    ...parseOrigins(process.env.ALLOWED_ORIGINS)
];

const staticAllowedOrigins = Array.from(new Set([
    ...configuredOrigins,
    'https://merge-money-client.vercel.app',
    'https://merge-money-client-6fvycajsa-jadaunprashant-777-6157s-projects.vercel.app',
    ...(!isProduction ? defaultDevOrigins : [])
]));

const isAllowedOrigin = (origin) => {
    if (!origin) return true;
    const normalized = origin.trim().replace(/\/+$/, '');
    if (staticAllowedOrigins.includes(normalized)) {
        return true;
    }
    // Allow official Vercel deployments scoped to this project
    if (/^https:\/\/merge-money-client(-[a-z0-9]+)*-jadaunprashant-777-6157s-projects\.vercel\.app$/i.test(normalized)) {
        return true;
    }
    // Allow localhost/127.0.0.1 development ports when not in production
    if (!isProduction && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(normalized)) {
        return true;
    }
    return false;
};

const corsOption = {
    origin: function (origin, callback) {
        if (isAllowedOrigin(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'x-rtb-fingerprint-id'],
    exposedHeaders: ['x-rtb-fingerprint-id']
};

const app = express();

app.use(cors(corsOption));
app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
})); // Middleware with raw-body preservation for webhooks
app.use(cookieParser()); // Middleware

app.use('/auth', authRoutes);
app.use('/groups', groupRoutes);
app.use('/users', rbacRoutes);
app.use('/payments', paymentsRoutes);
app.use('/profile', profileRoutes);
app.use('/expenses', expenseRoutes);

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
    logToFile(`Server is running on port ${PORT}`);
});