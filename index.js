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
  saveEsimToOrder,
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

function esc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatEsimEmailHtml({
  firstName,
  planName,
  country,
  validityDays,
  dataQuotaMb,
  iccid,
  activationCode,
  manualCode,
  smdpAddress,
  apn,
  qrDataUrl,
}) {
  const safeName = (firstName || "").trim() || "there";

  // Optional rows
  const row = (label, value) =>
    value ? `<tr><td style="padding:10px 0;"><b>${label}:</b> ${esc(value)}</td></tr>` : "";

  const codeRow = (label, value) =>
    value
      ? `<tr>
          <td style="padding:10px 0;">
            <b>${label}:</b>
            <code style="background:#F1F5F9; padding:4px 8px; border-radius:6px;">
              ${esc(value)}
            </code>
          </td>
        </tr>`
      : "";

  const apnRow = apn
    ? `<tr><td style="padding:10px 0;"><b>APN:</b> ${esc(apn)}</td></tr>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Your eSIM is ready</title>
</head>

<body style="margin:0; padding:0; background:#F6FAFD; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Arial;">

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="padding: 32px 0;">
    <tr>
      <td align="center">

        <!-- CARD -->
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
          style="width:100%; max-width:800px; background:#FFFFFF; border-radius: 18px; box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08); overflow:hidden;">

          <!-- HEADER -->
          <tr>
            <td style="padding: 20px 24px; border-bottom: 1px solid #E5E7EB;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td>
                    <img 
                      src="https://quebecesim.ca/cdn/shop/files/1000008019.png?v=1737480349&width=600"
                      alt="Québec eSIM"
                      width="80"
                      style="display:block; max-width:140px; height:auto;"
                    />
                  </td>
                  <td align="right">
                    <span style="display:inline-block; padding:8px 12px; border-radius:999px; background:#0CA3EC; color:#FFFFFF; font-weight:600; font-size:12px;">
                      eSIM
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- MAIN CONTENT -->
          <tr>
            <td style="padding: 28px 24px;">

              <h1 style="margin: 0 0 16px; font-size: 22px; color:#0F172A;">
                Your eSIM is ready!
              </h1>

              <p style="font-size: 15px; color:#334155; margin: 0 0 20px;">
                Hi <b>${esc(safeName)}</b>,
              </p>

              <p style="font-size: 15px; color:#334155; margin: 0 0 28px;">
                Your eSIM for <b style="color:#0CA3EC;">${esc(planName || "your plan")}</b> is now ready.
                Scan the QR code attached to install it on your device.
              </p>

              <div style="height: 16px;"></div>

              <h2 style="font-size: 16px; color:#0F172A; margin: 0 0 12px;">Plan details</h2>

              <!-- PLAN DETAILS BOX -->
              <table width="100%" cellpadding="0" cellspacing="0" border="0"
                style="background:#FFFFFF; border: 1px solid #E5E7EB; border-radius: 14px; padding: 18px; margin-bottom: 28px;">
                ${row("Plan", planName)}
                ${row("Destination", country)}
                ${row("Validity", validityDays ? `${validityDays} days` : "")}
                ${row("Data", dataQuotaMb ? `${dataQuotaMb} MB` : "")}
                ${codeRow("ICCID", iccid)}
              </table>

              <div style="text-align:center; margin: 20px 0 28px;">
                <img 
                    src="${qrDataUrl}"
                    alt="Scan to install eSIM"
                    width="180"
                    style="border-radius:12px; border:1px solid #E5E7EB;"
                />
                <p style="font-size:12px; color:#64748B; margin-top:8px;">
                    Scan this QR code to install your eSIM
                </p>
                </div>

              <!-- TIP BOX -->
              <table width="100%" cellpadding="0" cellspacing="0" border="0"
                style="background:#F8FAFC; border: 1px solid #E5E7EB; border-radius: 14px; padding: 18px; margin: 12px 0 28px;">
                <tr>
                  <td style="font-size: 13px; color:#475569;">
                    <b>Tip:</b> If you’re using the same phone, open this email on another device to scan the QR code.
                  </td>
                </tr>
              </table>

              <!-- ACTIVATION DETAILS BOX -->
              <table width="100%" cellpadding="0" cellspacing="0" border="0"
                style="background:#FFFFFF; border: 1px solid #E5E7EB; border-radius: 14px; padding: 18px;">
                ${codeRow("Activation code", activationCode)}
                ${codeRow("Manual code", manualCode)}
                ${codeRow("SM-DP+ address", smdpAddress)}
                ${apnRow}
              </table>

            </td>
          </tr>

          <!-- FOOTER -->
          <tr>
            <td style="padding: 18px 24px; background:#F8FAFC; border-top: 1px solid #E5E7EB; font-size: 12px; color:#64748B;">
              <b>Need help?</b>
              <a href="https://quebecesim.ca/pages/contactez-nous" style="text-decoration:none; color: rgb(94, 94, 94);">
                Contactez-nous
              </a><br/>
              © 2026 Québec E-Sim • Powered by Maya
            </td>
          </tr>

        </table>
        <!-- END CARD -->

      </td>
    </tr>
  </table>

</body>
</html>`;
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
  const qrDataUrl = `data:image/png;base64,${qrBase64}`;

  const subject = orderId
    ? `Your eSIM QR code (Order #${orderId})`
    : "Your eSIM QR code";

const html = formatEsimEmailHtml({
  firstName,
  planName,
  country,
  validityDays,
  dataQuotaMb,
  iccid,
  activationCode,
  manualCode,
  smdpAddress,
  apn,
  qrDataUrl,
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
// CRON (protected endpoint)
// -----------------------------
app.get("/cron/check-usage", async (req, res) => {
  const secret = (process.env.CRON_SECRET || "").trim();
  const token = String(req.query.token || "").trim();

  if (!secret) {
    console.error("❌ Missing CRON_SECRET env var");
    return res.status(500).send("Server not configured");
  }

  if (!token || token !== secret) {
    return res.status(401).send("Unauthorized");
  }

  console.log("🕒 CRON check-usage triggered:", new Date().toISOString());

  // TODO: later we'll run the real usage-check logic here
  return res.status(200).send("OK (cron stub)");
});
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
            await saveEsimToOrder(orderId, {
                iccid: mayaResp?.esim?.iccid,
                esimUid: mayaResp?.esim?.uid,
            });
            console.log("✅ Saved eSIM info to Shopify order:", {
                orderId,
                iccid: mayaResp?.esim?.iccid,
                esimUid: mayaResp?.esim?.uid,
            });
            } catch (e) {
            console.error("❌ Failed to save eSIM info to Shopify order:", e?.message || e);
            shouldMarkProcessed = false;
            // Pas “critique” si tu veux, mais pour l’alerte 75% ça devient important
            }

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