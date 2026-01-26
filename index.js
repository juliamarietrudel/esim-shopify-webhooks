import "dotenv/config";
import express from "express";
import crypto from "crypto";

const app = express();

// ✅ health check
app.get("/", (req, res) => res.send("Webhook server running :)"));
app.get("/ping", (req, res) => res.status(200).send("pong"));

// ✅ Shopify needs RAW body for HMAC verification
app.use(
  "/webhooks",
  express.raw({ type: "application/json" })
);

function verifyShopifyHmac(req) {
  const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
  const secret = process.env.SHOPIFY_API_SECRET;

  if (!secret) throw new Error("Missing SHOPIFY_WEBHOOK_SECRET in env");

  const generated = crypto
    .createHmac("sha256", secret)
    .update(req.body, "utf8")
    .digest("base64");

  // timing-safe compare
  const a = Buffer.from(generated, "utf8");
  const b = Buffer.from(hmacHeader || "", "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.post("/webhooks/order-paid", (req, res) => {
  try {
    if (!verifyShopifyHmac(req)) {
      console.log("❌ Invalid webhook signature");
      return res.status(401).send("Invalid signature");
    }

    console.log("✅ Shopify webhook verified");

    const payload = JSON.parse(req.body.toString("utf8"));
    console.log("🔥 orders/paid payload:");
    console.log(JSON.stringify(payload, null, 2));

    return res.status(200).send("OK");
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).send("Server error");
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));