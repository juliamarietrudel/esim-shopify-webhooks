import express from "express";
import crypto from "crypto";

const app = express();

// Normal routes can use JSON
app.get("/", (req, res) => res.send("Webhook server running :)"));

// IMPORTANT: webhook route must use RAW body
app.post(
  "/webhooks/order-paid",
  express.raw({ type: "application/json" }),
  (req, res) => {
    try {
      const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
      const secret = process.env.SHOPIFY_API_SECRET; // <-- set this on Render

      if (!secret) {
        console.error("❌ Missing SHOPIFY_API_SECRET env var");
        return res.status(500).send("Server not configured");
      }

      const rawBody = req.body; // Buffer
      const computed = crypto
        .createHmac("sha256", secret)
        .update(rawBody, "utf8")
        .digest("base64");

      const safeCompare =
        Buffer.from(computed, "utf8").length === Buffer.from(hmacHeader || "", "utf8").length &&
        crypto.timingSafeEqual(Buffer.from(computed, "utf8"), Buffer.from(hmacHeader || "", "utf8"));

      if (!safeCompare) {
        console.error("❌ Invalid webhook signature");
        return res.status(401).send("Invalid webhook signature");
      }

      // Signature OK ✅
      const payload = JSON.parse(rawBody.toString("utf8"));
      console.log("🔥 Shopify webhook received (verified)");
      console.log(JSON.stringify(payload, null, 2));

      return res.status(200).send("OK");
    } catch (err) {
      console.error("❌ Webhook handler error:", err);
      return res.status(500).send("Webhook error");
    }
  }
);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));