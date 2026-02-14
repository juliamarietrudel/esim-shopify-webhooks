// replay-webhook.js
import fs from "fs";
import crypto from "crypto";
import "dotenv/config";

const WEBHOOK_API_KEY = (process.env.WEBHOOK_API_KEY || "").trim();
if (!WEBHOOK_API_KEY) {
  throw new Error("Missing WEBHOOK_API_KEY in env (same secret used to verify Shopify HMAC)");
}

const raw = fs.readFileSync("last-webhook.json"); // raw bytes (Buffer)
const hmac = crypto.createHmac("sha256", WEBHOOK_API_KEY).update(raw).digest("base64");

const url = "http://localhost:3000/webhooks/order-paid";

async function sendOnce(label) {
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Topic": "orders/paid",
      "X-Shopify-Shop-Domain": "test-esim-app.myshopify.com",
      "X-Shopify-Hmac-Sha256": hmac,
    },
    body: raw, // IMPORTANT: send the exact raw bytes
  });

  const text = await resp.text().catch(() => "");
  console.log(`\n${label} -> status ${resp.status}`);
  if (text) console.log(text.slice(0, 300));
}

await sendOnce("Replay #1");
await sendOnce("Replay #2");