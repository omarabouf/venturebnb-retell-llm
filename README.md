
# Venturebnb Retell LLM Server

This is a tiny Express server that powers your Retell AI agent flow (profit analysis → appointment booking).

## Local run

1) Install Node.js 18+
2) In a terminal:
```bash
npm install
cp .env.example .env   # then edit .env as needed
npm start
```
Server runs on http://localhost:8080

## Deploy (Render - easiest)
1. Create a GitHub repo and push these files.
2. Go to https://render.com → New → Web Service → Connect your repo.
3. Settings:
   - Runtime: Node
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Environment: add vars from `.env` (BOOKING_WEBHOOK_URL, OFFER_SLOT_A/B).
4. Deploy → copy the public URL like `https://your-app.onrender.com/retell-llm`

## Hook into Retell
- In your Retell agent, set **Custom LLM URL** to `https://your-app.onrender.com/retell-llm`

## Booking webhook
- Point `BOOKING_WEBHOOK_URL` to Zapier/Make/your API to create calendar events + send confirmations.
