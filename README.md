# Jungle Sort Showdown

Browser game built with HTML/CSS/vanilla JS and a small Node.js server for optional phone controllers (team QR links).

## Requirements

- Node.js 18+

## Run locally

1. Install dependencies:
   npm install
2. Start server:
   npm start
3. Open host page in browser:
   http://localhost:3000

## Phone controller mode

1. On setup screen, enable **phone controllers**.
2. Set **Public Host URL**:
   - Local Wi-Fi: `http://<your-laptop-ip>:3000`
   - Hosted: `https://<your-app>.onrender.com`
3. Teams scan the generated QR codes.

## Deploy (Render)

- Build command: `npm install`
- Start command: `npm start`
- Use the Render service URL in **Public Host URL** for QR generation.

## Project files

- `index.html` - Host game UI
- `phone.html` - Team phone controller page (1-4 buttons)
- `server.js` - Express + WebSocket + QR session backend
- `package.json` - Scripts and dependencies
