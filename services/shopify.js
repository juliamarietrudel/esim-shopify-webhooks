// services/shopify.js
import { safeFetch } from "../utils/http.js";

export function shopifyGraphqlUrl() {
  const shopRaw = process.env.SHOPIFY_SHOP_DOMAIN;
  const versionRaw = process.env.SHOPIFY_API_VERSION || "2025-01";

  const shop = (shopRaw || "").trim();
  const version = (versionRaw || "").trim();

  if (!shop) throw new Error("Missing SHOPIFY_SHOP_DOMAIN env var");
  if (!version) throw new Error("Missing SHOPIFY_API_VERSION env var");

  return `https://${shop}/admin/api/${version}/graphql.json`;
}

function shopifyToken() {
  const token = process.env.API_ACCESS_TOKEN;
  if (!token) throw new Error("Missing API_ACCESS_TOKEN env var");
  return token;
}

async function parseJsonSafe(resp) {
  return await resp.json().catch(() => ({}));
}

// ---------- Variant config ----------
export async function getVariantConfig(variantId) {
  const url = shopifyGraphqlUrl();
  const token = shopifyToken();

  const gid = `gid://shopify/ProductVariant/${variantId}`;

  const query = `
    query ($id: ID!) {
      productVariant(id: $id) {
        id
        mayaPlanId: metafield(namespace: "custom", key: "maya_plan_id") { value }
        productType: metafield(namespace: "custom", key: "type_de_produit") { value }
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

  const json = await parseJsonSafe(resp);

  if (!resp.ok || json.errors) {
    console.error("❌ Shopify GraphQL error:", json.errors || json);
    throw new Error(`Shopify GraphQL failed (${resp.status})`);
  }

  const v = json?.data?.productVariant;
  const mayaPlanId = (v?.mayaPlanId?.value || "").trim() || null;
  const productType = (v?.productType?.value || "").trim().toLowerCase() || null;

  return { mayaPlanId, productType };
}

// ---------- Customer Maya ID metafield ----------
export async function getMayaCustomerIdFromShopifyCustomer(shopifyCustomerId) {
  const url = shopifyGraphqlUrl();
  const token = shopifyToken();

  const gid = `gid://shopify/Customer/${shopifyCustomerId}`;

  const query = `
    query ($id: ID!) {
      customer(id: $id) {
        metafield(namespace: "custom", key: "maya_customer_id") { value }
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

  const json = await parseJsonSafe(resp);

  if (!resp.ok || json.errors) {
    console.error("❌ Shopify customer metafield read error:", json.errors || json);
    throw new Error(`Shopify GraphQL failed (${resp.status})`);
  }

  return json?.data?.customer?.metafield?.value || null;
}

export async function saveMayaCustomerIdToShopifyCustomer(shopifyCustomerId, mayaCustomerId) {
  const url = shopifyGraphqlUrl();
  const token = shopifyToken();

  const gid = `gid://shopify/Customer/${shopifyCustomerId}`;

  const mutation = `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
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

  const json = await parseJsonSafe(resp);

  const userErrors = json?.data?.metafieldsSet?.userErrors || [];
  if (!resp.ok || json.errors || userErrors.length) {
    console.error("❌ Shopify metafield write error:", { status: resp.status, json, userErrors });
    throw new Error(userErrors[0]?.message || "Failed to write Shopify customer metafield");
  }

  return true;
}

// --- IDEMPOTENCY SUR ORDER (tes fonctions, je les garde) ---
export async function getOrderProcessedFlag(orderId) {
  const url = shopifyGraphqlUrl();
  const token = shopifyToken();

  const gid = `gid://shopify/Order/${orderId}`;

  const query = `
    query ($id: ID!) {
      order(id: $id) {
        processed: metafield(namespace: "custom", key: "maya_processed") { value }
        processedAt: metafield(namespace: "custom", key: "maya_processed_at") { value }
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

  const json = await parseJsonSafe(resp);

  const processed =
    String(json?.data?.order?.processed?.value || "").trim().toLowerCase() === "true";

  return {
    processed,
    processedAt: json?.data?.order?.processedAt?.value || null,
  };
}

export async function markOrderProcessed(orderId) {
  const url = shopifyGraphqlUrl();
  const token = shopifyToken();

  const gid = `gid://shopify/Order/${orderId}`;
  const nowIso = new Date().toISOString();

  const mutation = `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
  `;

  const variables = {
    metafields: [
      {
        ownerId: gid,
        namespace: "custom",
        key: "maya_processed",
        type: "single_line_text_field",
        value: "true",
      },
      {
        ownerId: gid,
        namespace: "custom",
        key: "maya_processed_at",
        type: "single_line_text_field",
        value: nowIso,
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

  const json = await parseJsonSafe(resp);
  if (!resp.ok || json.errors) {
    console.error("❌ Shopify markOrderProcessed error:", json.errors || json);
    throw new Error(`Shopify GraphQL failed (${resp.status})`);
  }

  return true;
}