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

async function getMayaPlanIdForVariant(variantId) {
  const shop = process.env.SHOPIFY_SHOP_DOMAIN;      // test-esim-app.myshopify.com
  const token = process.env.API_ACCESS_TOKEN;        // Admin API access token
  const version = process.env.SHOPIFY_API_VERSION || "2025-01";

  if (!shop) throw new Error("Missing SHOPIFY_SHOP_DOMAIN env var");
  if (!token) throw new Error("Missing API_ACCESS_TOKEN env var");

  const gid = `gid://shopify/ProductVariant/${variantId}`;

  const query = `
    query ($id: ID!) {
      productVariant(id: $id) {
        id
        title
        metafield(namespace: "custom", key: "maya_plan_id") {
          value
        }
      }
    }
  `;

  const resp = await fetch(`https://${shop}/admin/api/${version}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables: { id: gid } }),
  });

  const json = await resp.json().catch(() => ({}));

  if (!resp.ok || json.errors) {
    console.error("❌ Shopify GraphQL error:", json.errors || json);
    throw new Error(`Shopify GraphQL failed (${resp.status})`);
  }

  return json?.data?.productVariant?.metafield?.value || null;
}

app.post("/webhooks/order-paid", async (req, res) => {
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
  // ✅ LOG LINE ITEMS + FETCH MAYA PLAN ID (metafield)
  const items = req.body?.line_items || [];
  console.log("🧾 LINE ITEMS:");

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const variantId = String(item.variant_id);

    let mayaPlanId = null;
    try {
      mayaPlanId = await getMayaPlanIdForVariant(variantId);
    } catch (e) {
      console.error("❌ Failed to fetch metafield for variant:", variantId, e.message);
    }

    console.log(`Item #${i + 1}:`, {
      title: item.title,
      variant_title: item.variant_title,
      product_id: item.product_id,
      variant_id: variantId,
      quantity: item.quantity,
      sku: item.sku,
      maya_plan_id: mayaPlanId,
    });

    if (!mayaPlanId) {
      console.error("❌ Missing metafield custom.maya_plan_id for variant:", variantId);
    }
  }
  // Always respond quickly. We'll do Maya provisioning next.
  return res.status(200).send("OK");
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));