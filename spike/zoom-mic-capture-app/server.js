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
      mediaSrc: ["'self'", 'blob:'],
    },
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

app.use(express.static(path.join(__dirname)));

app.listen(3000, () => console.log('Mic-capture spike listening on :3000'));
