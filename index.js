import express from "express";
import crypto from "crypto";

const app = express();

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf; // Buffer (raw bytes)
    },
  })
);

app.get("/", (_req, res) => res.send("Webhook server running :)"));

// Shopify signature verification
function verifyShopifyWebhook(req) {
  const hmacHeader = req.get("X-Shopify-Hmac-Sha256") || "";
  const secret = process.env.WEBHOOK_API_KEY; // Shopify app API secret key

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

  // Respond fast if signature fails
  if (!ok) return res.status(401).send("Invalid signature");

  const orderId = req.body?.id;
  const email = req.body?.email || req.body?.contact_email;

  console.log("Order ID:", orderId, "Email:", email);

  // ✅ LOG LINE ITEMS (this is what you were trying to do)
  const items = req.body?.line_items || [];
  console.log("🧾 LINE ITEMS:");
  items.forEach((item, i) => {
    console.log(`Item #${i + 1}:`, {
      title: item.title,
      variant_title: item.variant_title,
      product_id: item.product_id,
      variant_id: item.variant_id,
      quantity: item.quantity,
      sku: item.sku,
    });
  });

  // Always respond quickly. We'll do Maya provisioning next.
  return res.status(200).send("OK");
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));