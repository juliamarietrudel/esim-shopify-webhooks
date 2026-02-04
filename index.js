// index.js
import express from "express";
import crypto from "crypto";
import QRCode from "qrcode";
import { Resend } from "resend";

import { safeFetch } from "./utils/http.js"; // optional (can be removed if unused)

import {
  getVariantConfig,
  getOrderProcessedFlag,
  markOrderProcessed,
  getMayaCustomerIdFromShopifyCustomer,
  saveMayaCustomerIdToShopifyCustomer,
} from "./services/shopify.js";

import {
  createMayaCustomer,
  createMayaEsim,
  getMayaCustomerDetails,
  createMayaTopUp,
} from "./services/maya.js";

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

function formatEsimEmailHtml({
  firstName,
  activationCode,
  manualCode,
  smdpAddress,
  apn,
  planName,
  country,
  validityDays,
  dataQuotaMb,
  iccid,
}) {
  const safeName = (firstName || "").trim() || "there";
  const safeApn = apn ? `<li><b>APN</b>: ${apn}</li>` : "";

  return `
<div style="font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Arial; line-height: 1.5;">
  <h2>Your eSIM is ready ✅</h2>

  <p>Hi ${safeName},</p>

  <p>
    Your eSIM for <b>${planName || "your selected plan"}</b> is now ready.
    To install it, scan the QR code attached to this email on your eSIM-compatible device.
  </p>

  <h3>Plan details</h3>
  <ul>
    ${planName ? `<li><b>Plan</b>: ${planName}</li>` : ""}
    ${country ? `<li><b>Destination</b>: ${country}</li>` : ""}
    ${validityDays ? `<li><b>Validity</b>: ${validityDays} days</li>` : ""}
    ${dataQuotaMb ? `<li><b>Data</b>: ${dataQuotaMb} MB</li>` : ""}
    ${iccid ? `<li><b>ICCID</b>: <code>${iccid}</code></li>` : ""}
  </ul>

  <h3>Activation details (backup)</h3>
  <ul>
    <li><b>Activation code</b>: <code>${activationCode || ""}</code></li>
    <li><b>Manual code</b>: <code>${manualCode || ""}</code></li>
    <li><b>SM-DP+ address</b>: <code>${smdpAddress || ""}</code></li>
    ${safeApn}
  </ul>

  <p style="margin-top: 16px;">
    If you have any issues, reply to this email and we’ll help you.
  </p>
</div>
  `;
}

async function sendEsimEmail({
  to,
  firstName,
  orderId,
  activationCode,
  manualCode,
  smdpAddress,
  apn,
  planName,
  country,
  validityDays,
  dataQuotaMb,
  iccid,
}) {
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
    planName,
    country,
    validityDays,
    dataQuotaMb,
    iccid
    });

  const result = await resend.emails.send({
    from: emailFrom,
    to,
    subject,
    html,
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

async function sendAdminAlertEmail({ subject, html }) {
  const to = (process.env.ALERT_EMAIL_TO || "").trim();
  if (!emailEnabled || !to) {
    console.warn("⚠️ Alert email not sent (missing RESEND config or ALERT_EMAIL_TO).");
    return false;
  }

  const result = await resend.emails.send({
    from: emailFrom,
    to,
    subject,
    html,
  });

  if (result?.error) {
    console.error("❌ Resend alert error:", result.error);
    return false;
  }
  return true;
}

// -----------------------------
// Middleware: JSON + raw body capture (for HMAC)
// -----------------------------
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf; // Buffer (raw bytes)
    },
  })
);

app.get("/", (_req, res) => res.send("Webhook server running :)"));

// -----------------------------
// Small helpers
// -----------------------------
function normId(x) {
  return String(x || "").trim().toLowerCase();
}

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

  const countryIso2 =
    order?.billing_address?.country_code ||
    order?.shipping_address?.country_code ||
    "US";

  return { email, firstName, lastName, countryIso2 };
}

