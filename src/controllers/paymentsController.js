const Razorpay = require('razorpay');
const crypto = require('crypto');

const { CREDIT_TO_PAISA_MAPPING, PLAN_IDS } = require('../constants/paymentConstants');
const Users = require('../model/user');
const WebhookEvent = require('../model/webhookEvent');

const getRazorpayClient = () => new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const paymentsController = {
    // Fetch public plan configurations
    getPlans: async (request, response) => {
        try {
            return response.status(200).json({
                plans: {
                    UNLIMITED_MONTHLY: {
                        id: 'UNLIMITED_MONTHLY',
                        name: 'Premium Monthly',
                        price: 99,
                        period: 'month',
                        planId: PLAN_IDS.UNLIMITED_MONTHLY?.id
                    },
                    UNLIMITED_YEARLY: {
                        id: 'UNLIMITED_YEARLY',
                        name: 'Premium Yearly',
                        price: 799,
                        period: 'year',
                        planId: PLAN_IDS.UNLIMITED_YEARLY?.id
                    }
                }
            });
        } catch (error) {
            console.error('Error fetching plans:', error);
            return response.status(500).json({ message: 'Internal server error' });
        }
    },

    // Step-2 from sequence diagram: One-time credit order creation
    createOrder: async (request, response) => {
        try {
            const { credits } = request.body;

            if (!CREDIT_TO_PAISA_MAPPING[credits]) {
                return response.status(400).json({
                    message: 'Invalid credit value'
                });
            }

            const amountInPaise = CREDIT_TO_PAISA_MAPPING[credits];
            const razorpay = getRazorpayClient();

            const order = await razorpay.orders.create({
                amount: amountInPaise,
                currency: 'INR',
                receipt: `receipt_${Date.now()}`
            });

            return response.json({ order: order });
        } catch (error) {
            console.error('Error creating Razorpay order:', error);
            const status = error.statusCode || 500;
            const message = error.error?.description || error.message || 'Internal server error';
            return response.status(status).json({ message });
        }
    },

    // Step-8 from sequence diagram: One-time credit order verification
    verifyOrder: async (request, response) => {
        try {
            const {
                razorpay_order_id, razorpay_payment_id, 
                razorpay_signature, credits
            } = request.body;

            const body = razorpay_order_id + '|' + razorpay_payment_id;
            const expectedSignature = crypto
                .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
                .update(body.toString())
                .digest('hex');
            
            if (expectedSignature !== razorpay_signature) {
                return response.status(400).json({ message: 'Invalid transaction' });
            }

            const user = await Users.findById({ _id: request.user._id });
            user.credits += Number(credits);
            await user.save();
            
            const safeUser = user.toObject ? user.toObject() : { ...user };
            delete safeUser.password;

            return response.json({ user: safeUser });
        } catch (error) {
            console.error('Error verifying order:', error);
            const status = error.statusCode || 500;
            const message = error.error?.description || error.message || 'Internal server error';
            return response.status(status).json({ message });
        }
    },

    // Initiate Razorpay subscription
    createSubscription: async (request, response) => {
        try {
            const { plan_name } = request.body;

            if (!PLAN_IDS[plan_name]) {
                return response.status(400).json({
                    message: 'Invalid plan selected'
                });
            }

            const plan = PLAN_IDS[plan_name];
            if (!plan || !plan.id) {
                return response.status(400).json({
                    message: `Subscription plan configuration is missing for ${plan_name}. Please verify plan ID configuration.`
                });
            }

            // Check if user already has an active subscription
            const user = await Users.findById(request.user._id);
            if (!user) {
                return response.status(404).json({ message: 'User not found' });
            }

            const isAlreadyActive = user.subscription &&
                user.subscription.status === 'active' &&
                (!user.subscription.end || new Date(user.subscription.end) > new Date());

            if (isAlreadyActive) {
                return response.status(400).json({
                    message: 'User already has an active subscription',
                    subscription: user.subscription
                });
            }

            const razorpay = getRazorpayClient();
            const subscription = await razorpay.subscriptions.create({
                plan_id: plan.id,
                customer_notify: 1,
                total_count: plan.totalBillingCycleCount,
                notes: {
                    userId: request.user._id.toString()
                }
            });

            return response.json({ subscription: subscription });
        } catch (error) {
            console.error('Error creating subscription:', error);
            const status = error.statusCode || 500;
            const message = error.error?.description || error.message || 'Internal server error';
            return response.status(status).json({ message });
        }
    },

    // Verify subscription checkout signature from frontend Razorpay Checkout
    verifySubscription: async (request, response) => {
        try {
            const {
                razorpay_payment_id,
                razorpay_subscription_id,
                razorpay_signature
            } = request.body;

            if (!razorpay_payment_id || !razorpay_subscription_id || !razorpay_signature) {
                return response.status(400).json({
                    message: 'Missing required subscription checkout verification fields'
                });
            }

            // Cryptographic HMAC SHA-256 verification
            const dataToSign = `${razorpay_payment_id}|${razorpay_subscription_id}`;
            const expectedSignature = crypto
                .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
                .update(dataToSign)
                .digest('hex');

            let signaturesMatch = false;
            try {
                signaturesMatch = crypto.timingSafeEqual(
                    Buffer.from(expectedSignature, 'utf-8'),
                    Buffer.from(razorpay_signature, 'utf-8')
                );
            } catch {
                signaturesMatch = (expectedSignature === razorpay_signature);
            }

            if (!signaturesMatch) {
                return response.status(400).json({ message: 'Invalid subscription signature' });
            }

            // Fetch verified subscription entity from Razorpay API
            const razorpay = getRazorpayClient();
            const subscription = await razorpay.subscriptions.fetch(razorpay_subscription_id);

            // Verify subscription belongs to authenticated user
            const notesUserId = subscription.notes?.userId;
            if (notesUserId && notesUserId.toString() !== request.user._id.toString()) {
                return response.status(403).json({
                    message: 'Subscription does not belong to authenticated user'
                });
            }

            const user = await Users.findById(request.user._id);
            if (!user) {
                return response.status(404).json({ message: 'User not found' });
            }

            // Prevent duplicate active subscriptions
            if (user.subscription &&
                user.subscription.status === 'active' &&
                user.subscription.subscriptionId !== razorpay_subscription_id &&
                (!user.subscription.end || new Date(user.subscription.end) > new Date())) {
                return response.status(400).json({
                    message: 'User already has another active subscription',
                    subscription: user.subscription
                });
            }

            // Determine status from Razorpay's authoritative entity (never client-provided)
            const verifiedStatus = (subscription.status === 'authenticated' || subscription.status === 'active')
                ? 'active'
                : subscription.status;

            const planKey = subscription.plan_id === PLAN_IDS.UNLIMITED_YEARLY?.id
                ? 'UNLIMITED_YEARLY'
                : 'UNLIMITED_MONTHLY';

            user.subscription = {
                subscriptionId: razorpay_subscription_id,
                planId: subscription.plan_id,
                planKey: planKey,
                status: verifiedStatus,
                start: subscription.start_at ? new Date(subscription.start_at * 1000) : new Date(),
                end: subscription.end_at ? new Date(subscription.end_at * 1000) : null,
                lastBillDate: subscription.current_start ? new Date(subscription.current_start * 1000) : new Date(),
                nextBillDate: subscription.current_end ? new Date(subscription.current_end * 1000) : null,
                paymentsMade: subscription.paid_count !== undefined ? subscription.paid_count : 1,
                paymentsRemaining: subscription.remaining_count !== undefined ? subscription.remaining_count : null
            };
            await user.save();

            const safeUser = user.toObject ? user.toObject() : { ...user };
            delete safeUser.password;

            return response.status(200).json({
                message: 'Subscription verified and activated successfully',
                user: safeUser
            });
        } catch (error) {
            console.error('Error verifying subscription:', error);
            const status = error.statusCode || 500;
            const message = error.error?.description || error.message || 'Internal server error';
            return response.status(status).json({ message });
        }
    },

    // Backward-compatible capture endpoint with ownership verification
    captureSubscription: async (request, response) => {
        try {
            const { subscriptionId } = request.body;

            if (!subscriptionId) {
                return response.status(400).json({ message: 'subscriptionId is required' });
            }

            const razorpay = getRazorpayClient();
            const subscription = await razorpay.subscriptions.fetch(subscriptionId);

            // Verify ownership
            if (subscription.notes?.userId && subscription.notes.userId.toString() !== request.user._id.toString()) {
                return response.status(403).json({ message: 'Subscription does not belong to authenticated user' });
            }

            const user = await Users.findById(request.user._id);
            if (!user) {
                return response.status(404).json({ message: 'User not found' });
            }

            const verifiedStatus = (subscription.status === 'authenticated' || subscription.status === 'active')
                ? 'active'
                : subscription.status;

            const planKey = subscription.plan_id === PLAN_IDS.UNLIMITED_YEARLY?.id
                ? 'UNLIMITED_YEARLY'
                : 'UNLIMITED_MONTHLY';

            user.subscription = {
                subscriptionId: subscriptionId,
                planId: subscription.plan_id,
                planKey: planKey,
                status: verifiedStatus,
                start: subscription.start_at ? new Date(subscription.start_at * 1000) : null,
                end: subscription.end_at ? new Date(subscription.end_at * 1000) : null,
                lastBillDate: subscription.current_start ? new Date(subscription.current_start * 1000) : null,
                nextBillDate: subscription.current_end ? new Date(subscription.current_end * 1000) : null,
                paymentsMade: subscription.paid_count || 0,
                paymentsRemaining: subscription.remaining_count || 0
            };
            await user.save();

            const safeUser = user.toObject ? user.toObject() : { ...user };
            delete safeUser.password;

            return response.json({ user: safeUser });
        } catch (error) {
            console.error('Error capturing subscription:', error);
            return response.status(500).json({ message: 'Internal server error' });
        }
    },

    // Handle webhook events from Razorpay
    handleWebhookEvents: async (request, response) => {
        try {
            const signature = request.headers['x-razorpay-signature'];
            if (!signature) {
                return response.status(400).send('Missing signature header');
            }

            // Raw bytes preserved via express.json verify callback
            const rawBody = request.rawBody || (Buffer.isBuffer(request.body)
                ? request.body
                : Buffer.from(typeof request.body === 'string' ? request.body : JSON.stringify(request.body)));

            const expectedSignature = crypto
                .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
                .update(rawBody)
                .digest('hex');

            let signaturesMatch = false;
            try {
                signaturesMatch = crypto.timingSafeEqual(
                    Buffer.from(expectedSignature, 'utf-8'),
                    Buffer.from(signature, 'utf-8')
                );
            } catch {
                signaturesMatch = (expectedSignature === signature);
            }

            if (!signaturesMatch) {
                return response.status(400).send('Invalid signature');
            }

            const payload = typeof request.body === 'object' && !Buffer.isBuffer(request.body)
                ? request.body
                : JSON.parse(rawBody.toString('utf-8'));

            // Idempotency check with atomic claim
            const eventId = request.headers['x-razorpay-event-id'] || payload.id || payload.event_id;
            let claim = null;
            if (eventId) {
                // 1. Try to claim an existing retryable event (status: 'failed' or stuck in 'processing' > 60s)
                claim = await WebhookEvent.findOneAndUpdate(
                    {
                        eventId,
                        $or: [
                            { status: 'failed' },
                            { status: 'processing', lockedAt: { $lt: new Date(Date.now() - 60000) } }
                        ]
                    },
                    {
                        $set: { status: 'processing', lockedAt: new Date(), event: payload.event },
                        $inc: { attempts: 1 }
                    },
                    { new: true }
                );

                // 2. If no retryable event exists, attempt to atomically insert a new claim
                if (!claim) {
                    try {
                        claim = await WebhookEvent.create({
                            eventId,
                            event: payload.event,
                            status: 'processing',
                            lockedAt: new Date(),
                            attempts: 1
                        });
                    } catch (err) {
                        if (err.code === 11000) {
                            // Unique index violation: already claimed or processed by another delivery
                            const existing = await WebhookEvent.findOne({ eventId });
                            if (existing?.status === 'processed') {
                                return response.status(200).json({
                                    message: `Event ${eventId} has already been processed`,
                                    duplicate: true
                                });
                            }
                            if (existing?.status === 'processing') {
                                return response.status(200).json({
                                    message: `Event ${eventId} is currently being processed by another worker`,
                                    duplicate: true,
                                    inFlight: true
                                });
                            }
                        }
                        throw err;
                    }
                }
            }

            try {
                const event = payload.event;
                const subscriptionData = payload.payload?.subscription?.entity;

                // If event is not subscription-related, acknowledge and mark processed
                if (!subscriptionData) {
                    if (eventId) {
                        await WebhookEvent.updateOne({ eventId }, { $set: { status: 'processed', processedAt: new Date() } });
                    }
                    return response.status(200).send(`Event received: ${event}`);
                }

                const razorpaySubscriptionId = subscriptionData.id;
                const userId = subscriptionData.notes?.userId;

                let newStatus;
                switch (event) {
                    case 'subscription.activated':
                    case 'subscription.charged':
                    case 'subscription.resumed':
                        newStatus = 'active';
                        break;

                    case 'subscription.pending':
                        newStatus = 'pending';
                        break;

                    case 'subscription.halted':
                        newStatus = 'halted';
                        break;

                    case 'subscription.cancelled':
                        newStatus = 'cancelled';
                        break;

                    case 'subscription.completed':
                        newStatus = 'completed';
                        break;

                    case 'subscription.paused':
                        newStatus = 'paused';
                        break;

                    default:
                        if (eventId) {
                            await WebhookEvent.updateOne({ eventId }, { $set: { status: 'processed', processedAt: new Date() } });
                        }
                        return response.status(200).send(`Unhandled event received: ${event}`);
                }

                let planKey = null;
                if (subscriptionData.plan_id === PLAN_IDS.UNLIMITED_MONTHLY?.id) {
                    planKey = 'UNLIMITED_MONTHLY';
                } else if (subscriptionData.plan_id === PLAN_IDS.UNLIMITED_YEARLY?.id) {
                    planKey = 'UNLIMITED_YEARLY';
                }

                const updateFields = {
                    'subscription.subscriptionId': razorpaySubscriptionId,
                    'subscription.status': newStatus,
                    'subscription.planId': subscriptionData.plan_id,
                };

                if (planKey) {
                    updateFields['subscription.planKey'] = planKey;
                }

                if (subscriptionData.start_at) {
                    updateFields['subscription.start'] = new Date(subscriptionData.start_at * 1000);
                }
                if (subscriptionData.end_at) {
                    updateFields['subscription.end'] = new Date(subscriptionData.end_at * 1000);
                }
                if (subscriptionData.current_start) {
                    updateFields['subscription.lastBillDate'] = new Date(subscriptionData.current_start * 1000);
                }
                if (subscriptionData.current_end) {
                    updateFields['subscription.nextBillDate'] = new Date(subscriptionData.current_end * 1000);
                }
                if (subscriptionData.paid_count !== undefined) {
                    updateFields['subscription.paymentsMade'] = subscriptionData.paid_count;
                }
                if (subscriptionData.remaining_count !== undefined) {
                    updateFields['subscription.paymentsRemaining'] = subscriptionData.remaining_count;
                }

                const query = userId ? { _id: userId } : { 'subscription.subscriptionId': razorpaySubscriptionId };
                const updatedUser = await Users.findOneAndUpdate(
                    query,
                    { $set: updateFields },
                    { new: true }
                );

                // Mark event as processed for idempotency
                if (eventId) {
                    await WebhookEvent.updateOne(
                        { eventId },
                        {
                            $set: {
                                status: 'processed',
                                processedAt: new Date(),
                                lastError: null
                            }
                        }
                    );
                }

                return response.status(200).json({
                    message: `Webhook event ${event} processed successfully`,
                    subscriptionId: razorpaySubscriptionId,
                    status: newStatus,
                    userUpdated: Boolean(updatedUser)
                });
            } catch (processingError) {
                // Record failure status and error details for safe retryability
                if (eventId) {
                    await WebhookEvent.updateOne(
                        { eventId },
                        {
                            $set: {
                                status: 'failed',
                                lastError: processingError.message || String(processingError)
                            }
                        }
                    );
                }
                throw processingError;
            }
        } catch (error) {
            console.error('Error processing webhook event:', error);
            return response.status(500).send('Internal server error');
        }
    },
};

module.exports = paymentsController;
