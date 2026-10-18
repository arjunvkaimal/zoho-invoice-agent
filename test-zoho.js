import 'dotenv/config';

const {
  ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN,
  ZOHO_ORG_ID, ZOHO_ACCOUNTS_URL, ZOHO_API_URL,
} = process.env;

// 1. Exchange the refresh token for an access token
const tokenRes = await fetch(`${ZOHO_ACCOUNTS_URL}/oauth/v2/token`, {
  method: 'POST',
  body: new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: ZOHO_CLIENT_ID,
    client_secret: ZOHO_CLIENT_SECRET,
    refresh_token: ZOHO_REFRESH_TOKEN,
  }),
});
const tokenData = await tokenRes.json();
console.log('Token step:', tokenData.access_token ? 'OK' : tokenData);

// 2. Call Zoho Books
for (const path of ['contacts', 'items']) {
  const res = await fetch(`${ZOHO_API_URL}/${path}?organization_id=${ZOHO_ORG_ID}`, {
    headers: { Authorization: `Zoho-oauthtoken ${tokenData.access_token}` },
  });
  const data = await res.json();
  console.log(path, '->', data.code === 0 ? 'OK' : data);
}