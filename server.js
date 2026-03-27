require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self' https://appssdk.zoom.us https://fonts.googleapis.com https://fonts.gstatic.com; script-src 'self' https://appssdk.zoom.us; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:");
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'microphone=*');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// OAuth callback
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing code');

  const credentials = Buffer.from(`${process.env.ZOOM_CLIENT_ID}:${process.env.ZOOM_CLIENT_SECRET}`).toString('base64');
  const redirectUri = `${process.env.PUBLIC_URL}/auth/callback`;

  try {
    const response = await fetch('https://zoom.us/oauth/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    });

    const token = await response.json();
    if (token.error) return res.status(400).send(`OAuth error: ${token.error}`);

    // Store token in a cookie and redirect to the app
    res.cookie('zoom_token', token.access_token, { httpOnly: true, secure: true, sameSite: 'None' });
    res.redirect('/');
  } catch (err) {
    res.status(500).send('Token exchange failed: ' + err.message);
  }
});

app.listen(PORT, () => {
  console.log(`Mezzo Zoom app running at http://localhost:${PORT}`);
});