// -----------------------------
// Shopify signature verification
// -----------------------------
function verifyShopifyWebhook(req) {
  const hmacHeader = req.get("X-Shopify-Hmac-Sha256") || "";
  const secret = process.env.WEBHOOK_API_KEY;

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

  if (!orderId) {
    console.warn("⚠️ No order id in payload, exiting.");
    return res.status(200).send("OK");
  }

  // ✅ IDEMPOTENCY (Order metafields)
  try {
    const flag = await getOrderProcessedFlag(orderId);
    if (flag?.processed) {
      console.log("🛑 Order already processed, skipping:", {
        orderId,
        processedAt: flag.processedAt,
      });
      return res.status(200).send("OK");
    }
  } catch (e) {
    console.error("⚠️ Could not read order processed flag:", e?.message || e);
    // Continue anyway
  }

  // We'll mark processed only if the full workflow ends without critical errors
  let shouldMarkProcessed = true;

  // 1) Get or create Maya customer id
  let mayaCustomerId = null;
  const shopifyCustomerId = order?.customer?.id || order?.customer_id || null;
  console.log("Shopify customer id on order:", shopifyCustomerId);

  if (shopifyCustomerId) {
    try {
      const existing = await getMayaCustomerIdFromShopifyCustomer(shopifyCustomerId);
      const existingTrimmed = (existing || "").trim();
      if (existingTrimmed) {
        mayaCustomerId = existingTrimmed;
        console.log("✅ Reusing Maya customer id from Shopify customer metafield:", mayaCustomerId);
      }
    } catch (e) {
      console.error("❌ Could not read Shopify customer metafield:", e.message);
    }
  }

  if (!mayaCustomerId) {
    try {
      const created = await createMayaCustomer({
        email,
        firstName,
        lastName,
        countryIso2,
        tag: String(orderId),
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
          // Not critical for this order
        }
      } else {
        console.warn("⚠️ No Shopify customer on order (guest checkout).");
      }
    } catch (e) {
      console.error("❌ Maya customer creation failed:", e.message);
      shouldMarkProcessed = false;
      return res.status(200).send("OK");
    }
  }

  // 2) Process line items
  const items = order?.line_items || [];
  console.log("🧾 LINE ITEMS:", items.length);

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const variantId = String(item.variant_id);
    const qty = Number(item.quantity || 1);

    let mayaPlanId = null;
    let productType = null;

    try {
      const cfg = await getVariantConfig(variantId);
      mayaPlanId = cfg?.mayaPlanId || null;
      productType = cfg?.productType || null;
    } catch (e) {
      console.error("❌ Failed to fetch config for variant:", variantId, e.message);
      // This item can't be processed reliably
      shouldMarkProcessed = false;
      continue;
    }

    console.log(`Item #${i + 1}:`, {
      title: item.title,
      variant_title: item.variant_title,
      variant_id: variantId,
      quantity: qty,
      maya_plan_id: mayaPlanId,
      product_type: productType,
    });

    if (!mayaPlanId) {
      console.error("❌ Missing metafield custom.maya_plan_id for variant:", variantId);
      shouldMarkProcessed = false;
      continue;
    }

    // -----------------------------
    // RECHARGE (TOP UP)
    // -----------------------------
    if (productType === "recharge") {
      console.log("🔄 Entering TOP-UP flow", { orderId, variantId, qty, mayaPlanId, mayaCustomerId });

      if (!mayaCustomerId) {
        shouldMarkProcessed = false;
        await sendAdminAlertEmail({
          subject: `⚠️ Top-up received but no Maya customer id (Order #${orderId})`,
          html: `
            <p>Order contains a <b>top-up</b>, but we could not resolve a Maya customer id.</p>
            <ul>
              <li><b>Order ID</b>: ${orderId}</li>
              <li><b>Email</b>: ${email || ""}</li>
              <li><b>Variant ID</b>: ${variantId}</li>
              <li><b>Maya plan_type_id</b>: ${mayaPlanId}</li>
            </ul>
            <p>No action was taken. Please contact the customer.</p>
          `,
        });
        continue;
      }

      let mayaDetails = null;
      try {
        mayaDetails = await getMayaCustomerDetails(mayaCustomerId);
      } catch (e) {
        shouldMarkProcessed = false;
        await sendAdminAlertEmail({
          subject: `⚠️ Top-up failed: could not fetch Maya customer (Order #${orderId})`,
          html: `
            <p>Order contains a <b>top-up</b>, but fetching the Maya customer failed.</p>
            <ul>
              <li><b>Order ID</b>: ${orderId}</li>
              <li><b>Email</b>: ${email || ""}</li>
              <li><b>Maya customer id</b>: ${mayaCustomerId}</li>
              <li><b>Variant ID</b>: ${variantId}</li>
              <li><b>Maya plan_type_id</b>: ${mayaPlanId}</li>
              <li><b>Error</b>: ${(e && e.message) || e}</li>
            </ul>
            <p>No action was taken.</p>
          `,
        });
        continue;
      }

      const customer = mayaDetails?.customer;
      const esims = Array.isArray(customer?.esims) ? customer.esims : [];
      console.log("👤 Maya customer loaded", { mayaCustomerId, esims_count: esims.length });

      const candidateEsims = esims.filter((e) => {
        const state = String(e?.state || "").toLowerCase();
        const service = String(e?.service_status || "").toLowerCase();
        if (state.includes("terminated") || state.includes("cancel")) return false;
        if (service.includes("terminated") || service.includes("cancel")) return false;
        return true;
      });

      function isActivated_(plan) {
        const da = String(plan?.date_activated || "");
        return da && da !== "0000-00-00 00:00:00";
      }
      function toInt_(v) {
        const n = Number(v);
        return Number.isFinite(n) ? n : NaN;
      }
      function timeValue_(s) {
        const t = Date.parse(String(s || ""));
        return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
      }

      let best = null;

      for (const e of candidateEsims) {
        const plans = Array.isArray(e?.plans) ? e.plans : [];
        for (const p of plans) {
          const planTypeId = p?.plan_type?.id;
          if (!planTypeId) continue;
          if (normId(planTypeId) !== normId(mayaPlanId)) continue;

          const bytesRemaining = toInt_(p?.data_bytes_remaining);
          const activated = isActivated_(p);

          const candidate = {
            iccid: e?.iccid,
            esimUid: e?.uid,
            planId: p?.id,
            planTypeId,
            bytesRemaining: Number.isFinite(bytesRemaining)
              ? bytesRemaining
              : Number.POSITIVE_INFINITY,
            activated,
            startTime: p?.start_time,
          };

          if (!best) {
            best = candidate;
            continue;
          }

          if (candidate.bytesRemaining < best.bytesRemaining) {
            best = candidate;
            continue;
          }
          if (candidate.bytesRemaining > best.bytesRemaining) continue;

          if (candidate.activated && !best.activated) {
            best = candidate;
            continue;
          }
          if (!candidate.activated && best.activated) continue;

          if (timeValue_(candidate.startTime) < timeValue_(best.startTime)) {
            best = candidate;
            continue;
          }
        }
      }

      if (!best?.iccid) {
        shouldMarkProcessed = false;
        await sendAdminAlertEmail({
          subject: `⚠️ Top-up received but no matching eSIM found (Order #${orderId})`,
          html: `
            <p>Order contains a <b>top-up</b>, but we couldn't find any eSIM with an existing plan matching this plan_type_id.</p>
            <ul>
              <li><b>Order ID</b>: ${orderId}</li>
              <li><b>Email</b>: ${email || ""}</li>
              <li><b>Maya customer id</b>: ${mayaCustomerId}</li>
              <li><b>Variant ID</b>: ${variantId}</li>
              <li><b>Maya plan_type_id</b>: ${mayaPlanId}</li>
            </ul>
            <p>No action was taken. Please contact the customer.</p>
          `,
        });
        continue;
      }

      console.log("🔁 Top-up target chosen:", {
        iccid: best.iccid,
        esim_uid: best.esimUid,
        matched_plan_id: best.planId,
        bytes_remaining: best.bytesRemaining,
        activated: best.activated,
        start_time: best.startTime,
        plan_type_id_from_shopify: mayaPlanId,
        plan_type_id_from_maya: best.planTypeId,
      });

      for (let q = 0; q < qty; q++) {
        const topUpPlanTypeId = best.planTypeId || mayaPlanId;
        try {
          const topupResp = await createMayaTopUp({
            iccid: best.iccid,
            planTypeId: topUpPlanTypeId,
            tag: String(orderId),
          });

          console.log("✅ Maya top-up created:", {
            iccid: best.iccid,
            plan_type_id: topUpPlanTypeId,
            new_plan_id: topupResp?.plan?.id,
            request_id: topupResp?.request_id,
          });
        } catch (e) {
          shouldMarkProcessed = false;
          console.error("❌ Maya top-up error:", e.message);
          await sendAdminAlertEmail({
            subject: `❌ Top-up failed in Maya (Order #${orderId})`,
            html: `
              <p>Creating a Maya top-up failed.</p>
              <ul>
                <li><b>Order ID</b>: ${orderId}</li>
                <li><b>Email</b>: ${email || ""}</li>
                <li><b>Maya customer id</b>: ${mayaCustomerId}</li>
                <li><b>ICCID</b>: ${best.iccid}</li>
                <li><b>plan_type_id</b>: ${topUpPlanTypeId}</li>
                <li><b>Error</b>: ${(e && e.message) || e}</li>
              </ul>
            `,
          });
        }
      }

      continue;
    }

    // -----------------------------
    // NORMAL eSIM purchase: create eSIM(s)
    // -----------------------------
    for (let q = 0; q < qty; q++) {
      try {
        const mayaResp = await createMayaEsim({
          planTypeId: mayaPlanId,
          customerId: mayaCustomerId,
          tag: String(orderId),
        });

        console.log("✅ Maya eSIM created:", {
          maya_customer_id: mayaCustomerId,
          maya_esim_uid: mayaResp?.esim?.uid,
          iccid: mayaResp?.esim?.iccid,
          activation_code: mayaResp?.esim?.activation_code,
          manual_code: mayaResp?.esim?.manual_code,
          smdp_address: mayaResp?.esim?.smdp_address,
          apn: mayaResp?.esim?.apn,
        });

        try {
          await sendEsimEmail({
            to: email,
            firstName,
            orderId,
            activationCode: mayaResp?.esim?.activation_code,
            manualCode: mayaResp?.esim?.manual_code,
            smdpAddress: mayaResp?.esim?.smdp_address,
            apn: mayaResp?.esim?.apn,
            planName: item.variant_title,      // 👈 tu l’as déjà dans Shopify
            iccid: mayaResp?.esim?.iccid,      // 👈 utile pour support
            // optionnel:
            country: item.title,
          });
        } catch (e) {
          // Email failure shouldn't re-run Maya provisioning (but you may want admin alert)
          console.error("❌ Failed to send eSIM email:", e?.message || e);
        }
      } catch (e) {
        shouldMarkProcessed = false;
        console.error("❌ Maya provisioning error:", e.message);
      }
    }
  }

  // ✅ Mark the order processed ONLY if we had no critical errors
  if (shouldMarkProcessed) {
    try {
      await markOrderProcessed(orderId);
      console.log("✅ Order marked as processed in Shopify:", orderId);
    } catch (e) {
      console.error("❌ Failed to mark order as processed:", e?.message || e);
      // Not marking processed means Shopify might retry later (acceptable)
    }
  } else {
    console.warn("⚠️ Not marking order as processed (some steps failed):", orderId);
  }

  return res.status(200).send("OK");
});

// -----------------------------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));