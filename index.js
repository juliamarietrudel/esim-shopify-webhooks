import express from "express";
import crypto from "crypto";
import QRCode from "qrcode";
import { Resend } from "resend";

const app = express();

// -----------------------------
// Email (Resend)
// -----------------------------
const resendApiKey = (process.env.RESEND_API_KEY || "").trim();
const emailFrom = (process.env.EMAIL_FROM || "").trim();
const emailEnabled = Boolean(resendApiKey && emailFrom);
const resend = emailEnabled ? new Resend(resendApiKey) : null;

if (!emailEnabled) {
  console.warn(
    "⚠️ Email not configured. Set RESEND_API_KEY and EMAIL_FROM to send eSIM emails."
  );
}

async function generateQrPngBase64(payload) {
  if (!payload) return null;
  const pngBuffer = await QRCode.toBuffer(payload, {
    type: "png",
    errorCorrectionLevel: "M",
    margin: 1,
    scale: 6,
  });
  return pngBuffer.toString("base64");
}

function formatEsimEmailHtml({ firstName, activationCode, manualCode, smdpAddress, apn }) {
  const safeName = (firstName || "").trim() || "there";
  const safeApn = apn ? `<li><b>APN</b>: ${apn}</li>` : "";

  return `
  <div style="font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Arial; line-height: 1.5;">
    <h2>Your eSIM is ready ✅</h2>
    <p>Hi ${safeName},</p>
    <p>To install your eSIM, scan the QR code attached to this email on your eSIM-compatible device.</p>

    <h3>Activation details (backup)</h3>
    <ul>
      <li><b>Activation code</b>: <code>${activationCode || ""}</code></li>
      <li><b>Manual code</b>: <code>${manualCode || ""}</code></li>
      <li><b>SM-DP+ address</b>: <code>${smdpAddress || ""}</code></li>
      ${safeApn}
    </ul>

    <p style="margin-top: 16px;">If you have any issues, reply to this email and we’ll help you.</p>
  </div>
  `;
}

async function sendEsimEmail({ to, firstName, orderId, activationCode, manualCode, smdpAddress, apn }) {
  if (!emailEnabled) {
    console.log("ℹ️ Skipping email send (email not configured).");
    return false;
  }
  if (!to) {
    console.warn("⚠️ No customer email found on order; cannot send eSIM email.");
    return false;
  }
  if (!activationCode) {
    console.warn("⚠️ Missing activation_code; cannot generate QR email.");
    return false;
  }

  const qrBase64 = await generateQrPngBase64(activationCode);
  if (!qrBase64) {
    console.warn("⚠️ Failed to generate QR code.");
    return false;
  }

  const subject = orderId
    ? `Your eSIM QR code (Order #${orderId})`
    : "Your eSIM QR code";

  const html = formatEsimEmailHtml({
    firstName,
    activationCode,
    manualCode,
    smdpAddress,
    apn,
  });

  const result = await resend.emails.send({
    from: emailFrom,
    to,
    subject,
    html,
    // Attach the QR as a PNG so it works across more email clients
    attachments: [
      {
        filename: "esim-qr.png",
        content: qrBase64,
      },
    ],
  });

  if (result?.error) {
    console.error("❌ Resend error:", result.error);
    return false;
  }

  console.log("✅ eSIM email sent via Resend:", { to, id: result?.data?.id });
  return true;
}

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
// HTTP helpers (better errors + timeout)
// -----------------------------
async function safeFetch(url, options = {}) {
  const ctrl = new AbortController();
  const timeoutMs = Number(process.env.FETCH_TIMEOUT_MS || 15000);
  const timeout = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } catch (e) {
    // Node fetch often throws "fetch failed"; log the underlying cause if present
    console.error("❌ FETCH ERROR:", e?.message, "cause:", e?.cause);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function shopifyGraphqlUrl() {
  const shopRaw = process.env.SHOPIFY_SHOP_DOMAIN;
  const versionRaw = process.env.SHOPIFY_API_VERSION || "2025-01";

  const shop = (shopRaw || "").trim();
  const version = (versionRaw || "").trim();

  if (!shop) throw new Error("Missing SHOPIFY_SHOP_DOMAIN env var");
  if (!version) throw new Error("Missing SHOPIFY_API_VERSION env var");

  return `https://${shop}/admin/api/${version}/graphql.json`;
}

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
  const token = process.env.API_ACCESS_TOKEN; // Admin API access token
  const url = shopifyGraphqlUrl();

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

  const resp = await safeFetch(url, {
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
  const token = process.env.API_ACCESS_TOKEN;
  const url = shopifyGraphqlUrl();

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

  const resp = await safeFetch(url, {
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
  const token = process.env.API_ACCESS_TOKEN;
  const url = shopifyGraphqlUrl();

  console.log("🔎 GraphQL URL:", url);

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

  const resp = await safeFetch(url, {
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

  const resp = await safeFetch(`${baseUrl}/connectivity/v1/customer/`, {
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

  const resp = await safeFetch(`${baseUrl}/connectivity/v1/esim`, {
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

        // 3) Email QR code to customer (Resend)
        try {
          await sendEsimEmail({
            to: email,
            firstName,
            orderId,
            activationCode: mayaResp?.esim?.activation_code,
            manualCode: mayaResp?.esim?.manual_code,
            smdpAddress: mayaResp?.esim?.smdp_address,
            apn: mayaResp?.esim?.apn,
          });
        } catch (e) {
          console.error("❌ Failed to send eSIM email:", e?.message || e);
        }
      } catch (e) {
        console.error("❌ Maya provisioning error:", e.message);
      }
    }
  }

  return res.status(200).send("OK");
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));