import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import morgan from 'morgan';
import axios from 'axios';

const app = express();
app.use(morgan('tiny'));
app.use(bodyParser.json());

// --- CORS + preflight for dashboard tests (IMPORTANT) ---
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Optional: GET on the same path for quick checks in a browser
app.get('/retell-llm', (_, res) => res.json({ ok: true, hint: 'POST here with messages[]' }));

// In-memory session store (swap for Redis in prod)
const sessions = new Map();

function getSession(conversationId) {
  if (!sessions.has(conversationId)) {
    sessions.set(conversationId, {
      stage: 'intro',           // intro -> compare -> offer -> pick_time -> confirm -> done
      lead: { name: null, phone: null, listingUrl: null },
      offerA: process.env.OFFER_SLOT_A || 'Tomorrow 2:00 PM',
      offerB: process.env.OFFER_SLOT_B || 'Thursday 10:00 AM',
      chosenSlot: null,
      sentAnalysis: true
    });
  }
  return sessions.get(conversationId);
}

app.post('/retell-llm', async (req, res) => {
  const {
    conversation_id,
    messages = [],
    callee = {}
  } = req.body || {};

  const session = getSession(conversation_id || 'unknown');
  if (callee?.name && !session.lead.name) session.lead.name = callee.name;
  if (callee?.phone && !session.lead.phone) session.lead.phone = callee.phone;

  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content?.toLowerCase() || '';

  let reply = '';
  let endCall = false;

  switch (session.stage) {
    case 'intro': {
      reply = `Hi ${session.lead.name ?? ''} this is the Venturebnb concierge assistant. I’m an automated assistant following up about the profit analysis you requested for your Airbnb. Did you get the text we sent with your numbers?`;
      session.stage = 'intro_wait';
      break;
    }
    case 'intro_wait': {
      if (/(^|\b)(yes|yeah|yep|i did|got it)(\b|$)/.test(lastUserMsg)) {
        reply = `Great! How did the numbers compare to what you’re currently seeing?`;
        session.stage = 'compare';
      } else if (/(^|\b)(no|not yet|didn’t|get|never)(\b|$)/.test(lastUserMsg)) {
        reply = `No problem—I’ll make sure we resend that. In the meantime, I can walk you through the highlights quickly.`;
        session.stage = 'compare';
      } else {
        reply = `Just to confirm—did you receive the profit analysis text?`;
      }
      break;
    }
    case 'compare': {
      reply = `That makes sense. Most homeowners I speak with want a quick 15-minute call with our profit strategist to see how we typically boost revenue and reduce costs. Would you like me to set that up?`;
      session.stage = 'offer';
      break;
    }
    case 'offer': {
      if (/(^|\b)(yes|sure|ok|okay|sounds good|let’s do it|lets do it|book)(\b|$)/.test(lastUserMsg)) {
        reply = `Awesome. I have ${session.offerA} or ${session.offerB}. Which works better for you?`;
        session.stage = 'pick_time';
      } else if (/(^|\b)(no|not interested|pass|maybe later)(\b|$)/.test(lastUserMsg)) {
        reply = `Got it—thanks for your time today. If it’s helpful, I can text you the analysis summary again. Have a great day!`;
        session.stage = 'done';
        endCall = true;
      } else {
        reply = `No worries—would mornings or afternoons generally work better for you?`;
      }
      break;
    }
    case 'pick_time': {
      if (lastUserMsg.includes('tomorrow') || lastUserMsg.includes('2')) {
        session.chosenSlot = session.offerA;
      } else if (lastUserMsg.includes('thursday') || lastUserMsg.includes('10')) {
        session.chosenSlot = session.offerB;
      } else if (/(^|\b)(morning|afternoon|evening)(\b|$)/.test(lastUserMsg)) {
        session.chosenSlot = /morning/.test(lastUserMsg) ? session.offerB : session.offerA;
      }

      if (!session.chosenSlot) {
        reply = `I can do ${session.offerA} or ${session.offerB}. Which would you prefer?`;
        break;
      }

      try {
        if (process.env.BOOKING_WEBHOOK_URL) {
          await axios.post(process.env.BOOKING_WEBHOOK_URL, {
            name: session.lead.name,
            phone: session.lead.phone,
            slot: session.chosenSlot,
            conversation_id
          }, { timeout: 8000 });
        }
      } catch (e) {
        // ignore for now; you can add logging
      }

      reply = `Perfect—I’ve booked you for ${session.chosenSlot}. You’ll get a confirmation text and calendar invite shortly. Anything else I can help with?`;
      session.stage = 'confirm';
      break;
    }
    case 'confirm': {
      reply = `Great—thanks again, and talk soon!`;
      session.stage = 'done';
      endCall = true;
      break;
    }
    default: {
      reply = `Thanks for your time today. Have a great day!`;
      endCall = true;
    }
  }

  // return multiple common keys (covers different parsers)
  res.json({
    response: reply,
    reply: reply,
    content: reply,
    text: reply,
    end_call: endCall,
    hangup: endCall,
    hang_up: endCall
  });
});

app.get('/', (_, res) => res.send('Venturebnb Retell LLM up'));

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Listening on :${port}`));
