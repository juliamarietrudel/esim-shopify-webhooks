import express from "express";
import crypto from "crypto";

const app = express();

/**
 * ✅ IMPORTANT:
 * We MUST capture the raw request bytes BEFORE JSON parsing changes anything.
 * Shopify computes HMAC from the raw bytes, so we do the same.
 */
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf; // Buffer (raw bytes)
    },
  })
);

app.get("/", (_req, res) => res.send("Webhook server running :)"));

function verifyShopifyWebhook(req) {
  const hmacHeader = req.get("X-Shopify-Hmac-Sha256") || "";
  const secret = process.env.WEBHOOK_API_KEY; // <-- MUST be Shopify "API secret key"

  if (!secret) {
    console.error("❌ Missing WEBHOOK_API_KEY env var on server");
    return false;
  }
  if (!hmacHeader) {
    console.error("❌ Missing X-Shopify-Hmac-Sha256 header");
    return false;
  }
  if (!req.rawBody) {
    console.error("❌ Missing req.rawBody (raw bytes not captured)");
    return false;
  }

  const computed = crypto
    .createHmac("sha256", secret)
    .update(req.rawBody)
    .digest("base64");

  // Timing-safe compare
  try {
    return crypto.timingSafeEqual(
      Buffer.from(computed, "utf8"),
      Buffer.from(hmacHeader, "utf8")
    );
  } catch (e) {
    console.error("❌ timingSafeEqual error:", e.message);
    return false;
  }
}

app.post("/webhooks/order-paid", (req, res) => {
  // Always respond quickly. Shopify retries on timeouts.
  const topic = req.get("X-Shopify-Topic");
  const shop = req.get("X-Shopify-Shop-Domain");
  const receivedHmac = req.get("X-Shopify-Hmac-Sha256");

  const ok = verifyShopifyWebhook(req);

  console.log("---- WEBHOOK DEBUG START ----");
  console.log("Topic:", topic);
  console.log("Shop:", shop);
  console.log("Content-Type:", req.get("content-type"));
  console.log("Raw body length:", req.rawBody?.length);
  console.log("Received HMAC:", receivedHmac);
  console.log("HMAC MATCH:", ok);
  console.log("---- WEBHOOK DEBUG END ----");

  if (!ok) return res.status(401).send("Invalid signature");

  // ✅ At this point signature is verified: safe to use req.body
  console.log("✅ Verified payload (example keys):", Object.keys(req.body || {}));

  // For now just log the order id + email if present
  const orderId = req.body?.id;
  const email = req.body?.email || req.body?.contact_email;
  console.log("Order ID:", orderId, "Email:", email);

  return res.status(200).send("OK");
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));