// services/maya.js
import { safeFetch } from "../utils/http.js";

export function mayaAuthHeader() {
  const auth = process.env.MAYA_AUTH;
  if (!auth) throw new Error("Missing MAYA_AUTH env var");
  return `Basic ${auth}`;
}

function mayaBaseUrl() {
  return (process.env.MAYA_BASE_URL || "https://api.maya.net").trim();
}

async function parseJsonSafe(resp) {
  return await resp.json().catch(() => ({}));
}

export async function getMayaCustomerDetails(mayaCustomerId) {
  const resp = await safeFetch(`${mayaBaseUrl()}/connectivity/v1/customer/${mayaCustomerId}`, {
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
  const resp = await safeFetch(
    `${mayaBaseUrl()}/connectivity/v1/esim/${iccid}/plan/${planTypeId}`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: mayaAuthHeader(),
      },
      body: JSON.stringify(tag ? { tag } : {}),
    }
  );

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

  const resp = await safeFetch(`${mayaBaseUrl()}/connectivity/v1/customer/`, {
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

  const resp = await safeFetch(`${mayaBaseUrl()}/connectivity/v1/esim`, {
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