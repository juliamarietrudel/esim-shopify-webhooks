import express from "express";
import crypto from "crypto";

const app = express();

// IMPORTANT: raw parser must run before anything else for /webhooks
app.use(
  "/webhooks",
  express.raw({
    type: (req) => true, // accept ANY content-type so we always get raw bytes
  })
);

app.get("/", (req, res) => res.send("Webhook server running :)"));

// Helper to compute the Shopify HMAC
function computeShopifyHmac(rawBodyBuffer) {
  return crypto
    .createHmac("sha256", process.env.SHOPIFY_API_SECRET)
    .update(rawBodyBuffer)
    .digest("base64");
}

function safeTimingEqual(a, b) {
  const aBuf = Buffer.from(a || "", "utf8");
  const bBuf = Buffer.from(b || "", "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

// TEMP DEBUG endpoint: logs everything and returns 200
app.post("/webhooks/order-paid", (req, res) => {
  const receivedHmac = req.get("X-Shopify-Hmac-Sha256");
  const rawBody = req.body; // Buffer

  const computedHmac = computeShopifyHmac(rawBody);

  console.log("---- WEBHOOK DEBUG START ----");
  console.log("Content-Type:", req.get("content-type"));
  console.log("Topic:", req.get("X-Shopify-Topic"));
  console.log("Shop:", req.get("X-Shopify-Shop-Domain"));
  console.log("Received HMAC:", receivedHmac);
  console.log("Computed HMAC:", computedHmac);
  console.log("Raw body length:", rawBody?.length);

  const ok = safeTimingEqual(computedHmac, receivedHmac);
  console.log("HMAC MATCH:", ok);

  // If you want to see the payload (after we confirm match)
  // console.log("Payload:", rawBody.toString("utf8"));

  console.log("---- WEBHOOK DEBUG END ----");

  if (!ok) return res.status(401).send("Invalid signature");
  return res.status(200).send("OK");
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));