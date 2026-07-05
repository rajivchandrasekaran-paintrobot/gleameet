const express = require('express');
const helmet = require('helmet');
const path = require('path');

const app = express();

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://appssdk.zoom.us'],
      connectSrc: ["'self'", 'https://appssdk.zoom.us'],
      styleSrc: ["'self'", "'unsafe-inline'"],
    },
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

app.use(express.static(path.join(__dirname)));

app.use(express.json());

const crypto = require('crypto');

app.post('/webhooks/zoom', (req, res) => {
  const { event, payload } = req.body || {};

  if (event === 'endpoint.url_validation' && payload?.plainToken) {
    const secret = process.env.ZOOM_WEBHOOK_SECRET_TOKEN;
    if (!secret) {
      console.error('[ZOOM WEBHOOK] Missing ZOOM_WEBHOOK_SECRET_TOKEN env var — cannot validate');
      res.sendStatus(500);
      return;
    }
    const encryptedToken = crypto
      .createHmac('sha256', secret)
      .update(payload.plainToken)
      .digest('hex');
    res.json({ plainToken: payload.plainToken, encryptedToken });
    return;
  }

  console.log('[ZOOM WEBHOOK]', event, JSON.stringify(payload, null, 2));
  res.sendStatus(200);
});

app.listen(3000, () => console.log('Spike app listening on :3000'));