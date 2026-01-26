import crypto from "crypto";
import express from "express";

const app = express();

// Shopify requires raw body for signature verification
app.use("/webhooks", express.raw({ type: "application/json" }));

function verifyShopifyWebhook(req) {
  const hmac = req.get("X-Shopify-Hmac-Sha256");
  const body = req.body;

  const hash = crypto
    .createHmac("sha256", process.env.SHOPIFY_API_SECRET)
    .update(body, "utf8")
    .digest("base64");

  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(hmac));
}

app.post("/webhooks/order-paid", (req, res) => {
  if (!verifyShopifyWebhook(req)) {
    console.log("❌ Invalid webhook signature");
    return res.status(401).send("Invalid signature");
  }

  console.log("✅ Webhook verified");
  console.log(JSON.parse(req.body.toString("utf8")));

  res.sendStatus(200);
});

app.get("/", (req, res) => res.send("Webhook server running :)"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));