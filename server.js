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

// Clear old logs
fs.writeFileSync('./request-logs.txt', '=== Server Started ===\n');
function logToFile(msg) {
    fs.appendFileSync('./request-logs.txt', msg + '\n');
    console.log(msg);
}

logToFile('');
logToFile('[SERVER] Initializing...');

mongoose.connection.on('connected', () => logToFile('MongoDB Connected🚀'));
mongoose.connection.on('error', (err) => {
    const safeMsg = String(err).replace(/mongodb(\+srv)?:\/\/[^@]+@/i, 'mongodb$1://***:***@');
    logToFile('MongoDB connection error: ' + safeMsg);
});
mongoose.connection.on('disconnected', () => logToFile('MongoDB disconnected'));

const isProduction = process.env.NODE_ENV === 'production';

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

// CORS configuration to allow multiple origins
const corsOption = {
    origin: function (origin, callback) {
        const allowedOrigins = [
            'http://localhost:5173',
            'http://localhost:5174',
            'http://127.0.0.1:5173',
            'http://127.0.0.1:5174'
        ];
        
        if (!origin || allowedOrigins.includes(origin)) {
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

app.listen(5001, () => {
    logToFile('Server is running on port 5001');
});