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

async function saveMayaCustomerIdToShopifyCustomer(shopifyCustomerId, mayaCustomerId) {
  const shop = process.env.SHOPIFY_SHOP_DOMAIN;
  const token = process.env.API_ACCESS_TOKEN;
  const version = process.env.SHOPIFY_API_VERSION || "2025-01";

  if (!shop) throw new Error("Missing SHOPIFY_SHOP_DOMAIN env var");
  if (!token) throw new Error("Missing API_ACCESS_TOKEN env var");

  const gid = `gid://shopify/Customer/${shopifyCustomerId}`;

  const mutation = `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id key value }
        userErrors { field message }
      }
    }
  `;

  const variables = {
    metafields: [
      {
        ownerId: gid,
        namespace: "custom",
        key: "maya_customer_id",
        type: "single_line_text_field",
        value: String(mayaCustomerId),
      },
    ],
  };

  const resp = await fetch(`https://${shop}/admin/api/${version}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query: mutation, variables }),
  });

  const json = await resp.json().catch(() => ({}));

  const userErrors = json?.data?.metafieldsSet?.userErrors || [];
  if (!resp.ok || json.errors || userErrors.length) {
    console.error("❌ Shopify metafield write error:", {
      status: resp.status,
      errors: json.errors,
      userErrors,
      response: json,
    });
    throw new Error(userErrors[0]?.message || "Failed to write Shopify customer metafield");
  }

  return true;
}

async function getMayaCustomerIdFromShopifyCustomer(shopifyCustomerId) {
  const shop = process.env.SHOPIFY_SHOP_DOMAIN;
  const token = process.env.API_ACCESS_TOKEN;
  const version = process.env.SHOPIFY_API_VERSION || "2025-01";

  if (!shop) throw new Error("Missing SHOPIFY_SHOP_DOMAIN env var");
  if (!token) throw new Error("Missing API_ACCESS_TOKEN env var");

  const gid = `gid://shopify/Customer/${shopifyCustomerId}`;

  const query = `
    query ($id: ID!) {
      customer(id: $id) {
        id
        metafield(namespace: "custom", key: "maya_customer_id") {
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
    console.error("❌ Shopify customer metafield read error:", json.errors || json);
    throw new Error(`Shopify GraphQL failed (${resp.status})`);
  }

  return json?.data?.customer?.metafield?.value || null; // string or null
}

// -----------------------------
// Maya: Create customer
// POST https://api.maya.net/connectivity/v1/customer/
// -----------------------------
async function createMayaCustomer({ email, firstName, lastName, countryIso2, tag = "" }) {
  const baseUrl = process.env.MAYA_BASE_URL || "https://api.maya.net";

  const body = {
    email,
    first_name: firstName || "",
    last_name: lastName || "",
    country: countryIso2 || "US",
  };

  if (tag) body.tag = tag;

  const resp = await fetch(`${baseUrl}/connectivity/v1/customer/`, {
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
    console.error("❌ Maya create customer failed:", resp.status, data);
    throw new Error(`Maya create customer failed (${resp.status})`);
  }

  // Depending on the API, the created customer may be in data.customer or similar.
  // We'll try both safe paths:
  const customerId = data?.customer?.id || data?.customer?.uid || data?.id || null;

  if (!customerId) {
    console.error("❌ Could not find customer id in Maya response:", data);
    throw new Error("Maya customer created but no customer id returned");
  }

  return { raw: data, customerId };
}

// -----------------------------
// Maya: Create eSIM + data plan attached to customer
// POST https://api.maya.net/connectivity/v1/esim
// -----------------------------
async function createMayaEsim({ planTypeId, customerId, tag = "" }) {
  const baseUrl = process.env.MAYA_BASE_URL || "https://api.maya.net";

  const body = {
    plan_type_id: planTypeId,
    customer_id: customerId,
  };

  if (tag) body.tag = tag;

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

// -----------------------------
// Helpers: get buyer info from order
// -----------------------------
function pickBuyerFromOrder(order) {
  const email = order?.email || order?.contact_email || "";

  const firstName =
    order?.customer?.first_name ||
    order?.billing_address?.first_name ||
    order?.shipping_address?.first_name ||
    "";

  const lastName =
    order?.customer?.last_name ||
    order?.billing_address?.last_name ||
    order?.shipping_address?.last_name ||
    "";

  // Shopify gives country_code as ISO2 (CA/US/etc.) in addresses
  const countryIso2 =
    order?.billing_address?.country_code ||
    order?.shipping_address?.country_code ||
    "US";

  return { email, firstName, lastName, countryIso2 };
}

// -----------------------------
// Webhook: orders/paid
// -----------------------------
app.post("/webhooks/order-paid", async (req, res) => {
  const ok = verifyShopifyWebhook(req);

  console.log("---- WEBHOOK DEBUG START ----");
  console.log("Topic:", req.get("X-Shopify-Topic"));
  console.log("Shop:", req.get("X-Shopify-Shop-Domain"));
  console.log("Content-Type:", req.get("content-type"));
  console.log("Raw body length:", req.rawBody?.length);
  console.log("HMAC MATCH:", ok);
  console.log("---- WEBHOOK DEBUG END ----");

  if (!ok) return res.status(401).send("Invalid signature");

  const order = req.body || {};
  const orderId = order?.id;
  const { email, firstName, lastName, countryIso2 } = pickBuyerFromOrder(order);

  console.log("Order ID:", orderId);
  console.log("Buyer:", { email, firstName, lastName, countryIso2 });
  console.log("order.customer_id:", order?.customer_id);
  console.log("order.customer?.id:", order?.customer?.id);
  console.log("order.customer:", order?.customer);

  // TEMP idempotency: avoid double provisioning if Shopify retries
  if (orderId && processedOrders.has(orderId)) {
    console.log("🔁 Duplicate webhook ignored for order:", orderId);
    return res.status(200).send("OK");
  }
  if (orderId) processedOrders.add(orderId);

  // 1) Get or create Maya customer id (reuse Shopify metafield if present)
  let mayaCustomerId = null;

  const shopifyCustomerId = order?.customer?.id || null;
  console.log("Shopify customer id on order:", shopifyCustomerId);

  if (shopifyCustomerId) {
  try {
      const existing = await getMayaCustomerIdFromShopifyCustomer(shopifyCustomerId);
      const existingTrimmed = (existing || "").trim();

      if (existingTrimmed) {
        mayaCustomerId = existingTrimmed;
        console.log("✅ Reusing Maya customer id from Shopify metafield:", mayaCustomerId);
      } else {
        console.log("ℹ️ Shopify metafield maya_customer_id is empty (will create Maya customer).");
      }
    } catch (e) {
      console.error("❌ Could not read Shopify customer metafield:", e.message);
    }
  }

  // If not found, create Maya customer + save it to Shopify metafield
  if (!mayaCustomerId) {
    try {
      const created = await createMayaCustomer({
        email,
        firstName,
        lastName,
        countryIso2,
        tag: String(orderId || ""),
      });
      mayaCustomerId = created.customerId;
      console.log("✅ Maya customer created:", mayaCustomerId);

      if (shopifyCustomerId) {
        try {
          await saveMayaCustomerIdToShopifyCustomer(shopifyCustomerId, mayaCustomerId);
          console.log("✅ Saved Maya customer id to Shopify customer metafield:", {
            shopifyCustomerId,
            mayaCustomerId,
          });
        } catch (e) {
          console.error("❌ Failed saving Maya customer id to Shopify:", e.message);
        }
      } else {
        console.warn("⚠️ No Shopify customer on order, can't persist Maya ID (guest checkout).");
      }
    } catch (e) {
      console.error("❌ Maya customer creation failed:", e.message);
      return res.status(200).send("OK");
    }
  }

  // 2) Create eSIM(s) attached to that customer
  const items = order?.line_items || [];
  console.log("🧾 LINE ITEMS:", items.length);

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const variantId = String(item.variant_id);
    const qty = Number(item.quantity || 1);

    let mayaPlanId = null;
    try {
      mayaPlanId = await getMayaPlanIdForVariant(variantId);
    } catch (e) {
      console.error("❌ Failed to fetch metafield for variant:", variantId, e.message);
    }

    console.log(`Item #${i + 1}:`, {
      title: item.title,
      variant_title: item.variant_title,
      variant_id: variantId,
      quantity: qty,
      maya_plan_id: mayaPlanId,
    });

    if (!mayaPlanId) {
      console.error("❌ Missing metafield custom.maya_plan_id for variant:", variantId);
      continue;
    }

    for (let q = 0; q < qty; q++) {
      try {
        const mayaResp = await createMayaEsim({
          planTypeId: mayaPlanId,
          customerId: mayaCustomerId,
          tag: String(orderId || ""), // traceability
        });

        console.log("✅ Maya eSIM created (attached to customer):", {
          maya_customer_id: mayaCustomerId,
          maya_esim_uid: mayaResp?.esim?.uid,
          iccid: mayaResp?.esim?.iccid,
          activation_code: mayaResp?.esim?.activation_code,
          manual_code: mayaResp?.esim?.manual_code,
          smdp_address: mayaResp?.esim?.smdp_address,
          apn: mayaResp?.esim?.apn,
        });
      } catch (e) {
        console.error("❌ Maya provisioning error:", e.message);
      }
    }
  }

  return res.status(200).send("OK");
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));