import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import morgan from 'morgan';
import axios from 'axios';
import http from 'http';
import { WebSocketServer } from 'ws';

const app = express();
app.use(morgan('tiny'));
app.use(bodyParser.json());

// --- CORS + preflight for dashboard tests ---
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// --- Healthchecks ---
app.get('/', (_, res) => res.send('Venturebnb Retell LLM up'));
app.get('/retell-llm', (_, res) => res.json({ ok: true, hint: 'POST/WS here' }));

// --- In-memory session store (swap for Redis in prod) ---
const sessions = new Map();
function getSession(callId) {
  if (!sessions.has(callId)) {
    sessions.set(callId, {
      stage: 'intro',                // intro -> compare -> offer -> pick_time -> confirm -> done
      offerA: process.env.OFFER_SLOT_A || 'Tomorrow 2:00 PM',
      offerB: process.env.OFFER_SLOT_B || 'Thursday 10:00 AM',
      chosenSlot: null
    });
  }
  return sessions.get(callId);
}

function lastUserText(transcript = []) {
  // Accept several possible transcript shapes
  for (let i = transcript.length - 1; i >= 0; i--) {
    const u = transcript[i] || {};
    const who = (u.role || u.speaker || '').toLowerCase();
    const text = u.text || u.content || u.transcript || '';
    if (who.includes('user') || who.includes('caller')) return ('' + text).toLowerCase();
  }
  return '';
}

// --- Create HTTP server + WebSocket upgrade ---
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Accept BOTH `/retell-llm` and `/retell-llm/<call_id>` plus queries
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname || '';
  if (!pathname.startsWith('/retell-llm')) {
    socket.destroy();
    return;
  }
  const parts = pathname.split('/').filter(Boolean); // ["retell-llm", "<id>?"]
  const callId =
    parts[1] ||
    url.searchParams.get('call_id') ||
    url.searchParams.get('id') ||
    `call_${Date.now()}`;

  console.log('[WS] upgrade', { pathname, callId });

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.callId = callId;
    wss.emit('connection', ws, req);
  });
});

// --- Retell LLM WebSocket handling ---
wss.on('connection', (ws) => {
  const callId = ws.callId;
  const session = getSession(callId);
  console.log('[WS] connected', callId);

  // Send optional config packet back to Retell
  ws.send(JSON.stringify({
    response_type: 'config',
    config: { auto_reconnect: false, call_details: false }
  }));

  // Fallback greeting if Retell doesn't ask us to speak quickly
  let alreadySpoke = false;
  const greetIfSilent = setTimeout(() => {
    if (alreadySpoke) return;
    ws.send(JSON.stringify({
      response_type: 'response',
      content: `Hi, this is the Venturebnb concierge assistant. I’m an automated assistant following up about the profit analysis you requested for your Airbnb. Did you get the text we sent with your numbers?`,
      end_call: false
    }));
    alreadySpoke = true;
  }, 1500);

  ws.on('message', async (buf) => {
    let msg = null;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    // Helpful logs
    console.log('[WS] message', callId, msg.interaction_type || Object.keys(msg));

    // Retell will ask us to respond via these interaction types
    if (msg.interaction_type === 'response_required' || msg.interaction_type === 'reminder_required') {
      // We're about to speak because Retell asked us to.
      clearTimeout(greetIfSilent);
      alreadySpoke = true;

      const user = lastUserText(msg.transcript);
      let reply = '';
      let endCall = false;

      // If we haven't greeted (no user text yet), start with greeting
      if (!user && session.stage === 'intro') {
        reply = `Hi, this is the Venturebnb concierge assistant. I’m an automated assistant following up about the profit analysis you requested for your Airbnb. Did you get the text we sent with your numbers?`;
        session.stage = 'intro_wait';
      } else {
        switch (session.stage) {
          case 'intro':
          case 'intro_wait': {
            if (/\b(yes|yeah|yep|i did|got it)\b/.test(user)) {
              reply = `Great! How did the numbers compare to what you’re currently seeing?`;
              session.stage = 'compare';
            } else if (/\b(no|not yet|didn’t|get|never)\b/.test(user)) {
              reply = `No problem—I’ll make sure we resend that. In the meantime, I can walk you through the highlights quickly.`;
              session.stage = 'compare';
            } else {
              reply = `Just to confirm—did you receive the profit analysis text?`;
              session.stage = 'intro_wait';
            }
            break;
          }
          case 'compare': {
            reply = `That makes sense. Most homeowners I speak with want a quick 15-minute call with our profit strategist to see how we typically boost revenue and reduce costs. Would you like me to set that up?`;
            session.stage = 'offer';
            break;
          }
          case 'offer': {
            if (/\b(yes|sure|ok|okay|sounds good|let’s do it|lets do it|book)\b/.test(user)) {
              reply = `Awesome. I have ${session.offerA} or ${session.offerB}. Which works better for you?`;
              session.stage = 'pick_time';
            } else if (/\b(no|not interested|pass|maybe later)\b/.test(user)) {
              reply = `Got it—thanks for your time today. If it’s helpful, I can text you the analysis summary again. Have a great day!`;
              session.stage = 'done';
              endCall = true;
            } else {
              reply = `No worries—would mornings or afternoons generally work better for you?`;
            }
            break;
          }
          case 'pick_time': {
            if (user.includes('tomorrow') || user.includes('2')) {
              session.chosenSlot = session.offerA;
            } else if (user.includes('thursday') || user.includes('10')) {
              session.chosenSlot = session.offerB;
            } else if (/\b(morning|afternoon|evening)\b/.test(user)) {
              session.chosenSlot = /morning/.test(user) ? session.offerB : session.offerA;
            }

            if (!session.chosenSlot) {
              reply = `I can do ${session.offerA} or ${session.offerB}. Which would you prefer?`;
              break;
            }

            try {
              if (process.env.BOOKING_WEBHOOK_URL) {
                await axios.post(process.env.BOOKING_WEBHOOK_URL, {
                  call_id: callId,
                  slot: session.chosenSlot
                }, { timeout: 8000 });
              }
            } catch { /* ignore for now */ }

            reply = `Perfect—I’ve booked you for ${session.chosenSlot}. You’ll get a confirmation text and calendar invite shortly. Anything else I can help with?`;
            session.stage = 'confirm';
            break;
          }
          case 'confirm': {
            reply = `Great—thanks again, and talk soon!`;
            endCall = true;
            session.stage = 'done';
            break;
          }
          default: {
            reply = `Thanks for your time today. Have a great day!`;
            endCall = true;
          }
        }
      }

      // Respond with the same response_id Retell provided
      ws.send(JSON.stringify({
        response_type: 'response',
        response_id: msg.response_id,
        content: reply,
        end_call: endCall
      }));
    }
  });

  ws.on('close', () => console.log('[WS] closed', callId));
  ws.on('error', (e) => console.log('[WS] error', callId, e?.message));
});

// --- start server ---
const port = process.env.PORT || 8080;
server.listen(port, () => console.log(`Listening on :${port}`));

