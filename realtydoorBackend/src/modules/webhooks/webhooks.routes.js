const express = require('express');
const router  = express.Router();
const ctrl    = require('./webhooks.controller');
const { clerkWebhook } = require('./clerk.handler');
const { watiWebhook }  = require('./wati.handler');
const leadIntake = require('../leadIntake/leadIntake.controller');

// Both routes use express.raw() — safe because this router is mounted in app.js
// BEFORE express.json(), so the stream has not been consumed yet.

const rawBody = (req, res, next) => {
  express.raw({ type: 'application/json' })(req, res, () => {
    try {
      req.rawBody = req.body;
      req.body    = JSON.parse(req.body.toString());
      next();
    } catch {
      res.status(400).json({ error: 'Invalid JSON in webhook body' });
    }
  });
};

router.post('/razorpay', rawBody, ctrl.razorpay);
router.post('/clerk',    rawBody, clerkWebhook);
router.post('/wati',     rawBody, watiWebhook);
// Lead integrations: any outside source posts leads here with its own key (see modules/leadIntake).
router.post('/leads/:keyId', rawBody, leadIntake.webhook);

module.exports = router;
