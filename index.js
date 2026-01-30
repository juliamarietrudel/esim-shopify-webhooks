import express from "express";
import crypto from "crypto";

const app = express();

// TEMP idempotency for testing (resets on restart/deploy)
const processedOrders = new Set();

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf; // Buffer (raw bytes)
    },
  })
);

app.get("/", (_req, res) => res.send("Webhook server running :)"));

// -----------------------------
// Shopify signature verification
// -----------------------------
function verifyShopifyWebhook(req) {
  const hmacHeader = req.get("X-Shopify-Hmac-Sha256") || "";
  const secret = (process.env.WEBHOOK_API_KEY || "").trim();
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
  
  console.log("Computed HMAC:", computed);
  console.log("Received HMAC:", hmacHeader);

  try {
    // Compare base64-decoded bytes (best practice)
    return crypto.timingSafeEqual(
      Buffer.from(computed, "base64"),
      Buffer.from(hmacHeader, "base64")
    );
  } catch (e) {
    console.error("❌ timingSafeEqual error:", e.message);
    return false;
  }
}

// --------------------------------------
// Shopify Admin API: read variant metafield
// --------------------------------------
async function getMayaPlanIdForVariant(variantId) {
  const shop = process.env.SHOPIFY_SHOP_DOMAIN; // test-esim-app.myshopify.com
  const token = process.env.API_ACCESS_TOKEN;   // Admin API access token
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

  return json?.data?.productVariant?.metafield?.value || null; // e.g. 5VKDTK3BFFZE
}

// -----------------------------
// Maya: Basic Auth header
// -----------------------------
function mayaAuthHeader() {
  const auth = process.env.MAYA_AUTH; // base64(username:password)
  if (!auth) throw new Error("Missing MAYA_AUTH env var");
  return `Basic ${auth}`;
}

// -----------------------------
// Maya: Create eSIM + data plan
// POST https://api.maya.net/connectivity/v1/esim
// -----------------------------
async function createMayaEsim({ planTypeId, tag = "", customerId = "" }) {
  const baseUrl = process.env.MAYA_BASE_URL || "https://api.maya.net";

  const body = { plan_type_id: planTypeId };
  if (tag) body.tag = tag;
  if (customerId) body.customer_id = customerId;

  const resp = await fetch(`${baseUrl}/connectivity/v1/esim`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: mayaAuthHeader(),
    },
    body: JSON.stringify(body),
  });

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    console.error("❌ Maya create eSIM failed:", resp.status, data);
    throw new Error(`Maya create eSIM failed (${resp.status})`);
  }

  return data;
}

app.get("/maya-test", async (_req, res) => {
  try {
    const resp = await fetch("https://api.maya.net/connectivity/v1/esim/8910300000034360569", {
      headers: { Accept: "application/json", Authorization: mayaAuthHeader() },
    });
    const data = await resp.json().catch(() => ({}));
    return res.status(resp.status).json({ ok: resp.ok, status: resp.status, data });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// -----------------------------
// Webhook: orders/paid
// -----------------------------
app.post("/webhooks/order-paid", async (req, res) => {
  const topic = req.get("X-Shopify-Topic");
  const shop = req.get("X-Shopify-Shop-Domain");
  const receivedHmac = req.get("X-Shopify-Hmac-Sha256");

  const ok = verifyShopifyWebhook(req);
  console.log("Using webhook secret length:", (process.env.WEBHOOK_API_KEY || "").length);


  console.log("---- WEBHOOK DEBUG START ----");
  console.log("Topic:", topic);
  console.log("Shop:", shop);
  console.log("Content-Type:", req.get("content-type"));
  console.log("Raw body length:", req.rawBody?.length);
  console.log("Received HMAC:", receivedHmac);
  console.log("HMAC MATCH:", ok);
  console.log("---- WEBHOOK DEBUG END ----");

  if (!ok) return res.status(401).send("Invalid signature");

  const orderId = req.body?.id;
  const email = req.body?.email || req.body?.contact_email;

  console.log("Order ID:", orderId, "Email:", email);

  // TEMP idempotency: avoid double provisioning if Shopify retries
  if (orderId && processedOrders.has(orderId)) {
    console.log("🔁 Duplicate webhook ignored for order:", orderId);
    return res.status(200).send("OK");
  }
  if (orderId) processedOrders.add(orderId);

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
      continue; // can't provision without plan id
    }

    const qty = Number(item.quantity || 1);

    // Provision one eSIM per quantity
    for (let q = 0; q < qty; q++) {
      try {
        const mayaResp = await createMayaEsim({
          planTypeId: mayaPlanId,
          tag: String(orderId || ""), // optional traceability
        });

        console.log("✅ Maya eSIM created:", {
          maya_esim_uid: mayaResp?.esim?.uid,
          iccid: mayaResp?.esim?.iccid,
          activation_code: mayaResp?.esim?.activation_code, // often starts with LPA:1$
          manual_code: mayaResp?.esim?.manual_code,
          smdp_address: mayaResp?.esim?.smdp_address,
          apn: mayaResp?.esim?.apn,
        });

        // TODO next: email activation_code / QR to `email`
      } catch (e) {
        console.error("❌ Maya provisioning error:", e.message);
      }
    }
  }

  return res.status(200).send("OK");
});


const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));