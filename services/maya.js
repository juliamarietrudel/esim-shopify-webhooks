// services/maya.js
import { safeFetch } from "../utils/http.js";

export function mayaAuthHeader() {
  const auth = process.env.MAYA_AUTH;
  if (!auth) throw new Error("Missing MAYA_AUTH env var");
  return `Basic ${auth}`;
}

// ✅ READ: eSIM details by ICCID (for usage checks)
export async function getMayaEsimDetailsByIccid(iccid) {
  const iccidStr = String(iccid || "").trim();
  if (!iccidStr) throw new Error("getMayaEsimDetailsByIccid: missing iccid");

  const url = `${mayaBaseUrl()}/connectivity/v1/esim/${encodeURIComponent(iccidStr)}`;
  console.log("🌐 Maya GET eSIM URL:", url);

  const resp = await safeFetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: mayaAuthHeader(),
    },
  });

  const data = await parseJsonSafe(resp);

  if (!resp.ok) {
    console.error("❌ Maya get eSIM failed:", resp.status, data);
    throw new Error(`Maya get eSIM failed (${resp.status})`);
  }

  // Maya usually returns { esim: {...} }
  return data?.esim || null;
}

function mayaBaseUrl() {
  const base = (process.env.MAYA_BASE_URL || "https://api.maya.net").trim();
  // Debug: confirm which Maya host is being used in the running environment
  console.log("🌐 MAYA_BASE_URL =", base);
  return base;
}

async function parseJsonSafe(resp) {
  return await resp.json().catch(() => ({}));
}

export async function getMayaCustomerDetails(mayaCustomerId) {
  const url = `${mayaBaseUrl()}/connectivity/v1/customer/${mayaCustomerId}`;
  console.log("🌐 Maya GET customer URL:", url);

  const resp = await safeFetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: mayaAuthHeader(),
    },
  });

  const data = await parseJsonSafe(resp);

  if (!resp.ok) {
    console.error("❌ Maya get customer failed:", resp.status, data);
    throw new Error(`Maya get customer failed (${resp.status})`);
  }

  return data;
}

export async function createMayaTopUp({ iccid, planTypeId, tag = "" }) {
  const url = `${mayaBaseUrl()}/connectivity/v1/esim/${iccid}/plan/${planTypeId}`;
  console.log("🌐 Maya POST top-up URL:", url);

  const resp = await safeFetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: mayaAuthHeader(),
    },
    body: JSON.stringify(tag ? { tag } : {}),
  });

  const data = await parseJsonSafe(resp);

  if (!resp.ok) {
    console.error("❌ Maya top-up failed:", resp.status, data);
    throw new Error(`Maya top-up failed (${resp.status})`);
  }

  return data;
}

export async function createMayaCustomer({ email, firstName, lastName, countryIso2, tag = "" }) {
  const body = {
    email,
    first_name: firstName || "",
    last_name: lastName || "",
    country: countryIso2 || "US",
    ...(tag ? { tag } : {}),
  };

  const url = `${mayaBaseUrl()}/connectivity/v1/customer/`;
  console.log("🌐 Maya POST create customer URL:", url);

  const resp = await safeFetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: mayaAuthHeader(),
    },
    body: JSON.stringify(body),
  });

  const data = await parseJsonSafe(resp);

  if (!resp.ok) {
    console.error("❌ Maya create customer failed:", resp.status, data);
    throw new Error(`Maya create customer failed (${resp.status})`);
  }

  const customerId = data?.customer?.id || data?.customer?.uid || data?.id || null;
  if (!customerId) {
    console.error("❌ Maya customer created but no id returned:", data);
    throw new Error("Maya customer created but no customer id returned");
  }

  return { raw: data, customerId };
}

export async function createMayaEsim({ planTypeId, customerId, tag = "" }) {
  const body = {
    plan_type_id: planTypeId,
    customer_id: customerId,
    ...(tag ? { tag } : {}),
  };

  const url = `${mayaBaseUrl()}/connectivity/v1/esim`;
  console.log("🌐 Maya POST create eSIM URL:", url);

  const resp = await safeFetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: mayaAuthHeader(),
    },
    body: JSON.stringify(body),
  });

  const data = await parseJsonSafe(resp);

  if (!resp.ok) {
    console.error("❌ Maya create eSIM failed:", resp.status, data);
    throw new Error(`Maya create eSIM failed (${resp.status})`);
  }

  return data;
}
